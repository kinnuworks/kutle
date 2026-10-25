// SPDX-License-Identifier: MIT
pragma solidity 0.8.30;

import {AccessControl} from "@openzeppelin/contracts/access/AccessControl.sol";
import {Elements} from "./libraries/Elements.sol";
import {DeviceRegistry} from "./DeviceRegistry.sol";
import {ModelRegistry} from "./ModelRegistry.sol";

interface IReadingLog {
    struct Batch {
        bytes32 deviceId;
        uint256 passportId;
        bytes32 root;
        uint64 fromTs;
        uint64 toTs;
        uint32 count;
        uint32 keyVersion;
        uint64 anchoredAt;
    }

    function batch(bytes32 batchId) external view returns (Batch memory);
}

interface ILedgerTaint {
    function taint(uint256 batchId, uint256 passportId) external;
}

/// @title PassportRegistry
/// @notice On-chain core of the EU battery passport (Regulation (EU) 2023/1542,
///         Art. 77). The full record follows the Battery Pass data model
///         (DIN DKE SPEC 99100) and lives off chain; its hash is stored here with
///         the numbers other contracts must enforce: metal content, recycled
///         content, health grades, lifecycle status and lineage.
///
///         Lifecycle: ACTIVE -> REPURPOSED (a child passport takes over) or
///         ACTIVE -> RECYCLED (closed at a recycler). Any state -> REVOKED by a
///         market-surveillance authority, which cascades down the lineage and
///         freezes recycler output that depended on the revoked battery.
contract PassportRegistry is AccessControl {
    using Elements for uint8;

    bytes32 public constant MANUFACTURER_ROLE = keccak256("MANUFACTURER_ROLE");
    bytes32 public constant GRADER_ROLE = keccak256("GRADER_ROLE");
    bytes32 public constant REPURPOSER_ROLE = keccak256("REPURPOSER_ROLE");
    bytes32 public constant AUTHORITY_ROLE = keccak256("AUTHORITY_ROLE");
    bytes32 public constant LEDGER_ROLE = keccak256("LEDGER_ROLE");
    bytes32 public constant NOTEPOOL_ROLE = keccak256("NOTEPOOL_ROLE");

    // ------------------------------------------------------------- categories

    uint8 public constant CAT_EV = 1;
    uint8 public constant CAT_LMT = 2;
    uint8 public constant CAT_INDUSTRIAL = 3;
    /// A portable pack used to demonstrate the pipeline on real hardware.
    /// Portable batteries are outside the passport mandate; the label says so.
    uint8 public constant CAT_DEMO = 9;

    // ----------------------------------------------------------------- status

    uint8 public constant ACTIVE = 1;
    uint8 public constant REPURPOSED = 2;
    uint8 public constant RECYCLED = 3;
    uint8 public constant REVOKED = 4;

    // ----------------------------------------------------------------- grades

    uint8 public constant GRADE_REUSE = 1;
    uint8 public constant GRADE_REPURPOSE = 2;
    uint8 public constant GRADE_BENCH_TEST = 3;
    uint8 public constant GRADE_RECYCLE = 4;

    /// Lower interval bound at or above 80% state of health: fit for reuse.
    uint16 public constant REUSE_FLOOR_BPS = 8_000;
    /// Lower bound at or above 60%: fit for stationary second life.
    uint16 public constant REPURPOSE_FLOOR_BPS = 6_000;
    /// Intervals wider than 10 points are too uncertain to act on.
    uint16 public constant MAX_INTERVAL_BPS = 1_000;
    /// A grade older than this cannot authorise a repurposing.
    uint64 public constant GRADE_TTL = 90 days;
    uint256 public constant MAX_LINEAGE = 16;

    // ------------------------------------------------- avoided-emission factors

    /// Cradle-to-gate emissions of new Li-ion cell production, 58-92 kg CO2e per
    /// kWh (Fraunhofer ISI). kg/kWh equals g/Wh, so these multiply Wh directly.
    uint32 public constant MFG_G_PER_WH_LOW = 58;
    uint32 public constant MFG_G_PER_WH_HIGH = 92;
    /// Share of the first-life manufacturing burden a second life relieves under
    /// energy allocation, 15-29% (Chalmers LCA of second-life Li-ion batteries).
    uint16 public constant ALLOC_LOW_BPS = 1_500;
    uint16 public constant ALLOC_HIGH_BPS = 2_900;

    struct Passport {
        address operator;
        bytes32 deviceId;
        uint8 category;
        uint8 status;
        bool recycledLocked;
        uint64 issuedAt;
        uint256 parentId;
        uint256 childId;
        uint32 massGrams;
        uint32 capacityWh;
        uint64[4] composition; // grams of Co, Li, Ni, Pb in the battery
        uint64[4] recycled; // grams of that content backed by spent recycled-metal notes
        bytes32 dataHash; // sha256 of the full Battery Pass record (JSON)
        bytes32 gs1Hash; // keccak256 of the GS1 Digital Link identifier
        uint256 recyclerBatch; // set when closed at a recycler
        string uri;
    }

    struct Health {
        bytes32 readingBatch;
        bytes32 modelId;
        uint16 sohBps;
        uint16 lowBps;
        uint16 highBps;
        uint32 rulCycles;
        uint8 grade;
        uint64 at;
    }

    DeviceRegistry public immutable deviceRegistry;
    ModelRegistry public immutable modelRegistry;
    IReadingLog public readingLog;
    ILedgerTaint public ledger;

    uint256 public passportCount;
    mapping(uint256 => Passport) private _passports;
    mapping(uint256 => Health) private _health;
    mapping(bytes32 => uint256) public passportOfDevice;
    mapping(bytes32 => uint256) public passportOfGs1;

    uint256 public avoidedGramsLow; // running totals over every second life
    uint256 public avoidedGramsHigh;
    uint256 public avoidedGramsAllocLow;
    uint256 public avoidedGramsAllocHigh;

    event Issued(uint256 indexed passportId, address indexed operator, bytes32 indexed deviceId, uint8 category, bytes32 dataHash, bytes32 gs1Hash, string uri);
    event HealthRecorded(uint256 indexed passportId, bytes32 indexed modelId, bytes32 readingBatch, uint16 sohBps, uint16 lowBps, uint16 highBps, uint32 rulCycles, uint8 grade);
    event Repurposed(uint256 indexed parentId, uint256 indexed childId, address indexed newOperator, uint32 retainedWh, uint256 avoidedLow, uint256 avoidedHigh, uint256 allocLow, uint256 allocHigh);
    event ClosedAtRecycler(uint256 indexed passportId, uint256 indexed batchId);
    event RecycledContentAdded(uint256 indexed passportId, uint8 indexed element, uint64 grams, uint64 totalGrams);
    event RecycledContentLocked(uint256 indexed passportId);
    event Revoked(uint256 indexed passportId, uint256 indexed rootId, bytes32 reason);
    event WiringSet(address readingLog, address ledger);

    error NotActive(uint256 passportId);
    error UnknownPassport();
    error NotOperator();
    error DeviceNotOperated();
    error DeviceInUse();
    error Gs1InUse();
    error BadCategory();
    error BatchNotForPassport();
    error ModelInactive();
    error BadInterval();
    error GradeStale();
    error GradeDoesNotAllow(uint8 grade);
    error ExceedsComposition(uint8 element);
    error RecycledLocked();
    error NotOriginal();
    error AlreadyRevoked();
    error AlreadyWired();
    error ZeroAddress();

    constructor(address admin, DeviceRegistry deviceRegistry_, ModelRegistry modelRegistry_) {
        if (admin == address(0)) revert ZeroAddress();
        _grantRole(DEFAULT_ADMIN_ROLE, admin);
        deviceRegistry = deviceRegistry_;
        modelRegistry = modelRegistry_;
    }

    /// @notice One-time wiring of the contracts deployed after this one.
    function wire(IReadingLog readingLog_, ILedgerTaint ledger_) external onlyRole(DEFAULT_ADMIN_ROLE) {
        if (address(readingLog) != address(0)) revert AlreadyWired();
        if (address(readingLog_) == address(0) || address(ledger_) == address(0)) revert ZeroAddress();
        readingLog = readingLog_;
        ledger = ledger_;
        emit WiringSet(address(readingLog_), address(ledger_));
    }

    // ------------------------------------------------------------------ issue

    struct IssueParams {
        bytes32 deviceId;
        uint8 category;
        uint32 massGrams;
        uint32 capacityWh;
        uint64[4] composition;
        bytes32 dataHash;
        bytes32 gs1Hash;
        string uri;
    }

    function issue(IssueParams calldata p) external onlyRole(MANUFACTURER_ROLE) returns (uint256 id) {
        if (p.category != CAT_EV && p.category != CAT_LMT && p.category != CAT_INDUSTRIAL && p.category != CAT_DEMO) {
            revert BadCategory();
        }
        if (deviceRegistry.operatorOf(p.deviceId) != msg.sender) revert DeviceNotOperated();
        if (passportOfDevice[p.deviceId] != 0) revert DeviceInUse();
        if (passportOfGs1[p.gs1Hash] != 0) revert Gs1InUse();
        id = ++passportCount;
        Passport storage s = _passports[id];
        s.operator = msg.sender;
        s.deviceId = p.deviceId;
        s.category = p.category;
        s.status = ACTIVE;
        s.issuedAt = uint64(block.timestamp);
        s.massGrams = p.massGrams;
        s.capacityWh = p.capacityWh;
        s.composition = p.composition;
        s.dataHash = p.dataHash;
        s.gs1Hash = p.gs1Hash;
        s.uri = p.uri;
        passportOfDevice[p.deviceId] = id;
        passportOfGs1[p.gs1Hash] = id;
        emit Issued(id, msg.sender, p.deviceId, p.category, p.dataHash, p.gs1Hash, p.uri);
    }

    // ----------------------------------------------------------------- health

    /// @notice Record a health estimate. The grade is computed here from the
    ///         interval, not taken from the grader, and the estimate must cite an
    ///         anchored reading batch from this passport's own device.
    function recordHealth(
        uint256 passportId,
        bytes32 readingBatch,
        bytes32 modelId,
        uint16 sohBps,
        uint16 lowBps,
        uint16 highBps,
        uint32 rulCycles
    ) external onlyRole(GRADER_ROLE) returns (uint8 grade) {
        Passport storage s = _active(passportId);
        IReadingLog.Batch memory b = readingLog.batch(readingBatch);
        if (b.passportId != passportId || b.deviceId != s.deviceId) revert BatchNotForPassport();
        if (!modelRegistry.isActive(modelId)) revert ModelInactive();
        if (lowBps > sohBps || sohBps > highBps || highBps > 12_000) revert BadInterval();
        grade = gradeFor(lowBps, highBps);
        _health[passportId] =
            Health(readingBatch, modelId, sohBps, lowBps, highBps, rulCycles, grade, uint64(block.timestamp));
        emit HealthRecorded(passportId, modelId, readingBatch, sohBps, lowBps, highBps, rulCycles, grade);
    }

    /// @notice The grading rule, public so anyone can check a grade.
    function gradeFor(uint16 lowBps, uint16 highBps) public pure returns (uint8) {
        if (highBps < REPURPOSE_FLOOR_BPS) return GRADE_RECYCLE;
        if (highBps - lowBps > MAX_INTERVAL_BPS) return GRADE_BENCH_TEST;
        if (lowBps >= REUSE_FLOOR_BPS) return GRADE_REUSE;
        if (lowBps >= REPURPOSE_FLOOR_BPS) return GRADE_REPURPOSE;
        return GRADE_BENCH_TEST;
    }

    // ------------------------------------------------------------- second life

    /// @notice Hand a pack over for a second life. Requires a fresh grade that
    ///         allows it. The child passport inherits the cells' metal content and
    ///         recycled content, and links back to the parent (Art. 77(6)).
    function repurpose(
        uint256 parentId,
        address newOperator,
        bytes32 newDeviceId,
        uint8 newCategory,
        uint32 newCapacityWh,
        bytes32 dataHash,
        bytes32 gs1Hash,
        string calldata uri
    ) external onlyRole(REPURPOSER_ROLE) returns (uint256 childId) {
        Passport storage parent = _active(parentId);
        Health storage h = _health[parentId];
        if (h.at == 0 || block.timestamp > h.at + GRADE_TTL) revert GradeStale();
        if (h.grade != GRADE_REUSE && h.grade != GRADE_REPURPOSE) revert GradeDoesNotAllow(h.grade);
        if (newCategory != CAT_INDUSTRIAL && newCategory != CAT_LMT && newCategory != CAT_EV && newCategory != CAT_DEMO) {
            revert BadCategory();
        }
        if (newOperator == address(0)) revert ZeroAddress();
        if (passportOfGs1[gs1Hash] != 0) revert Gs1InUse();
        // The same gauge may stay with the pack; a new one must belong to the new operator.
        if (newDeviceId != parent.deviceId) {
            if (deviceRegistry.operatorOf(newDeviceId) != newOperator) revert DeviceNotOperated();
            if (passportOfDevice[newDeviceId] != 0) revert DeviceInUse();
        }

        childId = ++passportCount;
        Passport storage c = _passports[childId];
        c.operator = newOperator;
        c.deviceId = newDeviceId;
        c.category = newCategory;
        c.status = ACTIVE;
        c.recycledLocked = true;
        c.issuedAt = uint64(block.timestamp);
        c.parentId = parentId;
        c.massGrams = parent.massGrams;
        c.capacityWh = newCapacityWh;
        c.composition = parent.composition;
        c.recycled = parent.recycled;
        c.dataHash = dataHash;
        c.gs1Hash = gs1Hash;
        c.uri = uri;

        parent.status = REPURPOSED;
        parent.childId = childId;
        passportOfDevice[newDeviceId] = childId;
        passportOfGs1[gs1Hash] = childId;

        // Manufacturing a new battery of the retained capacity is what this avoids.
        uint32 retainedWh = uint32((uint256(parent.capacityWh) * h.lowBps) / Elements.BPS);
        uint256 lo = uint256(retainedWh) * MFG_G_PER_WH_LOW;
        uint256 hi = uint256(retainedWh) * MFG_G_PER_WH_HIGH;
        uint256 aLo = (lo * ALLOC_LOW_BPS) / Elements.BPS;
        uint256 aHi = (hi * ALLOC_HIGH_BPS) / Elements.BPS;
        avoidedGramsLow += lo;
        avoidedGramsHigh += hi;
        avoidedGramsAllocLow += aLo;
        avoidedGramsAllocHigh += aHi;

        emit Issued(childId, newOperator, newDeviceId, newCategory, dataHash, gs1Hash, uri);
        emit Repurposed(parentId, childId, newOperator, retainedWh, lo, hi, aLo, aHi);
    }

    // ---------------------------------------------------------------- recycling

    /// @notice Close a passport at a recycler's intake. One-way: a closed passport
    ///         can never feed a second batch. Returns its metal content.
    function closeAtRecycler(uint256 passportId, uint256 batchId)
        external
        onlyRole(LEDGER_ROLE)
        returns (uint64[4] memory composition)
    {
        Passport storage s = _active(passportId);
        s.status = RECYCLED;
        s.recyclerBatch = batchId;
        passportOfDevice[s.deviceId] = 0;
        emit ClosedAtRecycler(passportId, batchId);
        return s.composition;
    }

    /// @notice Back part of a new battery's metal with spent recycled-metal notes.
    ///         Only for an original passport whose operator has not locked it.
    function addRecycledContent(uint256 passportId, uint8 element, uint64 grams) external onlyRole(NOTEPOOL_ROLE) {
        element.check();
        Passport storage s = _active(passportId);
        if (s.parentId != 0) revert NotOriginal();
        if (s.recycledLocked) revert RecycledLocked();
        uint64 total = s.recycled[element] + grams;
        if (total > s.composition[element]) revert ExceedsComposition(element);
        s.recycled[element] = total;
        emit RecycledContentAdded(passportId, element, grams, total);
    }

    function lockRecycledContent(uint256 passportId) external {
        Passport storage s = _active(passportId);
        if (msg.sender != s.operator) revert NotOperator();
        s.recycledLocked = true;
        emit RecycledContentLocked(passportId);
    }

    // ---------------------------------------------------------------- revocation

    /// @notice Revoke a passport and every descendant. If a revoked battery was
    ///         recycled, the recycler batch it fed is tainted, which freezes any
    ///         recycled metal from that batch not yet handed out.
    function revoke(uint256 passportId, bytes32 reason) external onlyRole(AUTHORITY_ROLE) {
        Passport storage root = _passports[passportId];
        if (root.status == 0) revert UnknownPassport();
        if (root.status == REVOKED) revert AlreadyRevoked();
        uint256 id = passportId;
        for (uint256 depth; id != 0 && depth < MAX_LINEAGE; ++depth) {
            Passport storage s = _passports[id];
            if (s.status == REVOKED) break;
            if (s.status == RECYCLED) ledger.taint(s.recyclerBatch, id);
            if (s.status == ACTIVE && passportOfDevice[s.deviceId] == id) passportOfDevice[s.deviceId] = 0;
            s.status = REVOKED;
            emit Revoked(id, passportId, reason);
            id = s.childId;
        }
    }

    // ----------------------------------------------------------------- views

    function passport(uint256 passportId) external view returns (Passport memory) {
        return _passports[passportId];
    }

    function health(uint256 passportId) external view returns (Health memory) {
        return _health[passportId];
    }

    function operatorOf(uint256 passportId) external view returns (address) {
        return _passports[passportId].operator;
    }

    /// @notice The device whose readings count for this passport, or zero unless
    ///         the passport is active. ReadingLog relies on that zero.
    function deviceOf(uint256 passportId) external view returns (bytes32) {
        Passport storage s = _passports[passportId];
        return s.status == ACTIVE ? s.deviceId : bytes32(0);
    }

    function statusOf(uint256 passportId) external view returns (uint8) {
        return _passports[passportId].status;
    }

    function recycledShareBps(uint256 passportId, uint8 element) public view returns (uint256) {
        element.check();
        Passport storage s = _passports[passportId];
        uint64 c = s.composition[element];
        return c == 0 ? 0 : (uint256(s.recycled[element]) * Elements.BPS) / c;
    }

    /// @notice Whether recycled content meets the Article 8 minimum for an element.
    ///         An element the battery does not contain is trivially compliant.
    function meetsMinimum(uint256 passportId, uint8 element, bool year2036) external view returns (bool) {
        if (_passports[passportId].composition[element] == 0) return true;
        uint16 min = year2036 ? element.minRecycledShare2036Bps() : element.minRecycledShare2031Bps();
        return recycledShareBps(passportId, element) >= min;
    }

    function _active(uint256 passportId) private view returns (Passport storage s) {
        s = _passports[passportId];
        if (s.status != ACTIVE) revert NotActive(passportId);
    }
}
