// SPDX-License-Identifier: MIT
pragma solidity 0.8.30;

import {CommonBase} from "forge-std/Base.sol";
import {StdCheats} from "forge-std/StdCheats.sol";
import {StdUtils} from "forge-std/StdUtils.sol";
import {LedgerFixture} from "../ConservationLedger.t.sol";
import {ConservationLedger} from "../../src/ConservationLedger.sol";
import {PassportRegistry} from "../../src/PassportRegistry.sol";
import {DeviceRegistry} from "../../src/DeviceRegistry.sol";
import {NotePool} from "../../src/NotePool.sol";
import {Elements} from "../../src/libraries/Elements.sol";

/// Drives the ledger with random, often dishonest, actions.
contract LedgerHandler is CommonBase, StdCheats, StdUtils {
    ConservationLedger internal ledger;
    PassportRegistry internal passports;
    DeviceRegistry internal devices;
    NotePool internal pool;
    address internal manufacturer;
    address internal recycler;
    uint256 internal recyclerKey;
    address internal lab;
    uint256 internal labKey;
    address internal authority;

    uint256[] public batches;
    uint256[] public intaken;
    mapping(uint256 => uint256) public intakeCount;
    mapping(uint256 => uint256) public batchOfPassport;
    mapping(uint256 => uint64[4]) public issuedAtTaint;
    mapping(uint256 => bool) public taintSeen;
    uint256 public mintedGramsTotal;
    uint256 public mintedNotes;
    uint256 public rejectedAssays;
    uint256 public assayAttempts;
    uint256 public assaySuccesses;
    uint256 internal nonce;

    constructor(
        ConservationLedger ledger_,
        PassportRegistry passports_,
        DeviceRegistry devices_,
        NotePool pool_,
        address manufacturer_,
        uint256 recyclerKey_,
        uint256 labKey_,
        address authority_
    ) {
        ledger = ledger_;
        passports = passports_;
        devices = devices_;
        pool = pool_;
        manufacturer = manufacturer_;
        recyclerKey = recyclerKey_;
        recycler = vm.addr(recyclerKey_);
        labKey = labKey_;
        lab = vm.addr(labKey_);
        authority = authority_;
    }

    function batchCount() external view returns (uint256) {
        return batches.length;
    }

    function intakenCount() external view returns (uint256) {
        return intaken.length;
    }

    // ---------------------------------------------------------------- actions

    function feed(uint64 co, uint64 li, uint64 ni, uint64 pb, bool newBatch) external {
        uint64[4] memory c = [uint64(bound(co, 0, 1e7)), uint64(bound(li, 0, 1e7)), uint64(bound(ni, 0, 1e7)), uint64(bound(pb, 0, 1e7))];
        bytes32 deviceId = keccak256(abi.encode("inv-device", ++nonce));
        vm.mockCall(address(devices), abi.encodeCall(DeviceRegistry.operatorOf, (deviceId)), abi.encode(manufacturer));
        vm.prank(manufacturer);
        uint256 pid = passports.issue(
            PassportRegistry.IssueParams(deviceId, 1, 1, 1, c, bytes32(nonce), keccak256(abi.encode("gs1", nonce)), "")
        );

        uint256 batchId;
        if (newBatch || batches.length == 0 || ledger.batch(batches[batches.length - 1]).assayCount != 0) {
            vm.prank(recycler);
            batchId = ledger.openBatch();
            batches.push(batchId);
        } else {
            batchId = batches[batches.length - 1];
        }
        uint256[] memory ids = new uint256[](1);
        ids[0] = pid;
        vm.prank(recycler);
        try ledger.intake(batchId, ids) {
            intaken.push(pid);
            intakeCount[pid] += 1;
            batchOfPassport[pid] = batchId;
        } catch {}
    }

    /// Try to feed an already-closed battery into another batch.
    function refeed(uint256 which) external {
        if (intaken.length == 0) return;
        uint256 pid = intaken[bound(which, 0, intaken.length - 1)];
        vm.prank(recycler);
        uint256 batchId = ledger.openBatch();
        batches.push(batchId);
        uint256[] memory ids = new uint256[](1);
        ids[0] = pid;
        vm.prank(recycler);
        try ledger.intake(batchId, ids) {
            intakeCount[pid] += 1; // must never happen; the invariant catches it
        } catch {}
    }

    /// An assay with random proportions. recoveryBps up to 10,500 so some claims
    /// break the ceiling, and `skew` sometimes unbalances the books on purpose.
    function assay(uint256 which, uint16 processedBps, uint16 recoveryBps, uint8 skew) external {
        if (batches.length == 0) return;
        // Start at a random batch and take the first one that still has metal
        // pending and is not frozen, so honest assays get a real chance.
        uint256 start = bound(which, 0, batches.length - 1);
        uint256 batchId;
        ConservationLedger.Batch memory b;
        for (uint256 k; k < batches.length; ++k) {
            uint256 id = batches[(start + k) % batches.length];
            ConservationLedger.Batch memory c = ledger.batch(id);
            if (!c.tainted && (c.pending[0] | c.pending[1] | c.pending[2] | c.pending[3]) != 0) {
                batchId = id;
                b = c;
                break;
            }
        }
        if (batchId == 0) return;
        uint256 pBps = bound(processedBps, 0, 10_000);
        uint256 rBps = bound(recoveryBps, 0, 10_500);
        ConservationLedger.Assay memory a;
        a.batchId = batchId;
        a.lab = lab;
        a.nonce = b.assayCount;
        a.deadline = uint64(block.timestamp + 1);
        for (uint256 e; e < 4; ++e) {
            uint256 processed = (uint256(b.pending[e]) * pBps) / 10_000;
            uint256 rec = (processed * rBps) / 10_000;
            if (rec > processed) rec = processed;
            a.recovered[e] = uint64(rec);
            a.loss[e] = uint64(processed - rec);
            a.residual[e] = b.pending[e] - uint64(processed);
        }
        // Every third attempt is dishonest on purpose: either the books do not
        // balance, or an element is claimed at 100% recovery.
        if (assayAttempts % 3 == 2) {
            uint256 e = skew % 4;
            if (skew % 2 == 0 || a.recovered[e] + a.loss[e] == 0) {
                a.recovered[e] += 1;
            } else {
                a.recovered[e] += a.loss[e];
                a.loss[e] = 0;
            }
        }
        (uint8 v1, bytes32 r1, bytes32 s1) = vm.sign(recyclerKey, ledger.assayDigest(a));
        (uint8 v2, bytes32 r2, bytes32 s2) = vm.sign(labKey, ledger.assayDigest(a));
        assayAttempts++;
        try ledger.settle(a, abi.encodePacked(r1, s1, v1), abi.encodePacked(r2, s2, v2)) {
            assaySuccesses++;
        } catch {
            rejectedAssays++;
        }
    }

    function issue(uint256 which, uint8 element, uint64 grams) external {
        if (batches.length == 0) return;
        uint256 batchId = batches[bound(which, 0, batches.length - 1)];
        uint8 e = uint8(bound(element, 0, 3));
        uint64[] memory g = new uint64[](1);
        g[0] = uint64(bound(grams, 1, 2e7)); // often more than issuable
        uint256[] memory owners = new uint256[](1);
        owners[0] = uint256(keccak256(abi.encode(nonce++))) % 2 ** 250;
        vm.prank(recycler);
        try ledger.issueNotes(batchId, e, g, owners) {
            mintedGramsTotal += g[0];
            mintedNotes += 1;
        } catch {}
    }

    function revoke(uint256 which) external {
        if (intaken.length == 0) return;
        uint256 pid = intaken[bound(which, 0, intaken.length - 1)];
        vm.prank(authority);
        try passports.revoke(pid, "inv") {
            uint256 batchId = batchOfPassport[pid];
            if (!taintSeen[batchId]) {
                taintSeen[batchId] = true;
                issuedAtTaint[batchId] = ledger.batch(batchId).issued;
            }
        } catch {}
    }

    function issuedAtTaintOf(uint256 batchId) external view returns (uint64[4] memory) {
        return issuedAtTaint[batchId];
    }
}

