// SPDX-License-Identifier: MIT
pragma solidity 0.8.30;

import {Test} from "forge-std/Test.sol";
import {Conservation} from "../../src/libraries/Conservation.sol";

/// Thin external wrapper so a revert inside the library is observable.
contract ConservationHarness {
    function check(uint256 pending, uint256 rec, uint256 loss, uint256 res, uint256 maxBps)
        external
        pure
        returns (uint256)
    {
        return Conservation.check(0, pending, rec, loss, res, maxBps);
    }
}

/// The grading rule from PassportRegistry, copied verbatim so it can be proven
/// without deploying the registry. test/PassportRegistry.t.sol checks the copy
/// agrees with the deployed contract.
library GradeRule {
    function gradeFor(uint16 lowBps, uint16 highBps) internal pure returns (uint8) {
        if (highBps < 6_000) return 4;
        if (highBps - lowBps > 1_000) return 3;
        if (lowBps >= 8_000) return 1;
        if (lowBps >= 6_000) return 2;
        return 3;
    }
}

/// Symbolic proofs, run with `halmos --contract SymbolicTest`. Every check_
/// function is proven for all inputs, not sampled. Foundry also runs them as
/// fuzz tests (test_ wrappers below), so they cannot silently rot.
contract SymbolicTest is Test {
    ConservationHarness internal h;

    function setUp() public {
        h = new ConservationHarness();
    }

    /// One assay: if it is accepted, mass balances exactly and recovery stays
    /// under the ceiling applied to what was actually processed.
    function check_assayAcceptedImpliesConservation(uint64 pending, uint64 rec, uint64 loss, uint64 res, uint16 maxBps)
        public
        view
    {
        vm.assume(maxBps <= 10_000);
        try h.check(pending, rec, loss, res, maxBps) returns (uint256 processed) {
            assert(uint256(rec) + loss + res == pending);
            assert(processed == uint256(pending) - res);
            assert(uint256(rec) * 10_000 <= processed * maxBps);
            assert(rec <= pending);
        } catch {}
    }

    /// Two passes in a row (the second works on the first one's residual): the
    /// total recovered can never beat the ceiling on the total processed. This
    /// is the "park metal as unprocessed, then claim it at 100%" attack. Proven
    /// for both ceilings the contract uses (9,800 bps lithium, 9,900 bps the rest).
    function check_twoPassesNeverBeatTheCeiling_9900(
        uint64 pending, uint64 rec1, uint64 loss1, uint64 res1, uint64 rec2, uint64 loss2, uint64 res2
    ) public view {
        _twoPasses(pending, rec1, loss1, res1, rec2, loss2, res2, 9_900);
    }

    function check_twoPassesNeverBeatTheCeiling_9800(
        uint64 pending, uint64 rec1, uint64 loss1, uint64 res1, uint64 rec2, uint64 loss2, uint64 res2
    ) public view {
        _twoPasses(pending, rec1, loss1, res1, rec2, loss2, res2, 9_800);
    }

    function _twoPasses(
        uint64 pending,
        uint64 rec1,
        uint64 loss1,
        uint64 res1,
        uint64 rec2,
        uint64 loss2,
        uint64 res2,
        uint256 maxBps
    ) internal view {
        try h.check(pending, rec1, loss1, res1, maxBps) {
            try h.check(res1, rec2, loss2, res2, maxBps) {
                uint256 recovered = uint256(rec1) + rec2;
                uint256 processed = uint256(pending) - res2;
                assert(recovered * 10_000 <= processed * maxBps);
                assert(uint256(rec1) + rec2 + loss1 + loss2 + res2 == pending);
            } catch {}
        } catch {}
    }

    /// Induction step for any number of passes. If a batch satisfies
    /// recovered x 10,000 <= (input - pending) x ceiling before an assay, and
    /// the assay is accepted, it still does afterwards. Together with the base
    /// case (a fresh batch has nothing recovered), this covers every sequence
    /// of assays, not just two.
    function check_ceilingIsInductive_9900(uint64 input, uint64 pending, uint64 recovered, uint64 rec, uint64 loss, uint64 res)
        public
        view
    {
        _inductive(input, pending, recovered, rec, loss, res, 9_900);
    }

    function check_ceilingIsInductive_9800(uint64 input, uint64 pending, uint64 recovered, uint64 rec, uint64 loss, uint64 res)
        public
        view
    {
        _inductive(input, pending, recovered, rec, loss, res, 9_800);
    }

    function _inductive(uint64 input, uint64 pending, uint64 recovered, uint64 rec, uint64 loss, uint64 res, uint256 maxBps)
        internal
        view
    {
        vm.assume(pending <= input);
        vm.assume(uint256(recovered) * 10_000 <= (uint256(input) - pending) * maxBps);
        try h.check(pending, rec, loss, res, maxBps) {
            assert((uint256(recovered) + rec) * 10_000 <= (uint256(input) - res) * maxBps);
        } catch {}
    }

    /// The grading rule never sends a pack to reuse or second life on an
    /// interval it does not support.
    function check_gradeIsSound(uint16 lo, uint16 hi) public pure {
        vm.assume(lo <= hi);
        uint8 g = GradeRule.gradeFor(lo, hi);
        assert(g >= 1 && g <= 4);
        if (g == 1) assert(lo >= 8_000 && hi - lo <= 1_000);
        if (g == 2) assert(lo >= 6_000 && lo < 8_000 && hi - lo <= 1_000);
        if (hi < 6_000) assert(g == 4);
    }

    /// Raising the lower bound (more confidence the pack is healthy) never
    /// produces a worse grade, for a fixed interval width.
    function check_gradeIsMonotone(uint16 lo, uint16 width, uint16 bump) public pure {
        vm.assume(width <= 1_000);
        vm.assume(uint256(lo) + width + bump <= 12_000);
        uint8 a = GradeRule.gradeFor(lo, lo + width);
        uint8 b = GradeRule.gradeFor(lo + bump, lo + bump + width);
        // Grades 1 (reuse) < 2 (repurpose) < 3 (bench test) < 4 (recycle) by severity,
        // except that bench test sits between repurpose and recycle.
        assert(_rank(b) <= _rank(a));
    }

    function _rank(uint8 g) private pure returns (uint8) {
        if (g == 1) return 0;
        if (g == 2) return 1;
        if (g == 3) return 2;
        return 3;
    }

    // Foundry fuzz wrappers.
    function testFuzz_assay(uint64 p, uint64 r, uint64 l, uint64 s, uint16 m) public view {
        check_assayAcceptedImpliesConservation(p, r, l, s, uint16(bound(m, 0, 10_000)));
    }

    function testFuzz_twoPasses(uint64 p, uint64 r1, uint64 l1, uint64 s1, uint64 r2, uint64 l2, uint64 s2) public view {
        _twoPasses(p, r1, l1, s1, r2, l2, s2, 9_900);
    }

    function testFuzz_inductive(uint64 i, uint64 p, uint64 r, uint64 rec, uint64 l, uint64 s) public view {
        p = uint64(bound(p, 0, i));
        r = uint64(bound(r, 0, (uint256(i) - p) * 9_900 / 10_000));
        _inductive(i, p, r, rec, l, s, 9_900);
    }

    function testFuzz_grade(uint16 lo, uint16 hi) public pure {
        lo = uint16(bound(lo, 0, 12_000));
        hi = uint16(bound(hi, lo, 12_000));
        check_gradeIsSound(lo, hi);
    }

    function testFuzz_gradeMonotone(uint16 lo, uint16 w, uint16 b) public pure {
        w = uint16(bound(w, 0, 1_000));
        lo = uint16(bound(lo, 0, 10_000));
        b = uint16(bound(b, 0, 12_000 - lo - w));
        check_gradeIsMonotone(lo, w, b);
    }
}
