// Shielded spend of recycled-metal notes into a battery passport.
//
// Mirrors contracts/src/NotePool.sol. The hashes are Poseidon2 over BN254
// (t = 4, Rf = 8, Rp = 56) with the sponge IV set to input_count << 64, which is
// what Poseidon2Yul_BN254.hash_2 / hash_3 compute on chain.
//
//   ownerCommit = H3(ownerSecret, salt, 1)
//   nullifier   = H3(ownerSecret, salt, 2)
//   leaf        = H3(element, grams, ownerCommit)
//   node        = H2(left, right), empty leaf = 0, depth 16
//
// Public inputs, in the order NotePool.spend builds them:
//   root, element, passportId, declaredGrams, nullifier[0..4], changeLeaf, binding

use poseidon::poseidon2::Poseidon2;

global DEPTH: u32 = 16;
global INPUTS: u32 = 4;

pub fn h2(a: Field, b: Field) -> Field {
    Poseidon2::hash([a, b], 2)
}

pub fn h3(a: Field, b: Field, c: Field) -> Field {
    Poseidon2::hash([a, b, c], 3)
}

pub fn owner_commit(owner_secret: Field, salt: Field) -> Field {
    h3(owner_secret, salt, 1)
}

pub fn nullifier_of(owner_secret: Field, salt: Field) -> Field {
    h3(owner_secret, salt, 2)
}

pub fn note_leaf(element: Field, grams: Field, commit: Field) -> Field {
    h3(element, grams, commit)
}

/// Root of the depth-16 tree given a leaf, its index and its sibling path.
/// Bit i of the index (least significant first) says whether the node at level i
/// is a right child, exactly as NotePool._insert walks it. to_le_bits also
/// constrains the index to 16 bits.
pub fn merkle_root(leaf: Field, index: Field, path: [Field; DEPTH]) -> Field {
    let bits: [bool; DEPTH] = index.to_le_bits();
    let mut node = leaf;
    for i in 0..DEPTH {
        node = if bits[i] {
            h2(path[i], node)
        } else {
            h2(node, path[i])
        };
    }
    node
}

fn main(
    root: pub Field,
    element: pub Field,
    passport_id: pub Field,
    declared_grams: pub Field,
    nullifiers: pub [Field; INPUTS],
    change_leaf: pub Field,
    binding: pub Field,
    owner_secret: Field,
    salts: [Field; INPUTS],
    grams: [Field; INPUTS],
    leaf_indices: [Field; INPUTS],
    paths: [[Field; DEPTH]; INPUTS],
    change_grams: Field,
    change_owner_commit: Field,
) {
    // passportId and binding take no part in the arithmetic below. Both are
    // already bound by the proof through the public input vector; these checks
    // give each one a gate of its own so no compiler pass can treat them as dead,
    // and they are true for every valid spend (passport ids start at 1, binding
    // is a keccak output reduced mod p).
    assert(passport_id != 0, "passport id is zero");
    assert(binding != 0, "binding is zero");

    // Range checks. With every amount below 2^64 the sums below cannot wrap
    // around the field, so the balance equation holds over the integers.
    declared_grams.assert_max_bit_size::<64>();
    change_grams.assert_max_bit_size::<64>();

    let mut total: Field = 0;
    for i in 0..INPUTS {
        grams[i].assert_max_bit_size::<64>();
        total += grams[i];

        let leaf = note_leaf(element, grams[i], owner_commit(owner_secret, salts[i]));
        let computed_root = merkle_root(leaf, leaf_indices[i], paths[i]);
        let nf = nullifier_of(owner_secret, salts[i]);

        if grams[i] != 0 {
            assert(computed_root == root, "note not in tree");
            assert(nullifiers[i] == nf, "wrong nullifier");
        } else {
            assert(nullifiers[i] == 0, "unused slot has a nullifier");
        }
    }

    assert(total == declared_grams + change_grams, "grams do not balance");

    if change_grams == 0 {
        assert(change_leaf == 0, "change leaf without change");
    } else {
        assert(
            change_leaf == note_leaf(element, change_grams, change_owner_commit),
            "wrong change leaf",
        );
    }
}

// ------------------------------------------------------------------- tests

#[test]
fn hash_vectors() {
    // The same vectors are asserted against the deployed Poseidon2Yul_BN254 in
    // contracts/test/NotePoolProof.t.sol (test_poseidonMatchesCircuit).
    assert(h2(1, 2) == 0x038682aa1cb5ae4e0a3f13da432a95c77c5c111f6f030faf9cad641ce1ed7383);
    assert(h2(0, 0) == 0x0b63a53787021a4a962a452c2921b3663aff1ffd8d5510540f8e659e782956f1);
    assert(h3(1, 2, 3) == 0x23864adb160dddf590f1d3303683ebcb914f828e2635f6e85a32f0a1aecd3dd8);
    std::println(h2(1, 2));
    std::println(h2(0, 0));
    std::println(h3(1, 2, 3));
    std::println(h3(0, 4500, 0x1234));
}

global SECRET: Field = 0x5ec2e7;
global SALT_A: Field = 0xa11ce;
global SALT_B: Field = 0xb0b;
global COBALT: Field = 0;
global PASSPORT: Field = 1;
global BINDING: Field = 0x0b1d;

fn zeros() -> [Field; DEPTH] {
    let mut z = [0; DEPTH];
    for i in 1..DEPTH {
        z[i] = h2(z[i - 1], z[i - 1]);
    }
    z
}

