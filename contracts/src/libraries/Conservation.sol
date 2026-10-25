// SPDX-License-Identifier: MIT
pragma solidity 0.8.30;

/// @title Conservation
/// @notice The arithmetic of one assay for one element, kept pure so it can be
///         proven symbolically (test/halmos) as well as fuzzed.
///
///         Given the metal still pending in a batch, an assay splits it into
///         recovered + loss + residual. Two rules:
///           1. exact balance:   recovered + loss + residual == pending
///           2. physical bound:  recovered <= (pending - residual) * maxBps / 10000
library Conservation {
    uint256 internal constant BPS = 10_000;

    error Unbalanced(uint8 element);
    error OverCeiling(uint8 element);

    /// @return processed metal actually put through the process in this assay
    function check(uint8 element, uint256 pending, uint256 recovered, uint256 loss, uint256 residual, uint256 maxBps)
        internal
        pure
        returns (uint256 processed)
    {
        // Each term is at most 2^64 - 1 at the call site, so the sum cannot overflow.
        if (recovered + loss + residual != pending) revert Unbalanced(element);
        processed = pending - residual;
        if (recovered * BPS > processed * maxBps) revert OverCeiling(element);
    }

    /// @notice Recovery below the legal target is recorded, never rejected.
    function belowTarget(uint256 processed, uint256 recovered, uint256 targetBps) internal pure returns (bool) {
        return processed != 0 && recovered * BPS < processed * targetBps;
    }
}
