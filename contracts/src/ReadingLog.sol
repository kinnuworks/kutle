// SPDX-License-Identifier: MIT
pragma solidity 0.8.30;

import {DeviceRegistry} from "./DeviceRegistry.sol";

interface IPassportDevice {
    function deviceOf(uint256 passportId) external view returns (bytes32);
}

/// @title ReadingLog
/// @notice Merkle roots of fuel-gauge readings, each batch signed by the device's
///         hybrid key. Anyone may relay a batch; the signatures, the sequence
///         number and the time window decide whether it is accepted.
///
///         One ML-DSA verification costs about 1.2M gas, so the device signs a
///         Merkle root over many readings instead of each reading. Any single
///         reading can later be proven against its root with a short path.
contract ReadingLog {
    DeviceRegistry public immutable deviceRegistry;
    IPassportDevice public immutable passports;

    /// Device clocks may run ahead of the chain by this much.
    uint64 public constant MAX_CLOCK_SKEW = 10 minutes;

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

    /// batchId = keccak256(deviceId, seq)
    mapping(bytes32 => Batch) private _batches;
    mapping(bytes32 => uint64) public nextSeq;
    mapping(bytes32 => uint64) public lastToTs;

    bytes32 public constant BATCH_TYPEHASH = keccak256(
        "KutleReadingBatch(bytes32 deviceId,uint256 passportId,uint64 seq,bytes32 root,uint64 fromTs,uint64 toTs,uint32 count)"
    );

    event BatchAnchored(bytes32 indexed batchId, bytes32 indexed deviceId, uint256 indexed passportId, uint64 seq, bytes32 root, uint64 fromTs, uint64 toTs, uint32 count, uint32 keyVersion);

    error WrongDevice();
    error BadSequence(uint64 expected, uint64 got);
    error BadWindow();
    error EmptyBatch();
    error UnknownBatch();

    constructor(DeviceRegistry deviceRegistry_, IPassportDevice passports_) {
        deviceRegistry = deviceRegistry_;
        passports = passports_;
    }

    /// @notice What the device signs for one batch.
    function batchDigest(bytes32 deviceId, uint256 passportId, uint64 seq, bytes32 root, uint64 fromTs, uint64 toTs, uint32 count)
        public
        view
        returns (bytes32)
    {
        return keccak256(
            abi.encode(
                BATCH_TYPEHASH, block.chainid, address(this), deviceId, passportId, seq, root, fromTs, toTs, count
            )
        );
    }

    function anchor(
        bytes32 deviceId,
        uint256 passportId,
        uint64 seq,
        bytes32 root,
        uint64 fromTs,
        uint64 toTs,
        uint32 count,
        bytes calldata ecdsaSig,
        bytes calldata mldsaSig
    ) external returns (bytes32 batchId) {
        if (passports.deviceOf(passportId) != deviceId) revert WrongDevice();
        uint64 expected = nextSeq[deviceId];
        if (seq != expected) revert BadSequence(expected, seq);
        if (count == 0) revert EmptyBatch();
        // Windows must move forward in time and not sit in the future.
        if (fromTs > toTs || fromTs < lastToTs[deviceId] || toTs > block.timestamp + MAX_CLOCK_SKEW) revert BadWindow();

        bytes32 digest = batchDigest(deviceId, passportId, seq, root, fromTs, toTs, count);
        uint32 keyVersion = deviceRegistry.requireSignedByDevice(deviceId, digest, ecdsaSig, mldsaSig);

        nextSeq[deviceId] = expected + 1;
        lastToTs[deviceId] = toTs;
        batchId = keccak256(abi.encode(deviceId, seq));
        _batches[batchId] = Batch(deviceId, passportId, root, fromTs, toTs, count, keyVersion, uint64(block.timestamp));
        emit BatchAnchored(batchId, deviceId, passportId, seq, root, fromTs, toTs, count, keyVersion);
    }

    function batch(bytes32 batchId) external view returns (Batch memory b) {
        b = _batches[batchId];
        if (b.anchoredAt == 0) revert UnknownBatch();
    }

    /// @notice Prove that one reading leaf belongs to an anchored batch.
    ///         Leaves are keccak256 of the canonical reading encoding; internal
    ///         nodes hash the sorted pair, matching the device firmware.
    function verifyReading(bytes32 batchId, bytes32 leaf, bytes32[] calldata proof) external view returns (bool) {
        Batch storage b = _batches[batchId];
        if (b.anchoredAt == 0) revert UnknownBatch();
        bytes32 h = leaf;
        for (uint256 i; i < proof.length; ++i) {
            bytes32 p = proof[i];
            h = h < p ? keccak256(abi.encodePacked(h, p)) : keccak256(abi.encodePacked(p, h));
        }
        return h == b.root;
    }
}