struct Scenario {
    root: Field,
    nullifiers: [Field; INPUTS],
    salts: [Field; INPUTS],
    grams: [Field; INPUTS],
    leaf_indices: [Field; INPUTS],
    paths: [[Field; DEPTH]; INPUTS],
}

/// Two notes of the same owner, 3,000 g and 2,000 g of cobalt, at leaves 0 and 1.
fn two_notes() -> Scenario {
    let leaf_a = note_leaf(COBALT, 3000, owner_commit(SECRET, SALT_A));
    let leaf_b = note_leaf(COBALT, 2000, owner_commit(SECRET, SALT_B));
    let z = zeros();
    let mut path_a = z;
    let mut path_b = z;
    path_a[0] = leaf_b;
    path_b[0] = leaf_a;
    let root = merkle_root(leaf_a, 0, path_a);
    assert(root == merkle_root(leaf_b, 1, path_b));
    Scenario {
        root,
        nullifiers: [nullifier_of(SECRET, SALT_A), nullifier_of(SECRET, SALT_B), 0, 0],
        salts: [SALT_A, SALT_B, 0, 0],
        grams: [3000, 2000, 0, 0],
        leaf_indices: [0, 1, 0, 0],
        paths: [path_a, path_b, z, z],
    }
}

fn run(s: Scenario, declared: Field, change: Field, change_commit: Field, change_leaf: Field) {
    main(
        s.root,
        COBALT,
        PASSPORT,
        declared,
        s.nullifiers,
        change_leaf,
        BINDING,
        SECRET,
        s.salts,
        s.grams,
        s.leaf_indices,
        s.paths,
        change,
        change_commit,
    );
}

#[test]
fn happy_path_exact() {
    run(two_notes(), 5000, 0, 0, 0);
}

#[test]
fn change_note() {
    let commit = owner_commit(SECRET, 0xc4a9);
    run(two_notes(), 4500, 500, commit, note_leaf(COBALT, 500, commit));
}

#[test]
fn single_note_three_unused_slots() {
    let mut s = two_notes();
    s.grams[1] = 0;
    s.nullifiers[1] = 0;
    s.salts[1] = 0;
    run(s, 3000, 0, 0, 0);
}

#[test(should_fail_with = "unused slot has a nullifier")]
fn unused_slot_with_nullifier() {
    let mut s = two_notes();
    s.nullifiers[2] = 0x1234;
    run(s, 5000, 0, 0, 0);
}

#[test(should_fail_with = "note not in tree")]
fn wrong_root() {
    let mut s = two_notes();
    s.root += 1;
    run(s, 5000, 0, 0, 0);
}

#[test(should_fail_with = "note not in tree")]
fn inflated_note() {
    // Claiming 3,500 g for a 3,000 g note changes the leaf, so the path fails.
    let mut s = two_notes();
    s.grams[0] = 3500;
    run(s, 5500, 0, 0, 0);
}

#[test(should_fail_with = "note not in tree")]
fn wrong_owner_secret() {
    let s = two_notes();
    main(
        s.root, COBALT, PASSPORT, 5000, s.nullifiers, 0, BINDING, SECRET + 1, s.salts, s.grams,
        s.leaf_indices, s.paths, 0, 0,
    );
}

#[test(should_fail_with = "wrong nullifier")]
fn wrong_nullifier() {
    let mut s = two_notes();
    s.nullifiers[1] = s.nullifiers[1] + 1;
    run(s, 5000, 0, 0, 0);
}

#[test(should_fail_with = "wrong nullifier")]
fn swapped_nullifiers() {
    let mut s = two_notes();
    let n = s.nullifiers[0];
    s.nullifiers[0] = s.nullifiers[1];
    s.nullifiers[1] = n;
    run(s, 5000, 0, 0, 0);
}

#[test(should_fail)]
fn change_grams_overflow() {
    // Declare 6,000 g out of 5,000 g by passing change = -1,000 mod p. The sum
    // would balance in the field; the 64-bit range check stops it.
    let commit = owner_commit(SECRET, 0xc4a9);
    let change = 0 - 1000;
    run(two_notes(), 6000, change, commit, note_leaf(COBALT, change, commit));
}

#[test(should_fail)]
fn declared_grams_overflow() {
    run(two_notes(), 18446744073709551616, 0, 0, 0);
}

#[test(should_fail)]
fn note_grams_overflow() {
    let mut s = two_notes();
    s.grams[2] = 18446744073709551616;
    run(s, 5000, 0, 0, 0);
}

#[test(should_fail_with = "grams do not balance")]
fn sum_mismatch() {
    run(two_notes(), 4500, 0, 0, 0);
}

#[test(should_fail_with = "grams do not balance")]
fn declared_more_than_held() {
    run(two_notes(), 5001, 0, 0, 0);
}

#[test(should_fail_with = "change leaf without change")]
fn change_leaf_without_change() {
    run(two_notes(), 5000, 0, 0, 0x77);
}

#[test(should_fail_with = "wrong change leaf")]
fn wrong_change_leaf() {
    let commit = owner_commit(SECRET, 0xc4a9);
    run(two_notes(), 4500, 500, commit, note_leaf(COBALT, 600, commit));
}

#[test(should_fail_with = "passport id is zero")]
fn zero_passport() {
    let s = two_notes();
    main(
        s.root, COBALT, 0, 5000, s.nullifiers, 0, BINDING, SECRET, s.salts, s.grams,
        s.leaf_indices, s.paths, 0, 0,
    );
}
