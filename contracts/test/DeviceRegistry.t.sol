// SPDX-License-Identifier: MIT
pragma solidity 0.8.30;

import {KutleTest} from "./utils/KutleTest.sol";
import {DeviceRegistry} from "../src/DeviceRegistry.sol";
import {MLDSAKey} from "../src/libraries/MLDSAKey.sol";

contract MLDSAKeyHarness {
    function count(bytes calldata pk) external pure returns (uint256) {
        return MLDSAKey.largeLiftCount(pk);
    }

    function check(bytes calldata pk) external pure {
        MLDSAKey.requireNonDegenerate(pk);
    }
}

contract DeviceRegistryTest is KutleTest {
    MLDSAKeyHarness internal keys;

    function setUp() public override {
        super.setUp();
        keys = new MLDSAKeyHarness();
    }

    // ------------------------------------------------------------- key floor

    function test_realKeysPassTheDegeneracyFloor() public view {
        // A genuine key's t1 is close to uniform, so about 97.7% of coefficients
        // have a large centred lift.
        uint256 big = keys.count(fxBytes(".keyA1.pk"));
        assertGt(big, 950);
        keys.check(fxBytes(".keyA2.pk"));
        keys.check(fxBytes(".keyB1.pk"));
    }

    function test_degenerateKeyIsRefused() public {
        bytes memory pk = fxBytes(".degeneratePk");
        assertEq(keys.count(pk), 0);
        vm.expectRevert(abi.encodeWithSelector(MLDSAKey.DegenerateKey.selector, 0));
        keys.check(pk);
    }

    function test_maximalDegenerateKeyIsRefused() public {
        // t1 = 1023 everywhere: every packed byte 0xff. Its centred lift is -1.
        bytes memory pk = fxBytes(".keyA1.pk");
        for (uint256 i = 32; i < pk.length; ++i) pk[i] = 0xff;
        assertEq(keys.count(pk), 0);
        vm.expectRevert(abi.encodeWithSelector(MLDSAKey.DegenerateKey.selector, 0));
        keys.check(pk);
    }

    function test_wrongLengthIsRefusedBeforeHashing() public {
        bytes memory pk = bytes.concat(fxBytes(".keyA1.pk"), hex"00");
        vm.expectRevert(abi.encodeWithSelector(MLDSAKey.WrongKeyLength.selector, 1313));
        keys.check(pk);
    }

    function testFuzz_keysNearZeroAreRefused(uint8 spread) public {
        // Every coefficient within `spread % 12` of zero: inside the forgeable window.
        uint256 s = spread % 12;
        bytes memory pk = new bytes(1312);
        for (uint256 off = 32; off < 1312; off += 5) {
            uint256 packed = s | (s << 10) | (s << 20) | (s << 30);
            for (uint256 j; j < 5; ++j) pk[off + j] = bytes1(uint8(packed >> (8 * j)));
        }
        vm.expectRevert();
        keys.check(pk);
    }

    // ---------------------------------------------------------- registration

    function test_registerWithRealHybridProofOfPossession() public {
        address blob = deployRaw(fxBytes(".keyA1.blob"));
        address signer = fxAddr(".keyA1.ecdsaSigner");
        bytes memory pk = fxBytes(".keyA1.pk");
        bytes memory popE = fxBytes(".keyA1.popEcdsa");
        bytes memory popM = fxBytes(".keyA1.popMldsa");
        vm.prank(registrar);
        vm.startSnapshotGas("registerDevice");
        devices.registerDevice(deviceA(), manufacturer, signer, pk, blob, popE, popM);
        uint256 used = vm.stopSnapshotGas();
        emit log_named_uint("registerDevice gas", used);
        assertLt(used, 16_777_216, "must fit the EIP-7825 per-transaction gas cap");

        DeviceRegistry.DeviceKey memory k = devices.key(deviceA(), 1);
        assertEq(k.ecdsaSigner, fxAddr(".keyA1.ecdsaSigner"));
        assertEq(k.pkHash, fxB32(".keyA1.pkHash"));
        assertEq(k.pkBlobCodehash, k.pkBlob.codehash);
        assertEq(devices.operatorOf(deviceA()), manufacturer);
        assertTrue(devices.pkHashUsed(fxB32(".keyA1.pkHash")));
    }

    function test_mldsaSignatureFromAnotherKeyIsRefused() public {
        address blob = deployRaw(fxBytes(".keyA1.blob"));
        bytes memory wrongSig = fxBytes(".keyB1.popMldsa"); // valid signature, wrong key and message
        vm.prank(registrar);
        vm.expectRevert(DeviceRegistry.BadMldsaPoP.selector);
        devices.registerDevice(
            deviceA(), manufacturer, fxAddr(".keyA1.ecdsaSigner"), fxBytes(".keyA1.pk"), blob,
            fxBytes(".keyA1.popEcdsa"), wrongSig
        );
    }

    function test_tamperedMldsaSignatureIsRefused() public {
        address blob = deployRaw(fxBytes(".keyA1.blob"));
        bytes memory sig = fxBytes(".keyA1.popMldsa");
        sig[100] ^= 0x01;
        vm.prank(registrar);
        vm.expectRevert(DeviceRegistry.BadMldsaPoP.selector);
        devices.registerDevice(
            deviceA(), manufacturer, fxAddr(".keyA1.ecdsaSigner"), fxBytes(".keyA1.pk"), blob,
            fxBytes(".keyA1.popEcdsa"), sig
        );
    }

    function test_ecdsaFromAnotherSignerIsRefused() public {
        address blob = deployRaw(fxBytes(".keyA1.blob"));
        vm.prank(registrar);
        vm.expectRevert(DeviceRegistry.BadEcdsaPoP.selector);
        devices.registerDevice(
            deviceA(), manufacturer, fxAddr(".keyA1.ecdsaSigner"), fxBytes(".keyA1.pk"), blob,
            fxBytes(".keyB1.popEcdsa"), fxBytes(".keyA1.popMldsa")
        );
    }

    function test_blobOfAnotherKeyIsRefused() public {
        // Key A's pk with key B's blob: the ML-DSA check runs against B's key and fails.
        address blobB = deployRaw(fxBytes(".keyB1.blob"));
        vm.prank(registrar);
        vm.expectRevert(DeviceRegistry.BadMldsaPoP.selector);
        devices.registerDevice(
            deviceA(), manufacturer, fxAddr(".keyA1.ecdsaSigner"), fxBytes(".keyA1.pk"), blobB,
            fxBytes(".keyA1.popEcdsa"), fxBytes(".keyA1.popMldsa")
        );
    }

    function test_wrongSizedBlobIsRefused() public {
        address blob = deployRaw(hex"00112233");
        vm.prank(registrar);
        vm.expectRevert(DeviceRegistry.BadBlob.selector);
        devices.registerDevice(
            deviceA(), manufacturer, fxAddr(".keyA1.ecdsaSigner"), fxBytes(".keyA1.pk"), blob,
            fxBytes(".keyA1.popEcdsa"), fxBytes(".keyA1.popMldsa")
        );
    }

    function test_sameKeyCannotBeRegisteredTwice() public {
        registerFixtureDevice("keyA1", deviceA(), manufacturer);
        address blob = deployRaw(fxBytes(".keyA1.blob"));
        vm.prank(registrar);
        vm.expectRevert(DeviceRegistry.PkReused.selector);
        devices.registerDevice(
            deviceB(), manufacturer, fxAddr(".keyA1.ecdsaSigner"), fxBytes(".keyA1.pk"), blob,
            fxBytes(".keyA1.popEcdsa"), fxBytes(".keyA1.popMldsa")
        );
    }

    function test_onlyRegistrarCanRegister() public {
        address blob = deployRaw(fxBytes(".keyA1.blob"));
        vm.expectRevert();
        devices.registerDevice(
            deviceA(), manufacturer, fxAddr(".keyA1.ecdsaSigner"), fxBytes(".keyA1.pk"), blob,
            fxBytes(".keyA1.popEcdsa"), fxBytes(".keyA1.popMldsa")
        );
    }

    // ------------------------------------------------------- pinned code hash

    function test_swappedVerifierCodeIsDetected() public {
        registerFixtureDevice("keyA1", deviceA(), manufacturer);
        // Replace the verifier with code that accepts everything.
        bytes32 popA1 = fxB32(".keyA1.popDigest");
        bytes memory ecdsaSig = fxBytes(".keyA1.popEcdsa");
        vm.etch(address(mldsa), hex"600160005260206000f3");
        vm.expectRevert(DeviceRegistry.VerifierSwapped.selector);
        devices.requireSignedByDevice(deviceA(), popA1, ecdsaSig, "");
    }

    function test_swappedBlobCodeIsDetected() public {
        registerFixtureDevice("keyA1", deviceA(), manufacturer);
        DeviceRegistry.DeviceKey memory k = devices.key(deviceA(), 1);
        bytes memory other = fxBytes(".keyB1.blob");
        vm.etch(k.pkBlob, other);
        bytes32 digest = fxB32(".keyA1.popDigest");
        vm.expectRevert(DeviceRegistry.BadBlob.selector);
        devices.requireSignedByDevice(deviceA(), digest, fxBytes(".keyA1.popEcdsa"), fxBytes(".keyA1.popMldsa"));
    }

    // ----------------------------------------------------- rotation, revoking

    function test_rotateThenOldKeyCannotSign() public {
        registerFixtureDevice("keyA1", deviceA(), manufacturer);
        bytes32 popA1 = fxB32(".keyA1.popDigest");
        // Key v1 signs fine before rotation.
        devices.requireSignedByDevice(deviceA(), popA1, fxBytes(".keyA1.popEcdsa"), fxBytes(".keyA1.popMldsa"));

        address blob2 = deployRaw(fxBytes(".keyA2.blob"));
        vm.prank(registrar);
        devices.rotateKey(
            deviceA(), fxAddr(".keyA2.ecdsaSigner"), fxBytes(".keyA2.pk"), blob2,
            fxBytes(".keyA2.popEcdsa"), fxBytes(".keyA2.popMldsa")
        );
        (, uint32 v,) = devices.devices(deviceA());
        assertEq(v, 2);
        assertGt(devices.key(deviceA(), 1).revokedAt, 0);
        // v1's signature no longer satisfies the current key.
        vm.expectRevert(DeviceRegistry.BadEcdsaPoP.selector);
        devices.requireSignedByDevice(deviceA(), popA1, fxBytes(".keyA1.popEcdsa"), fxBytes(".keyA1.popMldsa"));
    }

    function test_revokedKeyCannotSign() public {
        registerFixtureDevice("keyA1", deviceA(), manufacturer);
        vm.prank(authority);
        devices.revokeKey(deviceA(), "stolen");
        bytes32 popA1 = fxB32(".keyA1.popDigest");
        vm.expectRevert(DeviceRegistry.KeyIsRevoked.selector);
        devices.requireSignedByDevice(deviceA(), popA1, fxBytes(".keyA1.popEcdsa"), fxBytes(".keyA1.popMldsa"));
    }

    function test_disabledSuiteFailsClosed() public {
        registerFixtureDevice("keyA1", deviceA(), manufacturer);
        vm.prank(admin);
        devices.setSuite(1, address(mldsa), false);
        bytes32 popA1 = fxB32(".keyA1.popDigest");
        vm.expectRevert(abi.encodeWithSelector(DeviceRegistry.SuiteDisabled.selector, 1));
        devices.requireSignedByDevice(deviceA(), popA1, fxBytes(".keyA1.popEcdsa"), fxBytes(".keyA1.popMldsa"));
    }
}
