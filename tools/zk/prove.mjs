// Witness, proof and public inputs for circuits/shielded_spend.
//
// Library use:
//   const req = buildSpend({ tree, element, passportId, declaredGrams, ownerSecret,
//                            notes, changeGrams, changeOwnerCommit, binding });
//   const out = await prove(req.inputs);   // { proof, publicInputs }
//
// CLI use:
//   node zk/prove.mjs request.json [out.json]
// where request.json holds { element, passportId, declaredGrams, ownerSecret,
// notes: [{ salt, grams, leafIndex }], changeGrams, changeOwnerCommit,
// chainId, pool, leaves: [...] } (leaves in insertion order, as the events
// give them; see notepool.mjs loadTree for reading them from chain).

import { readFileSync, writeFileSync } from 'node:fs';
import { fileURLToPath } from 'node:url';
import { dirname, resolve } from 'node:path';
import { Noir } from '@noir-lang/noir_js';
import { Barretenberg, UltraHonkBackend } from '@aztec/bb.js';
import {
  DEPTH,
  INPUTS,
  NoteTree,
  P,
  binding as bindingOf,
  noteLeaf,
  nullifier,
  ownerCommit,
  toHex32,
} from './notepool.mjs';

const here = dirname(fileURLToPath(import.meta.url));
export const CIRCUIT_PATH = resolve(here, '../../circuits/shielded_spend/target/shielded_spend.json');
const U64_MAX = (1n << 64n) - 1n;

// Secrets and salts must already be field elements: the JS hash would reduce
// them mod p while the circuit ABI rejects them, and the two would disagree.
function field(x, what) {
  const v = BigInt(x);
  if (v < 0n || v >= P) throw new Error(`${what} is not below the field modulus`);
  return v;
}

/**
 * Check a spend against the tree and lay out the circuit inputs. Throws on
 * anything the circuit or NotePool would reject, so failures show up here with
 * a readable message instead of as an unsatisfied constraint.
 */
export function buildSpend({
  tree,
  element,
  passportId,
  declaredGrams,
  ownerSecret,
  notes,
  changeGrams = 0n,
  changeOwnerCommit = 0n,
  binding,
}) {
  if (notes.length < 1 || notes.length > INPUTS) throw new Error(`1 to ${INPUTS} notes per spend`);
  const secret = field(ownerSecret, 'ownerSecret');
  const root = tree.root;

  const salts = [];
  const grams = [];
  const leafIndices = [];
  const paths = [];
  const nullifiers = [];
  let total = 0n;
  for (let i = 0; i < INPUTS; i++) {
    const n = notes[i];
    if (!n) {
      salts.push(0n);
      grams.push(0n);
      leafIndices.push(0);
      paths.push(Array(DEPTH).fill(0n));
      nullifiers.push(0n);
      continue;
    }
    const g = BigInt(n.grams);
    if (g <= 0n || g > U64_MAX) throw new Error(`note ${i}: grams out of range`);
    field(n.salt, `note ${i} salt`);
    const leaf = noteLeaf(element, g, ownerCommit(secret, BigInt(n.salt)));
    const index = n.leafIndex ?? tree.indexOf(leaf);
    if (index < 0 || tree.node(0, index) !== leaf) throw new Error(`note ${i}: leaf not in tree`);
    const path = tree.path(index);
    if (NoteTree.rootFrom(leaf, index, path) !== root) throw new Error(`note ${i}: path does not reach root`);
    salts.push(BigInt(n.salt));
    grams.push(g);
    leafIndices.push(index);
    paths.push(path);
    nullifiers.push(nullifier(secret, BigInt(n.salt)));
    total += g;
  }
  if (new Set(nullifiers.filter((x) => x !== 0n).map(String)).size !== notes.length) {
    throw new Error('the same note appears twice');
  }

  const declared = BigInt(declaredGrams);
  const change = BigInt(changeGrams);
  if (declared <= 0n || declared > U64_MAX || change < 0n || change > U64_MAX) throw new Error('grams out of range');
  if (total !== declared + change) throw new Error(`notes hold ${total} g, declared ${declared} + change ${change}`);
  const changeLeaf = change === 0n ? 0n : noteLeaf(element, change, field(changeOwnerCommit, 'changeOwnerCommit'));

  const h = toHex32;
  const inputs = {
    root: h(root),
    element: h(element),
    passport_id: h(passportId),
    declared_grams: h(declared),
    nullifiers: nullifiers.map(h),
    change_leaf: h(changeLeaf),
    binding: h(binding),
    owner_secret: h(secret),
    salts: salts.map(h),
    grams: grams.map(h),
    leaf_indices: leafIndices.map(h),
    paths: paths.map((p) => p.map(h)),
    change_grams: h(change),
    change_owner_commit: h(changeOwnerCommit),
  };
  // Same order as NotePool.spend builds its bytes32[] array.
  const publicInputs = [root, BigInt(element), BigInt(passportId), declared, ...nullifiers, changeLeaf, BigInt(binding)].map(h);
  return { inputs, publicInputs, root, nullifiers, changeLeaf };
}

/**
 * Execute the circuit and produce an UltraHonk proof for the keccak/EVM
 * verifier. Returns the proof as 0x hex and the public inputs as bytes32 hex.
 */
export async function prove(inputs, { circuitPath = CIRCUIT_PATH, threads } = {}) {
  const circuit = JSON.parse(readFileSync(circuitPath, 'utf8'));
  const noir = new Noir(circuit);
  const t0 = performance.now();
  const { witness } = await noir.execute(inputs);
  const t1 = performance.now();
  const api = await Barretenberg.new(threads ? { threads } : {});
  try {
    const backend = new UltraHonkBackend(circuit.bytecode, api);
    const { proof, publicInputs } = await backend.generateProof(witness, { verifierTarget: 'evm' });
    const t2 = performance.now();
    const ok = await backend.verifyProof({ proof, publicInputs }, { verifierTarget: 'evm' });
    if (!ok) throw new Error('bb.js rejected its own proof');
    return {
      proof: '0x' + Buffer.from(proof).toString('hex'),
      publicInputs: publicInputs.map((x) => toHex32(BigInt(x))),
      timings: { witnessMs: Math.round(t1 - t0), proveMs: Math.round(t2 - t1) },
    };
  } finally {
    await api.destroy();
  }
}

async function cli() {
  const [reqPath, outPath] = process.argv.slice(2);
  if (!reqPath) {
    console.error('usage: node zk/prove.mjs request.json [out.json]');
    process.exit(2);
  }
  const req = JSON.parse(readFileSync(reqPath, 'utf8'));
  const tree = new NoteTree();
  for (const leaf of req.leaves) tree.insert(BigInt(leaf));
  const spend = buildSpend({ ...req, tree, binding: bindingOf(req.chainId, req.pool) });
  const out = await prove(spend.inputs);
  for (let i = 0; i < spend.publicInputs.length; i++) {
    if (out.publicInputs[i] !== spend.publicInputs[i]) throw new Error(`public input ${i} differs`);
  }
  const json = JSON.stringify({ ...out, root: toHex32(spend.root), nullifiers: spend.nullifiers.map(toHex32), changeLeaf: toHex32(spend.changeLeaf) }, null, 2);
  if (outPath) writeFileSync(outPath, json + '\n');
  else console.log(json);
}

if (process.argv[1] && resolve(process.argv[1]) === fileURLToPath(import.meta.url)) {
  cli().catch((e) => {
    console.error(e);
    process.exit(1);
  });
}