contract ConservationInvariantTest is LedgerFixture {
    LedgerHandler internal handler;

    function setUp() public override {
        super.setUp();
        handler = new LedgerHandler(ledger, passports, devices, pool, manufacturer, recyclerKey, labKey, authority);
        vm.startPrank(admin);
        passports.grantRole(passports.MANUFACTURER_ROLE(), address(handler));
        vm.stopPrank();
        targetContract(address(handler));
        bytes4[] memory selectors = new bytes4[](5);
        selectors[0] = LedgerHandler.feed.selector;
        selectors[1] = LedgerHandler.refeed.selector;
        selectors[2] = LedgerHandler.assay.selector;
        selectors[3] = LedgerHandler.issue.selector;
        selectors[4] = LedgerHandler.revoke.selector;
        targetSelector(FuzzSelector({addr: address(handler), selectors: selectors}));
    }

    /// Guards against a vacuous pass: the run must have fed, assayed, refused
    /// bad assays and issued notes.
    function afterInvariant() public view {
        if (handler.intakenCount() >= 3 && handler.assayAttempts() >= 8) {
            assertGt(handler.assaySuccesses(), 0, "no assay ever succeeded");
            assertGt(handler.rejectedAssays(), 0, "no dishonest assay was tried");
        }
    }

    /// input = recovered + loss + pending, for every element of every batch.
    function invariant_massIsConserved() public view {
        for (uint256 i; i < handler.batchCount(); ++i) {
            ConservationLedger.Batch memory b = ledger.batch(handler.batches(i));
            for (uint256 e; e < 4; ++e) {
                assertEq(uint256(b.input[e]), uint256(b.recovered[e]) + b.loss[e] + b.pending[e]);
            }
        }
    }

    /// Recovered metal never exceeds what was processed times the ceiling.
    function invariant_recoveryWithinPhysicalCeiling() public view {
        for (uint256 i; i < handler.batchCount(); ++i) {
            ConservationLedger.Batch memory b = ledger.batch(handler.batches(i));
            for (uint8 e; e < 4; ++e) {
                uint256 processed = uint256(b.input[e]) - b.pending[e];
                assertLe(uint256(b.recovered[e]) * 10_000, processed * Elements.maxRecoveryBps(e));
            }
        }
    }

    /// Every recovered gram is either still issuable or already issued.
    function invariant_issuanceAccountsForRecovery() public view {
        uint256 issuedTotal;
        for (uint256 i; i < handler.batchCount(); ++i) {
            ConservationLedger.Batch memory b = ledger.batch(handler.batches(i));
            for (uint256 e; e < 4; ++e) {
                assertEq(uint256(b.issued[e]) + b.issuable[e], b.recovered[e]);
                issuedTotal += b.issued[e];
            }
        }
        assertEq(issuedTotal, handler.mintedGramsTotal());
        assertEq(pool.nextIndex(), handler.mintedNotes());
    }

    /// A battery feeds at most one batch, ever.
    function invariant_noBatteryCountedTwice() public view {
        for (uint256 i; i < handler.intakenCount(); ++i) {
            uint256 pid = handler.intaken(i);
            assertEq(handler.intakeCount(pid), 1);
            uint8 s = passports.statusOf(pid);
            assertTrue(s == passports.RECYCLED() || s == passports.REVOKED());
        }
    }

    /// Nothing more is issued from a batch once one of its batteries is revoked.
    function invariant_taintFreezesIssuance() public view {
        for (uint256 i; i < handler.batchCount(); ++i) {
            uint256 id = handler.batches(i);
            if (!handler.taintSeen(id)) continue;
            ConservationLedger.Batch memory b = ledger.batch(id);
            assertTrue(b.tainted);
            uint64[4] memory atTaint = handler.issuedAtTaintOf(id);
            for (uint256 e; e < 4; ++e) assertEq(b.issued[e], atTaint[e]);
        }
    }
}
