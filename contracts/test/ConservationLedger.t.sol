// SPDX-License-Identifier: MIT
pragma solidity 0.8.30;

import {KutleTest} from "./utils/KutleTest.sol";
import {ConservationLedger} from "../src/ConservationLedger.sol";
import {PassportRegistry} from "../src/PassportRegistry.sol";
import {DeviceRegistry} from "../src/DeviceRegistry.sol";
import {Conservation} from "../src/libraries/Conservation.sol";

abstract contract LedgerFixture is KutleTest {
    uint256 internal deviceNonce;

    /// Device cryptography is covered elsewhere; here only ownership matters.
    function issueMockPassport(uint64[4] memory comp) internal returns (uint256 id) {
        bytes32 deviceId = keccak256(abi.encode("mock-device", ++deviceNonce));
        vm.mockCall(address(devices), abi.encodeCall(DeviceRegistry.operatorOf, (deviceId)), abi.encode(manufacturer));
        PassportRegistry.IssueParams memory p = PassportRegistry.IssueParams({
            deviceId: deviceId,
            category: 1,
            massGrams: 400_000,
            capacityWh: 60_000,
            composition: comp,
            dataHash: bytes32(deviceNonce),
            gs1Hash: keccak256(abi.encode("gs1", deviceNonce)),
            uri: ""
        });
        vm.prank(manufacturer);
        id = passports.issue(p);
    }

    function comp(uint64 co, uint64 li, uint64 ni, uint64 pb) internal pure returns (uint64[4] memory c) {
        c[0] = co;
        c[1] = li;
        c[2] = ni;
        c[3] = pb;
    }

    function openWith(uint256[] memory ids) internal returns (uint256 batchId) {
        vm.startPrank(recycler);
        batchId = ledger.openBatch();
        ledger.intake(batchId, ids);
        vm.stopPrank();
    }

    function assay(uint256 batchId, uint64[4] memory rec, uint64[4] memory loss, uint64[4] memory res, uint32 nonce)
        internal
        view
        returns (ConservationLedger.Assay memory a)
    {
        a = ConservationLedger.Assay({
            batchId: batchId,
            recovered: rec,
            loss: loss,
            residual: res,
            reportHash: keccak256(abi.encode("assay report", batchId, nonce)),
            lab: lab,
            nonce: nonce,
            deadline: uint64(block.timestamp + 1 days)
        });
    }

    function sign(uint256 key, ConservationLedger.Assay memory a) internal view returns (bytes memory) {
        (uint8 v, bytes32 r, bytes32 s) = vm.sign(key, ledger.assayDigest(a));
        return abi.encodePacked(r, s, v);
    }

    function settle(ConservationLedger.Assay memory a) internal {
        ledger.settle(a, sign(recyclerKey, a), sign(labKey, a));
    }
}

