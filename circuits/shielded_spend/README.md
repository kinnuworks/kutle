# Shielded spend circuit

This circuit lets a battery maker back a passport's recycled content with
recycled-metal notes from `NotePool` without saying which notes it spent. The
chain sees the passport, the element, the declared grams and one nullifier per
spent note. It does not see the notes, their owners or their sizes, so it does
not learn the supplier.

The on-chain side is `contracts/src/NotePool.sol`. Everything here mirrors it.

## Hashes

Poseidon2 over BN254 with t = 4, 8 full rounds, 56 partial rounds and the
sponge IV set to `input_count << 64`. For two or three inputs that is one
permutation of `[a, b, c, n << 64]` returning the first word, which is what
`Poseidon2Yul_BN254.hash_2` and `hash_3` compute. Poseidon2 is no longer in the
Noir standard library, so the circuit uses `noir-lang/poseidon` at tag v0.4.0.

```
ownerCommit = H3(ownerSecret, salt, 1)
nullifier   = H3(ownerSecret, salt, 2)
leaf        = H3(element, grams, ownerCommit)
node        = H2(left, right)       empty leaf = 0, depth 16
```

Leaf index bits are read least significant first: bit i set means the node at
level i is a right child, as in `NotePool._insert`.

The Noir test `hash_vectors` and the Foundry test
`test_poseidonMatchesCircuit` assert the same four outputs, the first against
the Noir library and the second against the deployed Yul contract. The JS
mirror in `tools/zk/poseidon2.mjs` produces them too.

## Statement proved

Public inputs, in this order (the order `NotePool.spend` builds its array):

| # | name            |
|---|-----------------|
| 0 | root            |
| 1 | element         |
| 2 | passportId      |
| 3 | declaredGrams   |
| 4 to 7 | nullifier[0..4] |
| 8 | changeLeaf      |
| 9 | binding         |

Private inputs: one `ownerSecret`, and for each of the four slots a salt, an
amount, a leaf index and a 16-element sibling path; plus `changeGrams` and
`changeOwnerCommit`.

The prover knows private inputs such that:

1. Every amount (each slot's grams, `declaredGrams`, `changeGrams`) is below
   2^64. With four inputs the sums then stay far below the field modulus, so
   the balance check in step 3 holds over the integers and cannot be met by
   wrapping around p.
2. For each slot with grams > 0, the leaf
   `H3(element, grams, H3(ownerSecret, salt, 1))` sits at the given index in the
   tree whose root is `root`, and `nullifier[i] = H3(ownerSecret, salt, 2)`.
   For each slot with grams = 0, `nullifier[i] = 0` and nothing else is checked.
   All slots share one `ownerSecret`, and all notes have the public `element`.
3. `sum(grams) = declaredGrams + changeGrams`.
4. If `changeGrams = 0` then `changeLeaf = 0`; otherwise
   `changeLeaf = H3(element, changeGrams, changeOwnerCommit)`. The change note
   can go to any owner commitment the prover chooses, usually its own.
5. `passportId != 0` and `binding != 0`.

Step 5 holds for every honest spend. Its purpose is to give `passportId` and
`binding` a constraint each. Both are bound by the proof anyway, since the
verifier hashes the whole public input vector into its transcript, but this way
no compiler pass can treat them as unused. `binding` is
`keccak256(abi.encode("KUTLE_NOTEPOOL_V1", chainid, pool)) mod p`, so a proof
is good for one passport on one deployment only.

## What the contract adds

The circuit does not track spent notes. `NotePool.spend` does that: it rejects
an unknown root, a nullifier already spent, the same nullifier twice in one
call, and a call with no inputs; it checks that the caller operates the
passport; and after the proof verifies it marks the nullifiers, appends
`changeLeaf` if it is non-zero and credits the passport. Notes with zero grams
cannot exist in the tree (`mintNote` rejects them and a change leaf is only
appended when it is non-zero), which is why grams = 0 can mark an unused slot.

Secrets and salts must be field elements below p. The JS tooling refuses
anything larger, because it would hash a reduced value while the circuit ABI
rejects the input.

## Building

Toolchain: nargo 1.0.0-beta.22 and bb 5.0.0-nightly.20260522, a pair listed in
bbup's compatibility table.

```
noirup -v 1.0.0-beta.22
bbup -v 5.0.0-nightly.20260522
nargo test                     # 18 unit tests
tools/zk/build-circuit.sh      # compile, VK, Solidity verifier
cd tools && node zk/fixture.mjs  # proof fixture for the Foundry test
```

`build-circuit.sh` explains the two edits it makes to bb's Solidity output.
Any change to the circuit changes the verification key, so the verifier and the
fixture must be regenerated together.

Size: 326 ACIR opcodes, 13,384 UltraHonk gates (circuit size 2^14).

## Proving from an app

`tools/zk/notepool.mjs` computes owner commitments, nullifiers, leaves,
paths and roots exactly as `NotePool` does, and `loadTree(client, pool)`
rebuilds the tree from `NoteMinted` and `ChangeNote` events, checking each
event's root. `tools/zk/prove.mjs` turns notes and a tree into circuit inputs
(`buildSpend`) and produces a proof and public inputs (`prove`) with noir_js
and bb.js, using the EVM (keccak, zero-knowledge) target the Solidity verifier
expects. It can also be run as `node zk/prove.mjs request.json out.json`.
