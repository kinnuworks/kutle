// SPDX-License-Identifier: MIT
pragma solidity 0.8.30;

/// @notice Same shape as lib/evm-ml-dsa-verifier/src/IMLDSAVerifier.sol, restated
///         here so Kütle contracts compile without pulling in the verifier's
///         implementation. Only `true` counts as acceptance.
interface IMLDSA {
    function verify(address pkBlob, bytes calldata message, bytes calldata signature)
        external
        view
        returns (bool accepted);
}
