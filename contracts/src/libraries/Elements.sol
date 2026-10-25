// SPDX-License-Identifier: MIT
pragma solidity 0.8.30;

/// @title Elements
/// @notice The four metals Regulation (EU) 2023/1542 tracks for recycled content,
///         and the fixed numbers the ledger checks against. Everything here is a
///         compile-time constant on purpose: no admin can loosen a physics bound or
///         a legal threshold after deployment.
library Elements {
    uint8 internal constant COBALT = 0;
    uint8 internal constant LITHIUM = 1;
    uint8 internal constant NICKEL = 2;
    uint8 internal constant LEAD = 3;
    uint8 internal constant COUNT = 4;

    uint16 internal constant BPS = 10_000;

    error UnknownElement(uint8 element);

    /// @notice Highest share of an element a recycler can physically recover from
    ///         its input in one pass. An assay claiming more is rejected, even when
    ///         both the recycler and the lab signed it. These are engineering
    ///         ceilings, deliberately generous, so an honest plant never hits them.
    function maxRecoveryBps(uint8 element) internal pure returns (uint16) {
        if (element == COBALT) return 9_900;
        if (element == LITHIUM) return 9_800;
        if (element == NICKEL) return 9_900;
        if (element == LEAD) return 9_900;
        revert UnknownElement(element);
    }

    /// @notice Material recovery targets, Annex XII Part C, applying from
    ///         31 December 2027. Falling short is recorded, not rejected: the
    ///         regulation sanctions the recycler, it does not void the metal.
    function recoveryTarget2027Bps(uint8 element) internal pure returns (uint16) {
        if (element == COBALT) return 9_000;
        if (element == LITHIUM) return 5_000;
        if (element == NICKEL) return 9_000;
        if (element == LEAD) return 9_000;
        revert UnknownElement(element);
    }

    /// @notice Minimum recycled content, Article 8(2), from 18 August 2031.
    function minRecycledShare2031Bps(uint8 element) internal pure returns (uint16) {
        if (element == COBALT) return 1_600;
        if (element == LITHIUM) return 600;
        if (element == NICKEL) return 600;
        if (element == LEAD) return 8_500;
        revert UnknownElement(element);
    }

    /// @notice Minimum recycled content, Article 8(3), from 18 August 2036.
    function minRecycledShare2036Bps(uint8 element) internal pure returns (uint16) {
        if (element == COBALT) return 2_600;
        if (element == LITHIUM) return 1_200;
        if (element == NICKEL) return 1_500;
        if (element == LEAD) return 8_500;
        revert UnknownElement(element);
    }

    function check(uint8 element) internal pure {
        if (element >= COUNT) revert UnknownElement(element);
    }
}
