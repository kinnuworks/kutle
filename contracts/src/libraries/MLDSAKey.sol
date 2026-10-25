// SPDX-License-Identifier: MIT
pragma solidity 0.8.30;

/// @title MLDSAKey
/// @notice Checks on a raw FIPS 204 ML-DSA-44 public key that can run on chain.
/// @dev A key with t1 coefficients clustered near 0 or near 1023 can be forged
///      without any secret: proof-of-possession does not catch it, because such a
///      key "has every owner". This library applies the centred-lift floor from
///      lib/evm-ml-dsa-verifier/docs/SAFETY.md section 3.1 (2)(i) to the key
///      itself. It is a floor to refuse beneath, not a certificate of safety; the
///      provisioning station additionally binds every key to its KeyGen seed
///      off chain (criterion (ii)), see docs/SECURITY.md.
library MLDSAKey {
    uint256 internal constant PK_BYTES = 1312;
    uint256 internal constant RHO_BYTES = 32;
    uint256 internal constant T1_COEFFS = 1024; // k = 4 polynomials x 256
    uint256 internal constant Q = 8_380_417;
    uint256 internal constant D = 13;
    uint256 internal constant GAMMA2 = (Q - 1) / 88; // 95,232
    /// Half of the coefficients must have a large centred lift.
    uint256 internal constant MIN_LARGE = T1_COEFFS / 2;

    /// @notice Size of the prepared blob the verifier reads (prefix byte + payload).
    uint256 internal constant BLOB_CODE_SIZE = 20_545;

    error WrongKeyLength(uint256 length);
    error DegenerateKey(uint256 largeCoefficients);

    /// @notice Count t1 coefficients whose centred lift exceeds gamma2.
    function largeLiftCount(bytes calldata pk) internal pure returns (uint256 big) {
        if (pk.length != PK_BYTES) revert WrongKeyLength(pk.length);
        unchecked {
            // t1 is SimpleBitPack(t1, 2^10 - 1): every 5 bytes hold 4 coefficients,
            // least significant bits first.
            for (uint256 off = RHO_BYTES; off < PK_BYTES; off += 5) {
                uint256 b0 = uint8(pk[off]);
                uint256 b1 = uint8(pk[off + 1]);
                uint256 b2 = uint8(pk[off + 2]);
                uint256 b3 = uint8(pk[off + 3]);
                uint256 b4 = uint8(pk[off + 4]);
                big += _isLarge(b0 | ((b1 & 0x03) << 8));
                big += _isLarge((b1 >> 2) | ((b2 & 0x0f) << 6));
                big += _isLarge((b2 >> 4) | ((b3 & 0x3f) << 4));
                big += _isLarge((b3 >> 6) | (b4 << 2));
            }
        }
    }

    /// @notice Revert unless the key passes the length check and the floor.
    function requireNonDegenerate(bytes calldata pk) internal pure {
        uint256 big = largeLiftCount(pk);
        if (big < MIN_LARGE) revert DegenerateKey(big);
    }

    function _isLarge(uint256 v) private pure returns (uint256) {
        unchecked {
            // v < 1024, so v << 13 <= 8,380,416 < Q and no reduction is needed.
            uint256 t = v << D;
            uint256 absLift = t > Q / 2 ? Q - t : t;
            return absLift > GAMMA2 ? 1 : 0;
        }
    }
}
