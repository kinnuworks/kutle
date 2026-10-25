// SPDX-License-Identifier: MIT
pragma solidity 0.8.30;

import {IPoseidon2} from "poseidon2/IPoseidon2.sol";
import {Elements} from "./libraries/Elements.sol";

interface IShieldedSpendVerifier {
    /// Shape of the UltraHonk verifier that Barretenberg generates from the Noir circuit.
    function verify(bytes calldata proof, bytes32[] calldata publicInputs) external view returns (bool);
}

interface IPassportsForNotes {
    function addRecycledContent(uint256 passportId, uint8 element, uint64 grams) external;
    function operatorOf(uint256 passportId) external view returns (address);
}

/// @title NotePool
/// @notice Private recycled-metal notes.
///
///         The law requires a battery's recycled share to be public. It does not
///         require a cell maker to publish which recyclers it buys from or in what
///         volumes, and makers treat that as a trade secret. So recovered metal is
///         held as notes in a Merkle tree. To back a new passport, the maker proves
///         in zero knowledge that it owns unspent notes of the right element worth
///         at least the declared grams. The chain learns the passport, the element,
///         the declared grams and one nullifier per note. It does not learn which
///         notes were spent, so it does not learn the supplier.
///
///         Note leaf     = Poseidon2(element, grams, ownerCommit)
///         ownerCommit   = Poseidon2(ownerSecret, salt, 1)
///         nullifier     = Poseidon2(ownerSecret, salt, 2)
///         tree node     = Poseidon2(left, right), empty leaf = 0, depth 16
///
///         Spending consumes whole notes; any remainder comes back as one change
///         note whose leaf the circuit computes and the contract appends.
contract NotePool {
    uint256 internal constant P = 21888242871839275222246405745257275088548364400416034343698204186575808495617;
    uint256 public constant DEPTH = 16;
    uint256 public constant MAX_LEAVES = 1 << DEPTH;
    uint256 public constant ROOT_HISTORY = 64;
    uint256 public constant INPUTS = 4;
    /// Number of public inputs the circuit exposes, in this order:
    /// root, element, passportId, declaredGrams, nullifier[4], changeLeaf, binding
    uint256 public constant PUBLIC_INPUTS = 10;

    IPoseidon2 public immutable poseidon;
    bytes32 public immutable poseidonCodehash;
    IShieldedSpendVerifier public immutable verifier;
    bytes32 public immutable verifierCodehash;
    IPassportsForNotes public immutable passports;
    address public immutable ledger;
    /// Ties every proof to this chain and this contract.
    uint256 public immutable binding;

    uint256[DEPTH] public zeros;
    uint256[DEPTH] private _filled;
    uint256 public nextIndex;
    uint256[ROOT_HISTORY] public roots;
    uint256 public currentRootIndex;
    mapping(uint256 => bool) public nullifierSpent;

    event NoteMinted(uint256 indexed leafIndex, uint256 leaf, uint8 indexed element, uint64 grams, uint256 root);
    event ChangeNote(uint256 indexed leafIndex, uint256 leaf, uint256 root);
    event Spent(uint256 indexed passportId, uint8 indexed element, uint64 declaredGrams, uint256[4] nullifiers);

    error NotLedger();
    error NotOperator();
    error TreeFull();
    error UnknownRoot();
    error NullifierUsed(uint256 nullifier);
    error DuplicateNullifier();
    error NoInputs();
    error BadProof();
    error FieldOverflow();
    error ZeroGrams();
    error CodeSwapped();

    constructor(IPoseidon2 poseidon_, IShieldedSpendVerifier verifier_, IPassportsForNotes passports_, address ledger_) {
        poseidon = poseidon_;
        poseidonCodehash = address(poseidon_).codehash;
        verifier = verifier_;
        verifierCodehash = address(verifier_).codehash;
        passports = passports_;
        ledger = ledger_;
        binding = uint256(keccak256(abi.encode("KUTLE_NOTEPOOL_V1", block.chainid, address(this)))) % P;

        uint256 z; // empty leaf is 0
        for (uint256 i; i < DEPTH; ++i) {
            zeros[i] = z;
            _filled[i] = z;
            z = poseidon_.hash_2(z, z);
        }
        roots[0] = z;
    }

    // ------------------------------------------------------------------- mint

    /// @notice Append a note. Only the ConservationLedger can mint, and only out of
    ///         assayed, not-yet-issued recovered metal.
    function mintNote(uint8 element, uint64 grams, uint256 ownerCommit) external returns (uint256 leafIndex) {
        if (msg.sender != ledger) revert NotLedger();
        Elements.check(element);
        if (grams == 0) revert ZeroGrams();
        if (ownerCommit >= P) revert FieldOverflow();
        uint256 leaf = _poseidon().hash_3(element, grams, ownerCommit);
        uint256 root;
        (leafIndex, root) = _insert(leaf);
        emit NoteMinted(leafIndex, leaf, element, grams, root);
    }

    // ------------------------------------------------------------------- spend

    /// @notice Spend notes into a passport's recycled content.
    /// @param nullifiers one per input slot; 0 marks an unused slot
    /// @param changeLeaf leaf of the change note, or 0 if there is no change
    function spend(
        uint256 passportId,
        uint8 element,
        uint64 declaredGrams,
        uint256 root,
        uint256[4] calldata nullifiers,
        uint256 changeLeaf,
        bytes calldata proof
    ) external {
        if (passports.operatorOf(passportId) != msg.sender) revert NotOperator();
        Elements.check(element);
        if (declaredGrams == 0) revert ZeroGrams();
        if (!isKnownRoot(root)) revert UnknownRoot();
        if (passportId >= P || changeLeaf >= P) revert FieldOverflow();

        bool any;
        for (uint256 i; i < INPUTS; ++i) {
            uint256 nf = nullifiers[i];
            if (nf == 0) continue;
            if (nf >= P) revert FieldOverflow();
            if (nullifierSpent[nf]) revert NullifierUsed(nf);
            for (uint256 j; j < i; ++j) {
                if (nullifiers[j] == nf) revert DuplicateNullifier();
            }
            any = true;
        }
        if (!any) revert NoInputs();

        bytes32[] memory pub = new bytes32[](PUBLIC_INPUTS);
        pub[0] = bytes32(root);
        pub[1] = bytes32(uint256(element));
        pub[2] = bytes32(passportId);
        pub[3] = bytes32(uint256(declaredGrams));
        for (uint256 i; i < INPUTS; ++i) {
            pub[4 + i] = bytes32(nullifiers[i]);
        }
        pub[8] = bytes32(changeLeaf);
        pub[9] = bytes32(binding);

        if (address(verifier).codehash != verifierCodehash) revert CodeSwapped();
        if (!verifier.verify(proof, pub)) revert BadProof();

        for (uint256 i; i < INPUTS; ++i) {
            if (nullifiers[i] != 0) nullifierSpent[nullifiers[i]] = true;
        }
        if (changeLeaf != 0) {
            (uint256 idx, uint256 newRoot) = _insert(changeLeaf);
            emit ChangeNote(idx, changeLeaf, newRoot);
        }
        passports.addRecycledContent(passportId, element, declaredGrams);
        emit Spent(passportId, element, declaredGrams, nullifiers);
    }

    // ------------------------------------------------------------------- views

    function isKnownRoot(uint256 root) public view returns (bool) {
        if (root == 0) return false;
        uint256 i = currentRootIndex;
        for (uint256 n; n < ROOT_HISTORY; ++n) {
            if (roots[i] == root) return true;
            i = i == 0 ? ROOT_HISTORY - 1 : i - 1;
        }
        return false;
    }

    function currentRoot() external view returns (uint256) {
        return roots[currentRootIndex];
    }

    // ---------------------------------------------------------------- internal

    function _insert(uint256 leaf) private returns (uint256 index, uint256 root) {
        index = nextIndex;
        if (index >= MAX_LEAVES) revert TreeFull();
        IPoseidon2 h = _poseidon();
        uint256 node = leaf;
        uint256 idx = index;
        for (uint256 i; i < DEPTH; ++i) {
            if (idx & 1 == 0) {
                _filled[i] = node;
                node = h.hash_2(node, zeros[i]);
            } else {
                node = h.hash_2(_filled[i], node);
            }
            idx >>= 1;
        }
        root = node;
        nextIndex = index + 1;
        uint256 r = (currentRootIndex + 1) % ROOT_HISTORY;
        currentRootIndex = r;
        roots[r] = root;
    }

    function _poseidon() private view returns (IPoseidon2) {
        if (address(poseidon).codehash != poseidonCodehash) revert CodeSwapped();
        return poseidon;
    }
}