contract ConservationLedgerTest is LedgerFixture {
    uint256 internal p1;
    uint256 internal p2;
    uint256 internal batchId;

    function setUp() public override {
        super.setUp();
        p1 = issueMockPassport(comp(4_500, 6_000, 36_000, 0));
        p2 = issueMockPassport(comp(3_000, 5_000, 30_000, 0));
        uint256[] memory ids = new uint256[](2);
        ids[0] = p1;
        ids[1] = p2;
        batchId = openWith(ids);
    }

    function test_intakeClosesPassportsAndFixesInput() public view {
        ConservationLedger.Batch memory b = ledger.batch(batchId);
        assertEq(b.input[0], 7_500);
        assertEq(b.input[2], 66_000);
        assertEq(b.pending[1], 11_000);
        assertEq(passports.statusOf(p1), passports.RECYCLED());
        assertEq(passports.passport(p2).recyclerBatch, batchId);
    }

    function test_coSignedAssayBalances() public {
        // Co 95% recovered, Li 60%, Ni 96%.
        settle(assay(batchId, comp(7_125, 6_600, 63_360, 0), comp(375, 4_400, 2_640, 0), comp(0, 0, 0, 0), 0));
        ConservationLedger.Batch memory b = ledger.batch(batchId);
        for (uint8 e; e < 4; ++e) {
            assertEq(uint256(b.input[e]), uint256(b.recovered[e]) + b.loss[e] + b.pending[e], "input = recovered + loss + pending");
        }
        assertEq(b.issuable[0], 7_125);
        assertEq(b.assayCount, 1);
    }

    function test_unbalancedAssayIsRefused() public {
        ConservationLedger.Assay memory a = assay(batchId, comp(7_125, 6_600, 63_360, 0), comp(374, 4_400, 2_640, 0), comp(0, 0, 0, 0), 0);
        bytes memory rs = sign(recyclerKey, a);
        bytes memory ls = sign(labKey, a);
        vm.expectRevert(abi.encodeWithSelector(Conservation.Unbalanced.selector, 0));
        ledger.settle(a, rs, ls);
    }

    function test_recoveryAboveThePhysicalCeilingIsRefusedEvenWhenBothSign() public {
        // 100% cobalt recovery: balanced, signed by recycler and lab, still refused.
        ConservationLedger.Assay memory a = assay(batchId, comp(7_500, 6_600, 63_360, 0), comp(0, 4_400, 2_640, 0), comp(0, 0, 0, 0), 0);
        bytes memory rs = sign(recyclerKey, a);
        bytes memory ls = sign(labKey, a);
        vm.expectRevert(abi.encodeWithSelector(Conservation.OverCeiling.selector, 0));
        ledger.settle(a, rs, ls);
    }

    /// The attack that works on a cap-only mass balance: declare more output
    /// than went in. Here input is fixed by closed passports, so the books
    /// cannot balance.
    function test_claimingMoreThanTheBatteriesHeldIsRefused() public {
        ConservationLedger.Assay memory a = assay(batchId, comp(9_000, 6_600, 63_360, 0), comp(0, 4_400, 2_640, 0), comp(0, 0, 0, 0), 0);
        bytes memory rs = sign(recyclerKey, a);
        bytes memory ls = sign(labKey, a);
        vm.expectRevert(); // 9,000 g cannot balance against 7,500 g of input
        ledger.settle(a, rs, ls);
    }

    /// Hiding recovered metal as "unprocessed" and then claiming it later as
    /// 100% recovery does not work: the ceiling applies to each pass.
    function test_residualCannotLaunderPastTheCeiling() public {
        // First pass: 7,000 g processed at exactly the 99% ceiling, 500 g held back.
        settle(assay(batchId, comp(6_930, 0, 0, 0), comp(70, 0, 0, 0), comp(500, 11_000, 66_000, 0), 0));
        // Second pass claims the held-back 500 g at 100%: refused.
        ConservationLedger.Assay memory a = assay(batchId, comp(500, 0, 0, 0), comp(0, 0, 0, 0), comp(0, 11_000, 66_000, 0), 1);
        bytes memory rs = sign(recyclerKey, a);
        bytes memory ls = sign(labKey, a);
        vm.expectRevert(abi.encodeWithSelector(Conservation.OverCeiling.selector, 0));
        ledger.settle(a, rs, ls);
    }

    function test_partialAssaysInSequence() public {
        settle(assay(batchId, comp(3_500, 0, 0, 0), comp(100, 0, 0, 0), comp(3_900, 11_000, 66_000, 0), 0));
        settle(assay(batchId, comp(3_700, 6_000, 63_000, 0), comp(200, 5_000, 3_000, 0), comp(0, 0, 0, 0), 1));
        ConservationLedger.Batch memory b = ledger.batch(batchId);
        assertEq(b.recovered[0], 7_200);
        assertEq(b.pending[0], 0);
        assertEq(b.assayCount, 2);
    }

    function test_replayedAssayIsRefused() public {
        ConservationLedger.Assay memory a = assay(batchId, comp(3_500, 0, 0, 0), comp(100, 0, 0, 0), comp(3_900, 11_000, 66_000, 0), 0);
        bytes memory rs = sign(recyclerKey, a);
        bytes memory ls = sign(labKey, a);
        ledger.settle(a, rs, ls);
        vm.expectRevert(abi.encodeWithSelector(ConservationLedger.WrongNonce.selector, 1, 0));
        ledger.settle(a, rs, ls);
    }

    function test_expiredAssayIsRefused() public {
        ConservationLedger.Assay memory a = assay(batchId, comp(7_125, 6_600, 63_360, 0), comp(375, 4_400, 2_640, 0), comp(0, 0, 0, 0), 0);
        bytes memory rs = sign(recyclerKey, a);
        bytes memory ls = sign(labKey, a);
        vm.warp(a.deadline + 1);
        vm.expectRevert(ConservationLedger.Expired.selector);
        ledger.settle(a, rs, ls);
    }

    function test_unaccreditedLabIsRefused() public {
        vm.prank(admin);
        ledger.setLab(lab, false, bytes32(0));
        ConservationLedger.Assay memory a = assay(batchId, comp(7_125, 6_600, 63_360, 0), comp(375, 4_400, 2_640, 0), comp(0, 0, 0, 0), 0);
        bytes memory rs = sign(recyclerKey, a);
        bytes memory ls = sign(labKey, a);
        vm.expectRevert(ConservationLedger.LabNotAccredited.selector);
        ledger.settle(a, rs, ls);
    }

    function test_labSignatureFromAnotherKeyIsRefused() public {
        ConservationLedger.Assay memory a = assay(batchId, comp(7_125, 6_600, 63_360, 0), comp(375, 4_400, 2_640, 0), comp(0, 0, 0, 0), 0);
        bytes memory rs = sign(recyclerKey, a);
        bytes memory forged = sign(0xBAD, a);
        vm.expectRevert(ConservationLedger.BadLabSignature.selector);
        ledger.settle(a, rs, forged);
    }

    function test_recyclerSignatureIsRequired() public {
        ConservationLedger.Assay memory a = assay(batchId, comp(7_125, 6_600, 63_360, 0), comp(375, 4_400, 2_640, 0), comp(0, 0, 0, 0), 0);
        bytes memory ls = sign(labKey, a);
        vm.expectRevert(ConservationLedger.BadRecyclerSignature.selector);
        ledger.settle(a, ls, ls);
    }

    function test_batteryCannotFeedTwoBatches() public {
        uint256[] memory ids = new uint256[](1);
        ids[0] = p1;
        vm.startPrank(recycler);
        uint256 b2 = ledger.openBatch();
        vm.expectRevert(abi.encodeWithSelector(PassportRegistry.NotActive.selector, p1));
        ledger.intake(b2, ids);
        vm.stopPrank();
    }

    function test_noIntakeAfterTheFirstAssay() public {
        settle(assay(batchId, comp(3_500, 0, 0, 0), comp(100, 0, 0, 0), comp(3_900, 11_000, 66_000, 0), 0));
        uint256[] memory ids = new uint256[](1);
        ids[0] = issueMockPassport(comp(1, 1, 1, 0));
        vm.prank(recycler);
        vm.expectRevert(ConservationLedger.BatchAlreadyAssayed.selector);
        ledger.intake(batchId, ids);
    }

    function test_belowTargetRecoveryIsRecordedNotRejected() public {
        // Lithium at 40% is under the 50% target for 2027: accepted and flagged.
        vm.recordLogs();
        settle(assay(batchId, comp(7_125, 4_400, 63_360, 0), comp(375, 6_600, 2_640, 0), comp(0, 0, 0, 0), 0));
        assertEq(ledger.batch(batchId).recovered[1], 4_400);
    }

    // ------------------------------------------------------------------- notes

    function test_issueNotesOutOfRecoveredMetal() public {
        settle(assay(batchId, comp(7_125, 6_600, 63_360, 0), comp(375, 4_400, 2_640, 0), comp(0, 0, 0, 0), 0));
        uint64[] memory grams = new uint64[](2);
        grams[0] = 3_000;
        grams[1] = 2_000;
        uint256[] memory owners = new uint256[](2);
        owners[0] = 111;
        owners[1] = 222;
        uint256 rootBefore = pool.currentRoot();
        vm.prank(recycler);
        ledger.issueNotes(batchId, 0, grams, owners);
        ConservationLedger.Batch memory b = ledger.batch(batchId);
        assertEq(b.issued[0], 5_000);
        assertEq(b.issuable[0], 2_125);
        assertEq(pool.nextIndex(), 2);
        assertTrue(pool.currentRoot() != rootBefore);
    }

    function test_cannotIssueMoreThanRecovered() public {
        settle(assay(batchId, comp(7_125, 6_600, 63_360, 0), comp(375, 4_400, 2_640, 0), comp(0, 0, 0, 0), 0));
        uint64[] memory grams = new uint64[](1);
        grams[0] = 7_126;
        uint256[] memory owners = new uint256[](1);
        vm.prank(recycler);
        vm.expectRevert(abi.encodeWithSelector(ConservationLedger.OverIssuable.selector, 0));
        ledger.issueNotes(batchId, 0, grams, owners);
    }

    function test_onlyTheBatchOwnerIssues() public {
        settle(assay(batchId, comp(7_125, 6_600, 63_360, 0), comp(375, 4_400, 2_640, 0), comp(0, 0, 0, 0), 0));
        uint64[] memory grams = new uint64[](1);
        grams[0] = 1;
        uint256[] memory owners = new uint256[](1);
        vm.expectRevert(ConservationLedger.NotRecycler.selector);
        ledger.issueNotes(batchId, 0, grams, owners);
    }

    function test_withdrawnRecyclerRoleStopsIssuance() public {
        settle(assay(batchId, comp(7_125, 6_600, 63_360, 0), comp(375, 4_400, 2_640, 0), comp(0, 0, 0, 0), 0));
        bytes32 role = ledger.RECYCLER_ROLE();
        vm.prank(admin);
        ledger.revokeRole(role, recycler);
        uint64[] memory grams = new uint64[](1);
        grams[0] = 1;
        uint256[] memory owners = new uint256[](1);
        vm.prank(recycler);
        vm.expectRevert(ConservationLedger.NotRecycler.selector);
        ledger.issueNotes(batchId, 0, grams, owners);
    }

    // -------------------------------------------------------------- revocation

    function test_revokingAnInputBatteryFreezesTheBatch() public {
        vm.prank(authority);
        passports.revoke(p2, "counterfeit cells");
        assertTrue(ledger.batch(batchId).tainted);

        ConservationLedger.Assay memory a = assay(batchId, comp(7_125, 6_600, 63_360, 0), comp(375, 4_400, 2_640, 0), comp(0, 0, 0, 0), 0);
        bytes memory rs = sign(recyclerKey, a);
        bytes memory ls = sign(labKey, a);
        vm.expectRevert(ConservationLedger.BatchTainted.selector);
        ledger.settle(a, rs, ls);
    }

    function test_revocationAfterAssayFreezesUnissuedMetal() public {
        settle(assay(batchId, comp(7_125, 6_600, 63_360, 0), comp(375, 4_400, 2_640, 0), comp(0, 0, 0, 0), 0));
        vm.prank(authority);
        passports.revoke(p1, "stolen pack");
        uint64[] memory grams = new uint64[](1);
        grams[0] = 1;
        uint256[] memory owners = new uint256[](1);
        vm.prank(recycler);
        vm.expectRevert(ConservationLedger.BatchTainted.selector);
        ledger.issueNotes(batchId, 0, grams, owners);
    }

    function test_onlyPassportRegistryCanTaint() public {
        vm.expectRevert();
        ledger.taint(batchId, p1);
    }
}
