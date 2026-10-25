// SPDX-License-Identifier: MIT
pragma solidity 0.8.30;

import {AccessControl} from "@openzeppelin/contracts/access/AccessControl.sol";
import {EIP712} from "@openzeppelin/contracts/utils/cryptography/EIP712.sol";
import {SignatureChecker} from "@openzeppelin/contracts/utils/cryptography/SignatureChecker.sol";
import {Elements} from "./libraries/Elements.sol";
import {Conservation} from "./libraries/Conservation.sol";

interface IPassportsForLedger {
    function closeAtRecycler(uint256 passportId, uint256 batchId) external returns (uint64[4] memory composition);
}

interface INotePoolInsert {
    function mintNote(uint8 element, uint64 grams, uint256 ownerCommit) external returns (uint256 leafIndex);
}

/// @title ConservationLedger
/// @notice Where recycled metal comes from, gram for gram.
///
///         A recycler opens a batch and feeds it end-of-life batteries. Each
///         battery's passport is closed for good and its declared metal content
///         becomes the batch's input. A lab assay, co-signed by the recycler and
///         an accredited lab, then splits what was processed into recovered metal
///         and loss, with the rest carried forward as unprocessed stock.
///
///         For every element of every batch the contract keeps an equality, not a
///         cap:
///
///             input = recovered + loss + unprocessed
///
///         and on every assay, recovered <= processed x physical ceiling. Recycled
///         metal therefore cannot be created out of nothing, cannot come from a
///         battery that was already counted, and cannot be inflated by declaring
///         less loss: the ceiling applies to what was processed, and what was
///         processed is fixed by passports that cannot be reopened.
///
///         Recovered metal is then issued as notes in the NotePool, where a battery
///         maker can spend it into a new passport without revealing which recycler
///         or which lot it came from.
contract ConservationLedger is AccessControl, EIP712 {
    using Elements for uint8;

    bytes32 public constant RECYCLER_ROLE = keccak256("RECYCLER_ROLE");
    bytes32 public constant PASSPORTS_ROLE = keccak256("PASSPORTS_ROLE");

    bytes32 public constant ASSAY_TYPEHASH = keccak256(
        "Assay(uint256 batchId,uint64[4] recovered,uint64[4] loss,uint64[4] residual,bytes32 reportHash,address lab,uint32 nonce,uint64 deadline)"
    );

    struct Assay {
        uint256 batchId;
        uint64[4] recovered;
        uint64[4] loss;
        uint64[4] residual;
        bytes32 reportHash; // sha256 of the lab's assay report
        address lab;
        uint32 nonce; // must equal the batch's assay count, so each assay is used once
        uint64 deadline;
    }

    struct Batch {
        address recycler;
        uint64 openedAt;
        uint32 passportCount;
        uint32 assayCount;
        bool tainted;
        uint64[4] input; // metal fed in, from closed passports
        uint64[4] pending; // fed in but not yet processed
        uint64[4] recovered;
        uint64[4] loss;
        uint64[4] issuable; // recovered and not yet issued as notes
        uint64[4] issued;
    }

    struct Lab {
        bool accredited;
        bytes32 accreditationRef; // e.g. hash of the ISO/IEC 17025 certificate
    }

    IPassportsForLedger public immutable passports;
    INotePoolInsert public notePool;

    uint256 public batchCount;
    mapping(uint256 => Batch) private _batches;
    mapping(address => Lab) public labs;

    event NotePoolSet(address notePool);
    event LabSet(address indexed lab, bool accredited, bytes32 accreditationRef);
    event BatchOpened(uint256 indexed batchId, address indexed recycler);
    event Intake(uint256 indexed batchId, uint256 indexed passportId, uint64[4] composition);
    event Assayed(uint256 indexed batchId, uint32 nonce, address indexed lab, bytes32 reportHash, uint64[4] recovered, uint64[4] loss, uint64[4] residual, bool[4] belowTarget);
    event NotesIssued(uint256 indexed batchId, uint8 indexed element, uint64 totalGrams, uint256 count);
    event Tainted(uint256 indexed batchId, uint256 indexed passportId);

    error NotRecycler();
    error UnknownBatch();
    error BatchTainted();
    error BatchAlreadyAssayed();
    error NothingPending();
    error Expired();
    error WrongNonce(uint32 expected, uint32 got);
    error LabNotAccredited();
    error BadRecyclerSignature();
    error BadLabSignature();
    error OverIssuable(uint8 element);
    error LengthMismatch();
    error ZeroGrams();
    error AlreadySet();
    error ZeroAddress();

    constructor(address admin, IPassportsForLedger passports_) EIP712("Kutle ConservationLedger", "1") {
        if (admin == address(0)) revert ZeroAddress();
        _grantRole(DEFAULT_ADMIN_ROLE, admin);
        passports = passports_;
        _grantRole(PASSPORTS_ROLE, address(passports_));
    }

    function setNotePool(INotePoolInsert notePool_) external onlyRole(DEFAULT_ADMIN_ROLE) {
        if (address(notePool) != address(0)) revert AlreadySet();
        if (address(notePool_) == address(0)) revert ZeroAddress();
        notePool = notePool_;
        emit NotePoolSet(address(notePool_));
    }

    function setLab(address lab, bool accredited, bytes32 accreditationRef) external onlyRole(DEFAULT_ADMIN_ROLE) {
        if (lab == address(0)) revert ZeroAddress();
        labs[lab] = Lab(accredited, accreditationRef);
        emit LabSet(lab, accredited, accreditationRef);
    }

    // ------------------------------------------------------------------ intake

    function openBatch() external onlyRole(RECYCLER_ROLE) returns (uint256 batchId) {
        batchId = ++batchCount;
        Batch storage b = _batches[batchId];
        b.recycler = msg.sender;
        b.openedAt = uint64(block.timestamp);
        emit BatchOpened(batchId, msg.sender);
    }

    /// @notice Feed end-of-life batteries into a batch. Allowed until the first
    ///         assay, so an assay always refers to a fixed input.
    function intake(uint256 batchId, uint256[] calldata passportIds) external {
        Batch storage b = _owned(batchId);
        if (b.assayCount != 0) revert BatchAlreadyAssayed();
        for (uint256 i; i < passportIds.length; ++i) {
            uint64[4] memory c = passports.closeAtRecycler(passportIds[i], batchId);
            for (uint8 e; e < Elements.COUNT; ++e) {
                b.input[e] += c[e];
                b.pending[e] += c[e];
            }
            emit Intake(batchId, passportIds[i], c);
        }
        b.passportCount += uint32(passportIds.length);
    }

    // ------------------------------------------------------------------- assay

    function assayDigest(Assay calldata a) public view returns (bytes32) {
        return _hashTypedDataV4(
            keccak256(
                abi.encode(
                    ASSAY_TYPEHASH,
                    a.batchId,
                    keccak256(abi.encodePacked(a.recovered)),
                    keccak256(abi.encodePacked(a.loss)),
                    keccak256(abi.encodePacked(a.residual)),
                    a.reportHash,
                    a.lab,
                    a.nonce,
                    a.deadline
                )
            )
        );
    }

    /// @notice Record a co-signed assay. Both signatures are over the same EIP-712
    ///         digest. Smart-contract wallets are supported through ERC-1271, so a
    ///         recycler can sign with its own multisig.
    function settle(Assay calldata a, bytes calldata recyclerSig, bytes calldata labSig) external {
        Batch storage b = _batches[a.batchId];
        if (b.recycler == address(0)) revert UnknownBatch();
        if (b.tainted) revert BatchTainted();
        if (block.timestamp > a.deadline) revert Expired();
        if (a.nonce != b.assayCount) revert WrongNonce(b.assayCount, a.nonce);
        if (!labs[a.lab].accredited) revert LabNotAccredited();

        bytes32 digest = assayDigest(a);
        if (!SignatureChecker.isValidSignatureNow(b.recycler, digest, recyclerSig)) revert BadRecyclerSignature();
        if (!SignatureChecker.isValidSignatureNow(a.lab, digest, labSig)) revert BadLabSignature();

        bool any;
        bool[4] memory belowTarget;
        for (uint8 e; e < Elements.COUNT; ++e) {
            uint64 rec = a.recovered[e];
            uint64 res = a.residual[e];
            uint256 processed = _checkElement(e, b.pending[e], rec, a.loss[e], res);
            if (processed != 0) {
                any = true;
                belowTarget[e] = Conservation.belowTarget(processed, rec, e.recoveryTarget2027Bps());
            }
            b.pending[e] = res;
            b.recovered[e] += rec;
            b.loss[e] += a.loss[e];
            b.issuable[e] += rec;
        }
        if (!any) revert NothingPending();
        unchecked {
            ++b.assayCount;
        }
        emit Assayed(a.batchId, a.nonce, a.lab, a.reportHash, a.recovered, a.loss, a.residual, belowTarget);
    }

    // ------------------------------------------------------------------- notes

    /// @notice Issue recovered metal as private notes, typically when selling it
    ///         to a cell maker. Each note commits to its future owner's secret;
    ///         the gram amounts are public here and private from then on.
    function issueNotes(uint256 batchId, uint8 element, uint64[] calldata grams, uint256[] calldata ownerCommits)
        external
    {
        element.check();
        Batch storage b = _owned(batchId);
        if (b.tainted) revert BatchTainted();
        if (grams.length != ownerCommits.length || grams.length == 0) revert LengthMismatch();
        uint64 total;
        for (uint256 i; i < grams.length; ++i) {
            if (grams[i] == 0) revert ZeroGrams();
            total += grams[i];
        }
        if (total > b.issuable[element]) revert OverIssuable(element);
        b.issuable[element] -= total;
        b.issued[element] += total;
        for (uint256 i; i < grams.length; ++i) {
            notePool.mintNote(element, grams[i], ownerCommits[i]);
        }
        emit NotesIssued(batchId, element, total, grams.length);
    }

    // --------------------------------------------------------------- revocation

    /// @notice Called by the passport registry when a battery that fed this batch
    ///         is revoked. Stops further assays and issuance from the batch.
    function taint(uint256 batchId, uint256 passportId) external onlyRole(PASSPORTS_ROLE) {
        Batch storage b = _batches[batchId];
        if (b.recycler == address(0)) revert UnknownBatch();
        b.tainted = true;
        emit Tainted(batchId, passportId);
    }

    // ------------------------------------------------------------------- views

    function batch(uint256 batchId) external view returns (Batch memory) {
        return _batches[batchId];
    }

    function _checkElement(uint8 e, uint64 pending, uint64 rec, uint64 loss, uint64 res)
        private
        pure
        returns (uint256 processed)
    {
        return Conservation.check(e, pending, rec, loss, res, e.maxRecoveryBps());
    }

    function _owned(uint256 batchId) private view returns (Batch storage b) {
        b = _batches[batchId];
        if (b.recycler == address(0)) revert UnknownBatch();
        // A recycler whose role was withdrawn can no longer act on its old batches.
        if (b.recycler != msg.sender || !hasRole(RECYCLER_ROLE, msg.sender)) revert NotRecycler();
    }
}
