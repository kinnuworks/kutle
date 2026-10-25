// SPDX-License-Identifier: MIT
pragma solidity 0.8.30;

import {LedgerFixture} from "./ConservationLedger.t.sol";
import {NotePool} from "../src/NotePool.sol";
import {ConservationLedger} from "../src/ConservationLedger.sol";

contract NotePoolTest is LedgerFixture {
    uint256 internal target; // passport receiving recycled content
    uint256 internal constant SOURCE_COBALT = 7_500;

    function setUp() public override {
        super.setUp();
        // A recycler batch with assayed cobalt, issued as two notes.
        uint256[] memory ids = new uint256[](1);
        ids[0] = issueMockPassport(comp(uint64(SOURCE_COBALT), 6_000, 36_000, 0));
        uint256 batchId = openWith(ids);
        settle(assay(batchId, comp(7_125, 3_600, 34_560, 0), comp(375, 2_400, 1_440, 0), comp(0, 0, 0, 0), 0));
        uint64[] memory grams = new uint64[](2);
        grams[0] = 3_000;
        grams[1] = 2_000;
        uint256[] memory owners = new uint256[](2);
        owners[0] = 1001;
        owners[1] = 1002;
        vm.prank(recycler);
        ledger.issueNotes(batchId, 0, grams, owners);

        target = issueMockPassport(comp(28_000, 6_000, 36_000, 0));
    }

    function _pub(uint256 root, uint8 element, uint256 passportId, uint64 grams, uint256[4] memory nf, uint256 change)
        internal
        view
        returns (bytes32[] memory p)
    {
        p = new bytes32[](10);
        p[0] = bytes32(root);
        p[1] = bytes32(uint256(element));
        p[2] = bytes32(passportId);
        p[3] = bytes32(uint256(grams));
        for (uint256 i; i < 4; ++i) p[4 + i] = bytes32(nf[i]);
        p[8] = bytes32(change);
        p[9] = bytes32(pool.binding());
    }

    function _nf(uint256 a, uint256 b) internal pure returns (uint256[4] memory n) {
        n[0] = a;
        n[1] = b;
    }

    function test_zeroTreeMatchesPoseidon() public view {
        uint256 z = 0;
        for (uint256 i; i < 16; ++i) {
            assertEq(pool.zeros(i), z);
            z = poseidon.hash_2(z, z);
        }
    }

    function test_leafIsComputedOnChain() public view {
        // The recycler cannot pick the leaf: it is Poseidon2(element, grams, ownerCommit).
        uint256 leaf0 = poseidon.hash_3(0, 3_000, 1001);
        uint256 leaf1 = poseidon.hash_3(0, 2_000, 1002);
        uint256 root = poseidon.hash_2(leaf0, leaf1);
        for (uint256 i = 1; i < 16; ++i) root = poseidon.hash_2(root, pool.zeros(i));
        assertEq(pool.currentRoot(), root);
    }

    function test_spendAddsRecycledContent() public {
        uint256 root = pool.currentRoot();
        uint256[4] memory nf = _nf(77, 88);
        uint256 change = 999;
        bytes memory proof = spendVerifier.proofFor(_pub(root, 0, target, 4_500, nf, change));
        vm.prank(manufacturer);
        pool.spend(target, 0, 4_500, root, nf, change, proof);
        assertEq(passports.passport(target).recycled[0], 4_500);
        assertTrue(pool.nullifierSpent(77));
        assertTrue(pool.nullifierSpent(88));
        assertEq(pool.nextIndex(), 3); // change note appended
        assertTrue(pool.isKnownRoot(root)); // older roots stay valid for in-flight proofs
    }

    function test_doubleSpendIsRefused() public {
        uint256 root = pool.currentRoot();
        uint256[4] memory nf = _nf(77, 0);
        bytes memory proof = spendVerifier.proofFor(_pub(root, 0, target, 1_000, nf, 0));
        vm.startPrank(manufacturer);
        pool.spend(target, 0, 1_000, root, nf, 0, proof);
        vm.expectRevert(abi.encodeWithSelector(NotePool.NullifierUsed.selector, 77));
        pool.spend(target, 0, 1_000, root, nf, 0, proof);
        vm.stopPrank();
    }

    function test_sameNullifierTwiceInOneSpendIsRefused() public {
        uint256 root = pool.currentRoot();
        uint256[4] memory nf = _nf(77, 77);
        bytes memory proof = spendVerifier.proofFor(_pub(root, 0, target, 1_000, nf, 0));
        vm.prank(manufacturer);
        vm.expectRevert(NotePool.DuplicateNullifier.selector);
        pool.spend(target, 0, 1_000, root, nf, 0, proof);
    }

    function test_proofForOtherPublicInputsIsRefused() public {
        uint256 root = pool.currentRoot();
        uint256[4] memory nf = _nf(77, 0);
        bytes memory proof = spendVerifier.proofFor(_pub(root, 0, target, 1_000, nf, 0));
        vm.prank(manufacturer);
        vm.expectRevert(NotePool.BadProof.selector);
        pool.spend(target, 0, 1_001, root, nf, 0, proof); // one gram more than proven
    }

    function test_unknownRootIsRefused() public {
        uint256[4] memory nf = _nf(77, 0);
        vm.prank(manufacturer);
        vm.expectRevert(NotePool.UnknownRoot.selector);
        pool.spend(target, 0, 1_000, 12345, nf, 0, "");
    }

    function test_onlyThePassportOperatorSpends() public {
        uint256 root = pool.currentRoot();
        uint256[4] memory nf = _nf(77, 0);
        bytes memory proof = spendVerifier.proofFor(_pub(root, 0, target, 1_000, nf, 0));
        vm.expectRevert(NotePool.NotOperator.selector);
        pool.spend(target, 0, 1_000, root, nf, 0, proof);
    }

    function test_cannotBackMoreMetalThanTheBatteryHolds() public {
        uint256 root = pool.currentRoot();
        uint256[4] memory nf = _nf(77, 0);
        bytes memory proof = spendVerifier.proofFor(_pub(root, 0, target, 28_001, nf, 0));
        vm.prank(manufacturer);
        vm.expectRevert();
        pool.spend(target, 0, 28_001, root, nf, 0, proof);
    }

    function test_onlyTheLedgerMints() public {
        vm.expectRevert(NotePool.NotLedger.selector);
        pool.mintNote(0, 1, 1);
    }

    function test_noInputsIsRefused() public {
        uint256 root = pool.currentRoot();
        uint256[4] memory nf;
        vm.prank(manufacturer);
        vm.expectRevert(NotePool.NoInputs.selector);
        pool.spend(target, 0, 1, root, nf, 0, "");
    }

    function test_mintGas() public {
        vm.startSnapshotGas("mintNote");
        vm.prank(address(ledger));
        pool.mintNote(0, 500, 4242);
        emit log_named_uint("mintNote gas (16 Poseidon2 hashes)", vm.stopSnapshotGas());
    }
}
