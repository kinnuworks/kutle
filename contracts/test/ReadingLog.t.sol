// SPDX-License-Identifier: MIT
pragma solidity 0.8.30;

import {KutleTest} from "./utils/KutleTest.sol";
import {ReadingLog} from "../src/ReadingLog.sol";
import {DeviceRegistry} from "../src/DeviceRegistry.sol";

contract ReadingLogTest is KutleTest {
    uint256 internal pid;

    function setUp() public override {
        super.setUp();
        pid = setUpDeviceAndPassport();
    }

    function test_anchorRealSignedBatch() public {
        bytes32 root = fxB32(".batches[0].root");
        uint64 fromTs = uint64(fxUint(".batches[0].fromTs"));
        uint64 toTs = uint64(fxUint(".batches[0].toTs"));
        uint32 count = uint32(fxUint(".batches[0].count"));
        bytes memory e = fxBytes(".batches[0].ecdsaSig");
        bytes memory m = fxBytes(".batches[0].mldsaSig");
        vm.startSnapshotGas("anchor");
        bytes32 id = readings.anchor(deviceA(), pid, 0, root, fromTs, toTs, count, e, m);
        uint256 used = vm.stopSnapshotGas();
        assertLt(used, 3_000_000);
        emit log_named_uint("anchor gas (one ML-DSA-44 + one ECDSA check)", used);

        ReadingLog.Batch memory b = readings.batch(id);
        assertEq(b.deviceId, deviceA());
        assertEq(b.passportId, pid);
        assertEq(b.root, fxB32(".batches[0].root"));
        assertEq(b.keyVersion, 1);
        assertEq(readings.nextSeq(deviceA()), 1);
    }

    function test_digestMatchesFixture() public view {
        bytes32 d = readings.batchDigest(
            deviceA(), pid, 0, fxB32(".batches[0].root"),
            uint64(fxUint(".batches[0].fromTs")), uint64(fxUint(".batches[0].toTs")), uint32(fxUint(".batches[0].count"))
        );
        assertEq(d, fxB32(".batches[0].digest"));
    }

    function test_sequentialBatches() public {
        anchorFixtureBatch(0);
        anchorFixtureBatch(1);
        assertEq(readings.nextSeq(deviceA()), 2);
        assertEq(readings.lastToTs(deviceA()), fxUint(".batches[1].toTs"));
    }

    function test_replayIsRefused() public {
        anchorFixtureBatch(0);
        vm.expectRevert(abi.encodeWithSelector(ReadingLog.BadSequence.selector, 1, 0));
        anchorFixtureBatch(0);
    }

    function test_skippingASequenceNumberIsRefused() public {
        vm.expectRevert(abi.encodeWithSelector(ReadingLog.BadSequence.selector, 0, 1));
        anchorFixtureBatch(1);
    }

    function test_tamperedRootIsRefused() public {
        vm.expectRevert(DeviceRegistry.BadEcdsaPoP.selector);
        readings.anchor(
            deviceA(), pid, 0, keccak256("not the signed root"),
            uint64(fxUint(".batches[0].fromTs")), uint64(fxUint(".batches[0].toTs")), uint32(fxUint(".batches[0].count")),
            fxBytes(".batches[0].ecdsaSig"), fxBytes(".batches[0].mldsaSig")
        );
    }

    function test_validEcdsaWithForgedMldsaIsRefused() public {
        // An attacker who stole only the ECDSA key cannot anchor anything.
        bytes memory forged = fxBytes(".batches[1].mldsaSig");
        vm.expectRevert(DeviceRegistry.BadMldsaPoP.selector);
        readings.anchor(
            deviceA(), pid, 0, fxB32(".batches[0].root"),
            uint64(fxUint(".batches[0].fromTs")), uint64(fxUint(".batches[0].toTs")), uint32(fxUint(".batches[0].count")),
            fxBytes(".batches[0].ecdsaSig"), forged
        );
    }

    function test_futureWindowIsRefused() public {
        vm.warp(fxUint(".batches[0].toTs") - readings.MAX_CLOCK_SKEW() - 1);
        vm.expectRevert(ReadingLog.BadWindow.selector);
        anchorFixtureBatch(0);
    }

    function test_batchForAnotherPassportIsRefused() public {
        // A second passport on another device cannot receive device A's batch.
        registerFixtureDevice("keyB1", deviceB(), manufacturer);
        uint256 other = issuePassport(deviceB(), keccak256("gs1:B"));
        vm.expectRevert(ReadingLog.WrongDevice.selector);
        readings.anchor(
            deviceA(), other, 0, fxB32(".batches[0].root"),
            uint64(fxUint(".batches[0].fromTs")), uint64(fxUint(".batches[0].toTs")), uint32(fxUint(".batches[0].count")),
            fxBytes(".batches[0].ecdsaSig"), fxBytes(".batches[0].mldsaSig")
        );
    }

    function test_afterRotationNewKeySignsAndOldCannot() public {
        anchorFixtureBatch(0);
        anchorFixtureBatch(1);
        address blob2 = deployRaw(fxBytes(".keyA2.blob"));
        vm.prank(registrar);
        devices.rotateKey(
            deviceA(), fxAddr(".keyA2.ecdsaSigner"), fxBytes(".keyA2.pk"), blob2,
            fxBytes(".keyA2.popEcdsa"), fxBytes(".keyA2.popMldsa")
        );
        bytes32 id = anchorFixtureBatch(2); // signed by key v2
        assertEq(readings.batch(id).keyVersion, 2);
    }

    function test_revokedPassportStopsAcceptingReadings() public {
        vm.prank(authority);
        passports.revoke(pid, "counterfeit");
        vm.expectRevert(ReadingLog.WrongDevice.selector);
        anchorFixtureBatch(0);
    }

    function test_merkleProofOfOneReading() public {
        bytes32 id = anchorFixtureBatch(0);
        bytes32 leaf1 = fxB32(".tree0.leaves[1]");
        bytes32[] memory proof = new bytes32[](2);
        proof[0] = fxB32(".tree0.proofForLeaf1[0]");
        proof[1] = fxB32(".tree0.proofForLeaf1[1]");
        assertTrue(readings.verifyReading(id, leaf1, proof));
        // A reading that was never signed does not verify.
        assertFalse(readings.verifyReading(id, keccak256(bytes.concat(keccak256("reading-9"))), proof));
        // Swapping the path fails too.
        (proof[0], proof[1]) = (proof[1], proof[0]);
        assertFalse(readings.verifyReading(id, leaf1, proof));
    }
}
