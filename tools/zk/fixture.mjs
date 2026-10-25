// Writes contracts/test/fixtures/zk/spend.json for test/NotePoolProof.t.sol.
//
// Scenario: one maker holds two cobalt notes, 3,000 g and 2,000 g, minted as
// leaves 0 and 1 of a fresh pool. It declares 4,500 g into passport #1 and takes
// 500 g back as a change note. The pool sits at POOL_ADDR on chain 31337, which
// the test reproduces with deployCodeTo, so the binding below matches.
//
//   node zk/fixture.mjs

import { mkdirSync, writeFileSync } from 'node:fs';
import { dirname, resolve } from 'node:path';
import { fileURLToPath } from 'node:url';
import { hash2, hash3 } from './poseidon2.mjs';
import { NoteTree, binding, noteLeaf, ownerCommit, toHex32 } from './notepool.mjs';
import { buildSpend, prove } from './prove.mjs';

const here = dirname(fileURLToPath(import.meta.url));
const OUT = resolve(here, '../../contracts/test/fixtures/zk/spend.json');

export const CHAIN_ID = 31337;
export const POOL_ADDR = '0x0000000000000000000000000000000000C0Ba17';

const COBALT = 0;
const OWNER_SECRET = 0x2f1c6d1b8a40e2b7c35d0e9a71f4b6c2d8e3a5f7091b2c4d6e8f0a1b3c5d7e9fn;
const SALT_A = 0x051a700000000000000000000000000000000000000000000000000000000001n;
const SALT_B = 0x051a700000000000000000000000000000000000000000000000000000000002n;
const SALT_CHANGE = 0x051a700000000000000000000000000000000000000000000000000000000003n;

const commitA = ownerCommit(OWNER_SECRET, SALT_A);
const commitB = ownerCommit(OWNER_SECRET, SALT_B);
const changeCommit = ownerCommit(OWNER_SECRET, SALT_CHANGE);

const tree = new NoteTree();
tree.insert(noteLeaf(COBALT, 3000n, commitA));
tree.insert(noteLeaf(COBALT, 2000n, commitB));

const b = binding(CHAIN_ID, POOL_ADDR);
const spend = buildSpend({
  tree,
  element: COBALT,
  passportId: 1n,
  declaredGrams: 4500n,
  ownerSecret: OWNER_SECRET,
  notes: [
    { salt: SALT_A, grams: 3000n, leafIndex: 0 },
    { salt: SALT_B, grams: 2000n, leafIndex: 1 },
  ],
  changeGrams: 500n,
  changeOwnerCommit: changeCommit,
  binding: b,
});

const out = await prove(spend.inputs);
spend.publicInputs.forEach((x, i) => {
  if (out.publicInputs[i] !== x) throw new Error(`public input ${i}: circuit ${out.publicInputs[i]} vs expected ${x}`);
});

// Root after the change note goes in, for the test to compare with the pool.
const after = new NoteTree();
after.insert(tree.node(0, 0));
after.insert(tree.node(0, 1));
after.insert(spend.changeLeaf);

const h = toHex32;
const fixture = {
  chainId: CHAIN_ID,
  pool: POOL_ADDR,
  binding: h(b),
  element: COBALT,
  passportId: 1,
  declaredGrams: 4500,
  changeGrams: 500,
  notes: [
    { grams: 3000, ownerCommit: h(commitA), leaf: h(tree.node(0, 0)) },
    { grams: 2000, ownerCommit: h(commitB), leaf: h(tree.node(0, 1)) },
  ],
  root: h(spend.root),
  nullifiers: spend.nullifiers.map(h),
  changeLeaf: h(spend.changeLeaf),
  rootAfter: h(after.root),
  emptyRoot: h(new NoteTree().root),
  proof: out.proof,
  publicInputs: out.publicInputs,
  poseidon: {
    h2_1_2: h(hash2(1n, 2n)),
    h2_0_0: h(hash2(0n, 0n)),
    h3_1_2_3: h(hash3(1n, 2n, 3n)),
    h3_0_4500_0x1234: h(hash3(0n, 4500n, 0x1234n)),
  },
};

mkdirSync(dirname(OUT), { recursive: true });
writeFileSync(OUT, JSON.stringify(fixture, null, 2) + '\n');
console.log(`wrote ${OUT}`);
console.log(`proof ${(out.proof.length - 2) / 2} bytes, witness ${out.timings.witnessMs} ms, prove ${out.timings.proveMs} ms`);
