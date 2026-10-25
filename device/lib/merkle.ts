// Sorted-pair Merkle tree over reading leaves (SPEC.md section 2), the same fold
// ReadingLog.verifyReading performs.

import { concat, keccak256, type Hex } from "viem";

export function hashPair(a: Hex, b: Hex): Hex {
  const x = a.toLowerCase() as Hex;
  const y = b.toLowerCase() as Hex;
  // Both are 0x-prefixed 32-byte hex, so string order is big-endian byte order.
  return x < y ? keccak256(concat([x, y])) : keccak256(concat([y, x]));
}

/** All levels, leaves first, root last. */
export function merkleLevels(leaves: readonly Hex[]): Hex[][] {
  if (leaves.length === 0) throw new Error("a batch needs at least one leaf");
  const levels: Hex[][] = [leaves.map((l) => l.toLowerCase() as Hex)];
  while (levels[levels.length - 1].length > 1) {
    const cur = levels[levels.length - 1];
    const next: Hex[] = [];
    for (let i = 0; i < cur.length; i += 2) {
      next.push(i + 1 < cur.length ? hashPair(cur[i], cur[i + 1]) : cur[i]);
    }
    levels.push(next);
  }
  return levels;
}

export function merkleRoot(leaves: readonly Hex[]): Hex {
  const levels = merkleLevels(leaves);
  return levels[levels.length - 1][0];
}

/** Sibling path for leaves[index], bottom up; carried levels add nothing. */
export function merkleProof(leaves: readonly Hex[], index: number): Hex[] {
  const levels = merkleLevels(leaves);
  if (!Number.isInteger(index) || index < 0 || index >= leaves.length) throw new RangeError(`no leaf ${index}`);
  const proof: Hex[] = [];
  let i = index;
  for (let d = 0; d < levels.length - 1; d++) {
    const sib = i ^ 1;
    if (sib < levels[d].length) proof.push(levels[d][sib]);
    i >>= 1;
  }
  return proof;
}

export function verifyProof(leaf: Hex, proof: readonly Hex[], root: Hex): boolean {
  let h = leaf.toLowerCase() as Hex;
  for (const p of proof) h = hashPair(h, p);
  return h === root.toLowerCase();
}
