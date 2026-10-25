// SPDX-License-Identifier: MIT
pragma solidity 0.8.30;

import {AccessControl} from "@openzeppelin/contracts/access/AccessControl.sol";
import {ECDSA} from "@openzeppelin/contracts/utils/cryptography/ECDSA.sol";
import {MessageHashUtils} from "@openzeppelin/contracts/utils/cryptography/MessageHashUtils.sol";
import {IMLDSA} from "./interfaces/IMLDSA.sol";
import {MLDSAKey} from "./libraries/MLDSAKey.sol";

/// @title DeviceRegistry
/// @notice Signing keys of battery-side devices (the microcontroller next to the
///         battery's fuel gauge). Every device holds two keys: a secp256k1 key and
///         an ML-DSA-44 key. A reading batch is accepted only when both sign it.
///
///         Why both: a passport must stay checkable for at least ten years after
///         the battery is recycled. Health records signed only with ECDSA could be
///         re-forged once a large quantum computer exists, and a forged history
///         could pass a worn pack off as a healthy one. ML-DSA (FIPS 204) covers
///         that horizon; ECDSA stays as a hedge against an implementation flaw in
///         the newer scheme.
///
///         Signature schemes are pluggable ("suites"), so a future scheme can be
///         added by governance without breaking records signed under older ones.
contract DeviceRegistry is AccessControl {
    using MLDSAKey for bytes;

    bytes32 public constant REGISTRAR_ROLE = keccak256("REGISTRAR_ROLE");
    bytes32 public constant AUTHORITY_ROLE = keccak256("AUTHORITY_ROLE");

    /// Suite 1: secp256k1 ECDSA + ML-DSA-44, both required.
    uint8 public constant SUITE_ECDSA_MLDSA44 = 1;

    struct Suite {
        address verifier; // post-quantum verifier contract
        bytes32 verifierCodehash; // pinned at registration, re-checked at every use
        bool enabled;
    }

    struct DeviceKey {
        address ecdsaSigner;
        address pkBlob; // prepared ML-DSA public key, read by the verifier as code
        bytes32 pkBlobCodehash;
        bytes32 pkHash; // keccak256 of the canonical 1312-byte FIPS 204 key
        uint8 suite;
        uint64 validFrom;
        uint64 revokedAt; // 0 while valid
    }

    struct Device {
        address operator; // economic operator responsible for the battery
        uint32 keyVersion; // current key version, starts at 1
        bool exists;
    }

    mapping(uint8 => Suite) public suites;
    mapping(bytes32 => Device) public devices;
    mapping(bytes32 => mapping(uint32 => DeviceKey)) private _keys;
    /// One registration per canonical public key, across all devices.
    mapping(bytes32 => bool) public pkHashUsed;

    event SuiteSet(uint8 indexed suite, address verifier, bytes32 codehash, bool enabled);
    event DeviceRegistered(bytes32 indexed deviceId, address indexed operator, address ecdsaSigner, address pkBlob, bytes32 pkHash);
    event KeyRotated(bytes32 indexed deviceId, uint32 version, address ecdsaSigner, address pkBlob, bytes32 pkHash);
    event KeyRevoked(bytes32 indexed deviceId, uint32 version, bytes32 reason);

    error DeviceExists();
    error UnknownDevice();
    error PkReused();
    error BadBlob();
    error SuiteDisabled(uint8 suite);
    error VerifierSwapped();
    error BadEcdsaPoP();
    error BadMldsaPoP();
    error KeyIsRevoked();
    error ZeroAddress();

    constructor(address admin) {
        if (admin == address(0)) revert ZeroAddress();
        _grantRole(DEFAULT_ADMIN_ROLE, admin);
    }

    // ------------------------------------------------------------------ suites

    function setSuite(uint8 suite, address verifier, bool enabled) external onlyRole(DEFAULT_ADMIN_ROLE) {
        if (verifier == address(0) || verifier.code.length == 0) revert ZeroAddress();
        suites[suite] = Suite(verifier, verifier.codehash, enabled);
        emit SuiteSet(suite, verifier, verifier.codehash, enabled);
    }

    // ------------------------------------------------------------ registration

    /// @notice Register a device. Called by the provisioning station that generated
    ///         the device's keys from a seed and checked, off chain, that `pkBlob`
    ///         holds exactly prepare(pk). On chain we check everything that can be
    ///         checked from the key itself and from the device's two signatures.
    /// @param pk the canonical 1312-byte FIPS 204 ML-DSA-44 public key
    /// @param popEcdsa ECDSA signature over popDigest(...)
    /// @param popMldsa ML-DSA-44 signature over popDigest(...)
    function registerDevice(
        bytes32 deviceId,
        address operator,
        address ecdsaSigner,
        bytes calldata pk,
        address pkBlob,
        bytes calldata popEcdsa,
        bytes calldata popMldsa
    ) external onlyRole(REGISTRAR_ROLE) {
        if (devices[deviceId].exists) revert DeviceExists();
        if (operator == address(0)) revert ZeroAddress();
        devices[deviceId] = Device(operator, 1, true);
        bytes32 pkHash = _installKey(deviceId, 1, ecdsaSigner, pk, pkBlob, popEcdsa, popMldsa);
        emit DeviceRegistered(deviceId, operator, ecdsaSigner, pkBlob, pkHash);
    }

    /// @notice Rotate to a new key pair. The new keys prove possession like at
    ///         registration. The old version stays on record so batches it signed
    ///         remain attributable, but it can no longer sign new ones.
    function rotateKey(
        bytes32 deviceId,
        address ecdsaSigner,
        bytes calldata pk,
        address pkBlob,
        bytes calldata popEcdsa,
        bytes calldata popMldsa
    ) external onlyRole(REGISTRAR_ROLE) {
        Device storage d = devices[deviceId];
        if (!d.exists) revert UnknownDevice();
        uint32 v = d.keyVersion + 1;
        DeviceKey storage old = _keys[deviceId][d.keyVersion];
        if (old.revokedAt == 0) old.revokedAt = uint64(block.timestamp);
        d.keyVersion = v;
        bytes32 pkHash = _installKey(deviceId, v, ecdsaSigner, pk, pkBlob, popEcdsa, popMldsa);
        emit KeyRotated(deviceId, v, ecdsaSigner, pkBlob, pkHash);
    }

    /// @notice Revoke the current key immediately, for example after a device is
    ///         reported stolen. Rotation is then the only way to sign again.
    function revokeKey(bytes32 deviceId, bytes32 reason) external onlyRole(AUTHORITY_ROLE) {
        Device storage d = devices[deviceId];
        if (!d.exists) revert UnknownDevice();
        DeviceKey storage k = _keys[deviceId][d.keyVersion];
        if (k.revokedAt != 0) revert KeyIsRevoked();
        k.revokedAt = uint64(block.timestamp);
        emit KeyRevoked(deviceId, d.keyVersion, reason);
    }

    // ------------------------------------------------------------ verification

    /// @notice Check a hybrid signature by the device's current key. Reverts on any
    ///         failure, so a caller can never mistake a soft failure for success.
    function requireSignedByDevice(bytes32 deviceId, bytes32 digest, bytes calldata ecdsaSig, bytes calldata mldsaSig)
        external
        view
        returns (uint32 keyVersion)
    {
        Device storage d = devices[deviceId];
        if (!d.exists) revert UnknownDevice();
        keyVersion = d.keyVersion;
        DeviceKey storage k = _keys[deviceId][keyVersion];
        if (k.revokedAt != 0) revert KeyIsRevoked();
        _checkHybrid(k, digest, ecdsaSig, mldsaSig);
    }

    function key(bytes32 deviceId, uint32 version) external view returns (DeviceKey memory) {
        return _keys[deviceId][version];
    }

    function operatorOf(bytes32 deviceId) external view returns (address) {
        return devices[deviceId].operator;
    }

    /// @notice The message a new key pair signs to prove possession. It binds the
    ///         chain, this registry, the device, the version and both keys.
    function popDigest(bytes32 deviceId, uint32 version, address ecdsaSigner, bytes32 pkHash)
        public
        view
        returns (bytes32)
    {
        return keccak256(
            abi.encode(keccak256("KUTLE_DEVICE_POP_V1"), block.chainid, address(this), deviceId, version, ecdsaSigner, pkHash)
        );
    }

    // ---------------------------------------------------------------- internal

    function _installKey(
        bytes32 deviceId,
        uint32 version,
        address ecdsaSigner,
        bytes calldata pk,
        address pkBlob,
        bytes calldata popEcdsa,
        bytes calldata popMldsa
    ) private returns (bytes32 pkHash) {
        if (ecdsaSigner == address(0) || pkBlob == address(0)) revert ZeroAddress();
        // Length check before hashing (SAFETY.md 3.1 (5)), then the degeneracy floor.
        pk.requireNonDegenerate();
        // De-duplicate on the canonical key, never on the blob (SAFETY.md 3.1 (3)-(4)).
        pkHash = keccak256(pk);
        if (pkHashUsed[pkHash]) revert PkReused();
        if (pkBlob.code.length != MLDSAKey.BLOB_CODE_SIZE) revert BadBlob();
        pkHashUsed[pkHash] = true;

        DeviceKey memory k = DeviceKey({
            ecdsaSigner: ecdsaSigner,
            pkBlob: pkBlob,
            pkBlobCodehash: pkBlob.codehash,
            pkHash: pkHash,
            suite: SUITE_ECDSA_MLDSA44,
            validFrom: uint64(block.timestamp),
            revokedAt: 0
        });
        _keys[deviceId][version] = k;

        bytes32 digest = popDigest(deviceId, version, ecdsaSigner, pkHash);
        (address rec, ECDSA.RecoverError err,) = ECDSA.tryRecover(MessageHashUtils.toEthSignedMessageHash(digest), popEcdsa);
        if (err != ECDSA.RecoverError.NoError || rec != ecdsaSigner) revert BadEcdsaPoP();
        if (!_mldsaOk(k, digest, popMldsa)) revert BadMldsaPoP();
    }

    function _checkHybrid(DeviceKey storage k, bytes32 digest, bytes calldata ecdsaSig, bytes calldata mldsaSig)
        private
        view
    {
        (address rec, ECDSA.RecoverError err,) = ECDSA.tryRecover(MessageHashUtils.toEthSignedMessageHash(digest), ecdsaSig);
        if (err != ECDSA.RecoverError.NoError || rec != k.ecdsaSigner) revert BadEcdsaPoP();
        if (!_mldsaOk(k, digest, mldsaSig)) revert BadMldsaPoP();
    }

    function _mldsaOk(DeviceKey memory k, bytes32 digest, bytes calldata sig) private view returns (bool) {
        Suite storage s = suites[k.suite];
        if (!s.enabled) revert SuiteDisabled(k.suite);
        // Both external targets are pinned by code hash (SAFETY.md 3.1 (3), 3.2).
        if (s.verifier.codehash != s.verifierCodehash) revert VerifierSwapped();
        if (k.pkBlob.codehash != k.pkBlobCodehash) revert BadBlob();
        try IMLDSA(s.verifier).verify(k.pkBlob, abi.encodePacked(digest), sig) returns (bool ok) {
            return ok;
        } catch {
            return false;
        }
    }
}
