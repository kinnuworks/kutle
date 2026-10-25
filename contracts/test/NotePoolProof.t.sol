// SPDX-License-Identifier: MIT
pragma solidity 0.8.30;

import {console} from "forge-std/console.sol";
import {KutleTest} from "./utils/KutleTest.sol";
import {NotePool, IShieldedSpendVerifier, IPassportsForNotes} from "../src/NotePool.sol";
import {PassportRegistry} from "../src/PassportRegistry.sol";
import {ShieldedSpendVerifier, Errors as HonkErrors} from "../src/verifiers/ShieldedSpendVerifier.sol";

/// @notice End-to-end spend with a real UltraHonk proof from circuits/shielded_spend.
///
///         The proof in test/fixtures/zk/spend.json was produced by
///         tools/zk/fixture.mjs for this exact deployment: a NotePool at POOL_ADDR
///         on chain 31337, two cobalt notes of 3,000 g and 2,000 g minted as leaves
///         0 and 1, a declaration of 4,500 g into passport #1 and a 500 g change
///         note. NotePool's binding depends on the chain id and the pool address,
///         which is why the pool is placed with deployCodeTo.
///
///         The test contract plays the ConservationLedger, so it can mint notes
///         directly; the real ledger path is covered by the ledger's own tests.
contract NotePoolProofTest is KutleTest {
    address internal constant POOL_ADDR = 0x0000000000000000000000000000000000C0Ba17;
    uint8 internal constant COBALT = 0;

    string internal zk;
    ShieldedSpendVerifier internal honk;
    NotePool internal zpool;
    uint256 internal passportId;

    uint256 internal root;
    uint256[4] internal nullifiers;
    uint256 internal changeLeaf;
    bytes internal proof;
    bytes32[] internal publicInputs;

    function setUp() public override {
        super.setUp();
        zk = vm.readFile("test/fixtures/zk/spend.json");

        honk = new ShieldedSpendVerifier();
        zpool = deployPool(POOL_ADDR);
        assertEq(block.chainid, vm.parseJsonUint(zk, ".chainId"), "fixture chain");
        assertEq(zpool.binding(), vm.parseJsonUint(zk, ".binding"), "fixture binding");

        passportId = setUpDeviceAndPassport();

        zpool.mintNote(COBALT, 3_000, vm.parseJsonUint(zk, ".notes[0].ownerCommit"));
        zpool.mintNote(COBALT, 2_000, vm.parseJsonUint(zk, ".notes[1].ownerCommit"));

        root = vm.parseJsonUint(zk, ".root");
        uint256[] memory nf = vm.parseJsonUintArray(zk, ".nullifiers");
        for (uint256 i; i < 4; ++i) {
            nullifiers[i] = nf[i];
        }
        changeLeaf = vm.parseJsonUint(zk, ".changeLeaf");
        proof = vm.parseJsonBytes(zk, ".proof");
        publicInputs = vm.parseJsonBytes32Array(zk, ".publicInputs");
    }

    function deployPool(address at) internal returns (NotePool p) {
        deployCodeTo(
            "NotePool.sol:NotePool",
            abi.encode(poseidon, IShieldedSpendVerifier(address(honk)), IPassportsForNotes(address(passports)), address(this)),
            at
        );
        p = NotePool(at);
        vm.startPrank(admin);
        passports.grantRole(passports.NOTEPOOL_ROLE(), at);
        vm.stopPrank();
    }

    function spendAs(address who, NotePool p, uint256 id, uint64 grams, uint256 r, uint256[4] memory nf, uint256 change)
        internal
    {
        vm.prank(who);
        p.spend(id, COBALT, grams, r, nf, change, proof);
    }

    /// The verifier signals a bad proof either by reverting (sumcheck or
    /// Shplemini failure) or by returning false, which NotePool turns into
    /// BadProof. Accept exactly those and nothing else.
    function expectProofRejected(NotePool p, uint256 id, uint64 grams, uint256 r, uint256[4] memory nf, uint256 change)
        internal
    {
        vm.prank(manufacturer);
        (bool ok, bytes memory ret) =
            address(p).call(abi.encodeCall(NotePool.spend, (id, COBALT, grams, r, nf, change, proof)));
        assertFalse(ok, "spend accepted");
        bytes4 sel = bytes4(ret);
        assertTrue(
            sel == NotePool.BadProof.selector || sel == HonkErrors.SumcheckFailed.selector
                || sel == HonkErrors.ShpleminiFailed.selector,
            "rejected for some other reason"
        );
    }

    // ------------------------------------------------------------ poseidon2

    /// The circuit's Poseidon2 (noir-lang/poseidon v0.4.0) and the deployed
    /// Poseidon2Yul_BN254 agree. The literals are the ones asserted in the Noir
    /// test hash_vectors and printed by `nargo test --show-output`.
    function test_poseidonMatchesCircuit() public view {
        assertEq(poseidon.hash_2(1, 2), 0x038682aa1cb5ae4e0a3f13da432a95c77c5c111f6f030faf9cad641ce1ed7383);
        assertEq(poseidon.hash_2(0, 0), 0x0b63a53787021a4a962a452c2921b3663aff1ffd8d5510540f8e659e782956f1);
        assertEq(poseidon.hash_3(1, 2, 3), 0x23864adb160dddf590f1d3303683ebcb914f828e2635f6e85a32f0a1aecd3dd8);
        assertEq(poseidon.hash_3(0, 4500, 0x1234), 0x2a855ed748ed613b8481966fc9dadf2a9d86c20d1d97bafb854c8163989a7a65);

        // Same values from the JS mirror in tools/zk/poseidon2.mjs.
        assertEq(poseidon.hash_2(1, 2), vm.parseJsonUint(zk, ".poseidon.h2_1_2"));
        assertEq(poseidon.hash_3(0, 4500, 0x1234), vm.parseJsonUint(zk, ".poseidon.h3_0_4500_0x1234"));
    }

    /// Leaves, the tree and the root the prover used match what the pool built.
    function test_treeMatchesProver() public view {
        assertEq(zpool.isKnownRoot(vm.parseJsonUint(zk, ".emptyRoot")), true);
        assertEq(zpool.currentRoot(), root);
        assertEq(
            poseidon.hash_3(COBALT, 3_000, vm.parseJsonUint(zk, ".notes[0].ownerCommit")),
            vm.parseJsonUint(zk, ".notes[0].leaf")
        );
        assertEq(zpool.nextIndex(), 2);
    }

    function test_verifierAcceptsFixture() public view {
        assertEq(publicInputs.length, zpool.PUBLIC_INPUTS());
        assertEq(uint256(publicInputs[0]), root);
        assertEq(uint256(publicInputs[2]), passportId);
        assertEq(uint256(publicInputs[9]), zpool.binding());
        assertTrue(honk.verify(proof, publicInputs));
    }

    // ---------------------------------------------------------------- spend

    function test_spend() public {
        vm.expectEmit(true, false, false, true, address(zpool));
        emit NotePool.ChangeNote(2, changeLeaf, vm.parseJsonUint(zk, ".rootAfter"));
        vm.expectEmit(true, true, false, true, address(zpool));
        emit NotePool.Spent(passportId, COBALT, 4_500, nullifiers);

        vm.prank(manufacturer);
        uint256 g = gasleft();
        zpool.spend(passportId, COBALT, 4_500, root, nullifiers, changeLeaf, proof);
        g -= gasleft();
        console.log("NotePool.spend gas (2 inputs + change, real UltraHonk proof):", g);

        PassportRegistry.Passport memory p = passports.passport(passportId);
        assertEq(p.recycled[COBALT], 4_500, "recycled content");
        assertEq(passports.recycledShareBps(passportId, COBALT), 10_000);
        assertTrue(zpool.nullifierSpent(nullifiers[0]));
        assertTrue(zpool.nullifierSpent(nullifiers[1]));
        assertFalse(zpool.nullifierSpent(0));
        assertEq(zpool.nextIndex(), 3, "change leaf appended");
        assertEq(zpool.currentRoot(), vm.parseJsonUint(zk, ".rootAfter"), "root after change");
        assertTrue(zpool.isKnownRoot(root), "old root stays in history");
    }

    /// A root that has since been superseded by more mints is still accepted.
    function test_spendAgainstOlderRoot() public {
        zpool.mintNote(COBALT, 1_000, 0x1234);
        assertTrue(zpool.currentRoot() != root);
        spendAs(manufacturer, zpool, passportId, 4_500, root, nullifiers, changeLeaf);
        assertEq(passports.passport(passportId).recycled[COBALT], 4_500);
    }

    // ------------------------------------------------------------- negative

    function test_replayRejected() public {
        spendAs(manufacturer, zpool, passportId, 4_500, root, nullifiers, changeLeaf);
        vm.prank(manufacturer);
        vm.expectRevert(abi.encodeWithSelector(NotePool.NullifierUsed.selector, nullifiers[0]));
        zpool.spend(passportId, COBALT, 4_500, root, nullifiers, changeLeaf, proof);
    }

    function test_tamperedDeclaredGramsRejected() public {
        expectProofRejected(zpool, passportId, 4_501, root, nullifiers, changeLeaf);
        expectProofRejected(zpool, passportId, 4_499, root, nullifiers, changeLeaf);
    }

    function test_tamperedChangeLeafRejected() public {
        expectProofRejected(zpool, passportId, 4_500, root, nullifiers, 0);
        expectProofRejected(zpool, passportId, 4_500, root, nullifiers, changeLeaf + 1);
    }

    function test_tamperedNullifiersRejected() public {
        uint256[4] memory nf = nullifiers;
        (nf[0], nf[1]) = (nf[1], nf[0]);
        expectProofRejected(zpool, passportId, 4_500, root, nf, changeLeaf);

        nf = nullifiers;
        nf[1] = 0;
        expectProofRejected(zpool, passportId, 4_500, root, nf, changeLeaf);
    }

    function test_otherPassportRejected() public {
        registerFixtureDevice("keyB1", deviceB(), manufacturer);
        uint256 other = issuePassport(deviceB(), keccak256("gs1:B"));
        assertEq(other, 2);
        expectProofRejected(zpool, other, 4_500, root, nullifiers, changeLeaf);
        assertEq(passports.passport(other).recycled[COBALT], 0);
    }

    function test_unknownRootRejected() public {
        vm.prank(manufacturer);
        vm.expectRevert(NotePool.UnknownRoot.selector);
        zpool.spend(passportId, COBALT, 4_500, root + 1, nullifiers, changeLeaf, proof);
    }

    /// A known root that is not the one in the proof fails in the verifier.
    function test_otherKnownRootRejected() public {
        uint256 empty = vm.parseJsonUint(zk, ".emptyRoot");
        assertTrue(zpool.isKnownRoot(empty));
        expectProofRejected(zpool, passportId, 4_500, empty, nullifiers, changeLeaf);
    }

    /// The same notes and proof replayed on a second deployment fail, because
    /// that pool's binding differs.
    function test_otherDeploymentRejected() public {
        NotePool twin = deployPool(address(0xBEEF));
        twin.mintNote(COBALT, 3_000, vm.parseJsonUint(zk, ".notes[0].ownerCommit"));
        twin.mintNote(COBALT, 2_000, vm.parseJsonUint(zk, ".notes[1].ownerCommit"));
        assertEq(twin.currentRoot(), root);
        assertTrue(twin.binding() != zpool.binding());
        expectProofRejected(twin, passportId, 4_500, root, nullifiers, changeLeaf);
    }

    function test_corruptedProofRejected() public {
        proof[100] = bytes1(uint8(proof[100]) ^ 1);
        vm.prank(manufacturer);
        vm.expectRevert();
        zpool.spend(passportId, COBALT, 4_500, root, nullifiers, changeLeaf, proof);
    }

    function test_onlyOperatorCanSpend() public {
        vm.expectRevert(NotePool.NotOperator.selector);
        spendAs(grader, zpool, passportId, 4_500, root, nullifiers, changeLeaf);
    }
}
