// SPDX-License-Identifier: MIT
pragma solidity 0.8.30;

/// @notice Stand-in for the generated UltraHonk verifier in unit tests. It accepts
///         a proof only if the proof bytes equal keccak256 of the public inputs, so
///         tests still fail when the contract passes the wrong public inputs.
contract MockSpendVerifier {
    function verify(bytes calldata proof, bytes32[] calldata publicInputs) external pure returns (bool) {
        return proof.length == 32 && bytes32(proof) == keccak256(abi.encodePacked(publicInputs));
    }

    function proofFor(bytes32[] memory publicInputs) external pure returns (bytes memory) {
        return abi.encodePacked(keccak256(abi.encodePacked(publicInputs)));
    }
}
