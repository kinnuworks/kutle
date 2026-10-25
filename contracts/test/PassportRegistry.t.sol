// SPDX-License-Identifier: MIT
pragma solidity 0.8.30;

import {KutleTest} from "./utils/KutleTest.sol";
import {PassportRegistry} from "../src/PassportRegistry.sol";
import {ModelRegistry} from "../src/ModelRegistry.sol";
import {GradeRule} from "./halmos/Symbolic.t.sol";

contract PassportRegistryTest is KutleTest {
    uint256 internal pid;
    bytes32 internal batch0;

    function setUp() public override {
        super.setUp();
        pid = setUpDeviceAndPassport();
        registerModel();
        batch0 = anchorFixtureBatch(0);
    }

    // ------------------------------------------------------------------ issue

    function test_issueRecordsTheOnChainCore() public view {
        PassportRegistry.Passport memory p = passports.passport(pid);
        assertEq(p.operator, manufacturer);
        assertEq(p.deviceId, deviceA());
        assertEq(p.status, passports.ACTIVE());
        assertEq(p.composition[2], 36_000);
        assertEq(passports.passportOfDevice(deviceA()), pid);
        assertEq(passports.deviceOf(pid), deviceA());
    }

    function test_cannotIssueForSomeoneElsesDevice() public {
        registerFixtureDevice("keyB1", deviceB(), makeAddr("otherMaker"));
        vm.expectRevert(PassportRegistry.DeviceNotOperated.selector);
        issuePassport(deviceB(), keccak256("gs1:B"));
    }

    function test_oneDeviceOnePassport() public {
        vm.expectRevert(PassportRegistry.DeviceInUse.selector);
        issuePassport(deviceA(), keccak256("gs1:A2"));
    }

    function test_gs1IdentifierIsUnique() public {
        registerFixtureDevice("keyB1", deviceB(), manufacturer);
        vm.expectRevert(PassportRegistry.Gs1InUse.selector);
        issuePassport(deviceB(), keccak256("gs1:A"));
    }

    // ----------------------------------------------------------------- health

    function test_gradeIsComputedOnChainFromTheInterval() public {
        vm.prank(grader);
        uint8 g = passports.recordHealth(pid, batch0, MODEL_ID, 9_410, 9_150, 9_620, 1_840);
        assertEq(g, passports.GRADE_REUSE());
        PassportRegistry.Health memory h = passports.health(pid);
        assertEq(h.sohBps, 9_410);
        assertEq(h.readingBatch, batch0);
        assertEq(h.modelId, MODEL_ID);
    }

    function test_gradeTable() public view {
        assertEq(passports.gradeFor(8_000, 8_900), passports.GRADE_REUSE());
        assertEq(passports.gradeFor(7_999, 8_600), passports.GRADE_REPURPOSE());
        assertEq(passports.gradeFor(6_000, 6_900), passports.GRADE_REPURPOSE());
        assertEq(passports.gradeFor(5_900, 6_500), passports.GRADE_BENCH_TEST());
        assertEq(passports.gradeFor(7_000, 8_200), passports.GRADE_BENCH_TEST()); // too wide
        assertEq(passports.gradeFor(4_000, 5_999), passports.GRADE_RECYCLE());
    }

    /// Narrowing the interval never makes a pack look worse, and a pack whose
    /// whole interval sits below 60% is always sent to recycling.
    function testFuzz_gradeIsConsistent(uint16 lo, uint16 hi) public view {
        lo = uint16(bound(lo, 0, 12_000));
        hi = uint16(bound(hi, lo, 12_000));
        uint8 g = passports.gradeFor(lo, hi);
        if (hi < 6_000) assertEq(g, passports.GRADE_RECYCLE());
        if (g == passports.GRADE_REUSE()) assertGe(lo, 8_000);
        if (g == passports.GRADE_REPURPOSE()) {
            assertGe(lo, 6_000);
            assertLe(hi - lo, 1_000);
        }
    }

    /// The copy proven symbolically in test/halmos agrees with the deployed rule.
    function testFuzz_provenCopyMatchesDeployedRule(uint16 lo, uint16 hi) public view {
        lo = uint16(bound(lo, 0, 12_000));
        hi = uint16(bound(hi, lo, 12_000));
        assertEq(GradeRule.gradeFor(lo, hi), passports.gradeFor(lo, hi));
    }

    function test_gradeMustCiteThisPassportsReadings() public {
        registerFixtureDevice("keyB1", deviceB(), manufacturer);
        uint256 other = issuePassport(deviceB(), keccak256("gs1:B"));
        vm.prank(grader);
        vm.expectRevert(PassportRegistry.BatchNotForPassport.selector);
        passports.recordHealth(other, batch0, MODEL_ID, 9_000, 8_800, 9_200, 1_000);
    }

    function test_retiredModelCannotGrade() public {
        vm.prank(admin);
        models.retire(MODEL_ID);
        vm.prank(grader);
        vm.expectRevert(PassportRegistry.ModelInactive.selector);
        passports.recordHealth(pid, batch0, MODEL_ID, 9_000, 8_800, 9_200, 1_000);
    }

    function test_modelThatLosesToItsBaselineIsRefused() public {
        ModelRegistry.Model memory m;
        m.maeBps = 400;
        m.baselineMaeBps = 320;
        m.coverageBps = 9_000;
        vm.prank(admin);
        vm.expectRevert(abi.encodeWithSelector(ModelRegistry.DoesNotBeatBaseline.selector, 400, 320));
        models.register(keccak256("bad-model"), m);
    }

    function test_badIntervalIsRefused() public {
        vm.prank(grader);
        vm.expectRevert(PassportRegistry.BadInterval.selector);
        passports.recordHealth(pid, batch0, MODEL_ID, 9_000, 9_100, 9_200, 1_000);
    }

    // ------------------------------------------------------------ second life

    function _gradeForRepurpose() internal {
        vm.prank(grader);
        passports.recordHealth(pid, batch0, MODEL_ID, 7_400, 7_050, 7_700, 600);
    }

    function test_repurposeLinksLineageAndBooksAvoidedEmissions() public {
        _gradeForRepurpose();
        uint8 industrial = passports.CAT_INDUSTRIAL();
        vm.prank(repurposer);
        uint256 child = passports.repurpose(
            pid, secondLifeOperator, deviceA(), industrial, 42_000,
            keccak256("second-life-json"), keccak256("gs1:A:second-life"), "ipfs://child"
        );
        PassportRegistry.Passport memory parent = passports.passport(pid);
        PassportRegistry.Passport memory c = passports.passport(child);
        assertEq(parent.status, passports.REPURPOSED());
        assertEq(parent.childId, child);
        assertEq(c.parentId, pid);
        assertEq(c.operator, secondLifeOperator);
        assertEq(c.composition[0], parent.composition[0]);
        assertEq(passports.deviceOf(child), deviceA());
        assertEq(passports.deviceOf(pid), bytes32(0));

        // 60,000 Wh x 70.5% = 42,300 Wh retained; 58-92 g CO2e per Wh avoided.
        assertEq(passports.avoidedGramsLow(), 42_300 * 58);
        assertEq(passports.avoidedGramsHigh(), 42_300 * 92);
        assertEq(passports.avoidedGramsAllocLow(), (42_300 * 58 * 1_500) / 10_000);
        assertEq(passports.avoidedGramsAllocHigh(), (42_300 * 92 * 2_900) / 10_000);
    }

    function test_repurposeNeedsAFreshGrade() public {
        _gradeForRepurpose();
        vm.warp(block.timestamp + passports.GRADE_TTL() + 1);
        vm.prank(repurposer);
        vm.expectRevert(PassportRegistry.GradeStale.selector);
        passports.repurpose(pid, secondLifeOperator, deviceA(), 3, 42_000, bytes32(0), keccak256("x"), "");
    }

    function test_repurposeRefusedForARecycleGrade() public {
        vm.prank(grader);
        passports.recordHealth(pid, batch0, MODEL_ID, 5_200, 5_000, 5_500, 0);
        uint8 recycleGrade = passports.GRADE_RECYCLE();
        vm.prank(repurposer);
        vm.expectRevert(abi.encodeWithSelector(PassportRegistry.GradeDoesNotAllow.selector, recycleGrade));
        passports.repurpose(pid, secondLifeOperator, deviceA(), 3, 42_000, bytes32(0), keccak256("x"), "");
    }

    // ------------------------------------------------------------- revocation

    function test_revocationCascadesDownTheLineage() public {
        _gradeForRepurpose();
        vm.prank(repurposer);
        uint256 child = passports.repurpose(pid, secondLifeOperator, deviceA(), 3, 42_000, bytes32(0), keccak256("x"), "");
        vm.prank(authority);
        passports.revoke(pid, "counterfeit cells");
        assertEq(passports.statusOf(pid), passports.REVOKED());
        assertEq(passports.statusOf(child), passports.REVOKED());
        assertEq(passports.deviceOf(child), bytes32(0));
    }

    function test_onlyAuthorityRevokes() public {
        vm.expectRevert();
        passports.revoke(pid, "x");
    }

    // -------------------------------------------------------- recycled content

    function test_onlyTheNotePoolAddsRecycledContent() public {
        vm.expectRevert();
        passports.addRecycledContent(pid, 0, 100);
    }

    function test_recycledContentCannotExceedComposition() public {
        vm.startPrank(address(pool));
        passports.addRecycledContent(pid, 0, 4_500);
        vm.expectRevert(abi.encodeWithSelector(PassportRegistry.ExceedsComposition.selector, 0));
        passports.addRecycledContent(pid, 0, 1);
        vm.stopPrank();
        assertEq(passports.recycledShareBps(pid, 0), 10_000);
    }

    function test_lockedRecycledContentCannotChange() public {
        vm.prank(manufacturer);
        passports.lockRecycledContent(pid);
        vm.prank(address(pool));
        vm.expectRevert(PassportRegistry.RecycledLocked.selector);
        passports.addRecycledContent(pid, 0, 100);
    }

    function test_meetsMinimumByYear() public {
        vm.startPrank(address(pool));
        passports.addRecycledContent(pid, 0, 720); // 16.0% of 4,500 g cobalt
        passports.addRecycledContent(pid, 1, 360); // 6.0% of 6,000 g lithium
        passports.addRecycledContent(pid, 2, 2_160); // 6.0% of 36,000 g nickel
        vm.stopPrank();
        assertTrue(passports.meetsMinimum(pid, 0, false));
        assertTrue(passports.meetsMinimum(pid, 1, false));
        assertTrue(passports.meetsMinimum(pid, 2, false));
        assertTrue(passports.meetsMinimum(pid, 3, false)); // no lead in this pack
        assertFalse(passports.meetsMinimum(pid, 0, true)); // 2036 needs 26%
    }
}
