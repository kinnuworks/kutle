// Off-chain mirror of contracts/src/NotePool.sol: note commitments, the depth-16
// Poseidon2 Merkle tree, sibling paths, the deployment binding, and rebuilding
// the tree from NoteMinted / ChangeNote events.

import { encodeAbiParameters, keccak256, parseAbiItem } from 'viem';
import { P, hash2, hash3 } from './poseidon2.mjs';

export { P };
export const DEPTH = 16;
export const MAX_LEAVES = 1 << DEPTH;
export const INPUTS = 4;
export const ROOT_HISTORY = 64;

export const ownerCommit = (ownerSecret, salt) => hash3(ownerSecret, salt, 1n);
export const nullifier = (ownerSecret, salt) => hash3(ownerSecret, salt, 2n);
export const noteLeaf = (element, grams, commit) => hash3(BigInt(element), BigInt(grams), commit);

/** NotePool.binding: keccak256(abi.encode("KUTLE_NOTEPOOL_V1", chainid, pool)) mod p. */
export function binding(chainId, poolAddress) {
  const enc = encodeAbiParameters(
    [{ type: 'string' }, { type: 'uint256' }, { type: 'address' }],
    ['KUTLE_NOTEPOOL_V1', BigInt(chainId), poolAddress.toLowerCase()],
  );
  return BigInt(keccak256(enc)) % P;
}

/** zeros[i] is the root of an empty subtree of height i; zeros[DEPTH] is the empty root. */
export const ZEROS = (() => {
  const z = [0n];
  for (let i = 0; i < DEPTH; i++) z.push(hash2(z[i], z[i]));
  return z;
})();

export class NoteTree {
  constructor() {
    // levels[i] holds the known nodes at height i; anything past the end is zeros[i].
    this.levels = Array.from({ length: DEPTH + 1 }, () => []);
    this.levels[DEPTH] = [ZEROS[DEPTH]];
    this.roots = [ZEROS[DEPTH]];
  }

  get size() {
    return this.levels[0].length;
  }

  get root() {
    return this.levels[DEPTH][0];
  }

  node(level, index) {
    const row = this.levels[level];
    return index < row.length ? row[index] : ZEROS[level];
  }

  /** Append a leaf the way NotePool._insert does. Returns { index, root }. */
  insert(leaf) {
    const index = this.size;
    if (index >= MAX_LEAVES) throw new Error('tree full');
    let node = BigInt(leaf);
    let idx = index;
    this.levels[0][idx] = node;
    for (let i = 0; i < DEPTH; i++) {
      const left = idx & 1 ? this.node(i, idx - 1) : node;
      const right = idx & 1 ? node : this.node(i, idx + 1);
      node = hash2(left, right);
      idx >>= 1;
      this.levels[i + 1][idx] = node;
    }
    this.roots.push(node);
    return { index, root: node };
  }

  /** Sibling path for a leaf, bottom level first, as the circuit expects. */
  path(index) {
    if (index >= this.size) throw new Error(`no leaf at ${index}`);
    const siblings = [];
    let idx = index;
    for (let i = 0; i < DEPTH; i++) {
      siblings.push(this.node(i, idx ^ 1));
      idx >>= 1;
    }
    return siblings;
  }

  /** Recompute a root from a leaf and its path (for checks). */
  static rootFrom(leaf, index, siblings) {
    let node = BigInt(leaf);
    for (let i = 0; i < DEPTH; i++) {
      node = (index >> i) & 1 ? hash2(siblings[i], node) : hash2(node, siblings[i]);
    }
    return node;
  }

  /** Roots NotePool still accepts (the last ROOT_HISTORY, counting the empty root). */
  knownRoots() {
    return this.roots.slice(-ROOT_HISTORY);
  }

  indexOf(leaf) {
    return this.levels[0].indexOf(BigInt(leaf));
  }

  /**
   * Rebuild from decoded NoteMinted / ChangeNote events (any order). Each event's
   * root is checked against the locally computed one, so a gap or a wrong
   * Poseidon2 shows up immediately.
   */
  static fromEvents(events) {
    const sorted = [...events]
      .map((e) => ({ leafIndex: Number(e.leafIndex), leaf: BigInt(e.leaf), root: BigInt(e.root) }))
      .sort((a, b) => a.leafIndex - b.leafIndex);
    const tree = new NoteTree();
    for (const e of sorted) {
      if (e.leafIndex !== tree.size) throw new Error(`missing leaf ${tree.size} (next event is ${e.leafIndex})`);
      const { root } = tree.insert(e.leaf);
      if (root !== e.root) throw new Error(`root mismatch at leaf ${e.leafIndex}`);
    }
    return tree;
  }
}

export const NOTE_MINTED = parseAbiItem(
  'event NoteMinted(uint256 indexed leafIndex, uint256 leaf, uint8 indexed element, uint64 grams, uint256 root)',
);
export const CHANGE_NOTE = parseAbiItem('event ChangeNote(uint256 indexed leafIndex, uint256 leaf, uint256 root)');

/** Read every leaf of a deployed NotePool with a viem public client. */
export async function loadTree(client, poolAddress, fromBlock = 0n) {
  const [minted, change] = await Promise.all([
    client.getLogs({ address: poolAddress, event: NOTE_MINTED, fromBlock, toBlock: 'latest' }),
    client.getLogs({ address: poolAddress, event: CHANGE_NOTE, fromBlock, toBlock: 'latest' }),
  ]);
  return NoteTree.fromEvents([...minted, ...change].map((l) => l.args));
}

export const toHex32 = (x) => '0x' + BigInt(x).toString(16).padStart(64, '0');
