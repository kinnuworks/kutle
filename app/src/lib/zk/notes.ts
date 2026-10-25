// Note commitments and spend construction for the NotePool, in the browser and
// in Node. Mirrors tools/zk/prove.mjs buildSpend without the filesystem parts.

import * as np from "../../vendor/zk/notepool.mjs";
import { hash2 } from "../../vendor/zk/poseidon2.mjs";

export const P: bigint = np.P;
export const DEPTH: number = np.DEPTH;
export const INPUTS: number = np.INPUTS;
export const ownerCommit: (secret: bigint, salt: bigint) => bigint = np.ownerCommit;
export const nullifierOf: (secret: bigint, salt: bigint) => bigint = np.nullifier;
export const noteLeaf: (element: number | bigint, grams: number | bigint, commit: bigint) => bigint = np.noteLeaf;
export const bindingOf: (chainId: number | bigint, pool: string) => bigint = np.binding;
export const toHex32 = np.toHex32 as (x: bigint | number) => `0x${string}`;
export const NOTE_MINTED = np.NOTE_MINTED;
export const CHANGE_NOTE = np.CHANGE_NOTE;

export interface NoteTreeLike {
  root: bigint;
  size: number;
  node(level: number, index: number): bigint;
  path(index: number): bigint[];
  indexOf(leaf: bigint): number;
  insert(leaf: bigint): { index: number; root: bigint };
}
export const NoteTree: {
  new (): NoteTreeLike;
  fromEvents(events: { leafIndex: bigint | number; leaf: bigint; root: bigint }[]): NoteTreeLike;
  rootFrom(leaf: bigint, index: number, siblings: bigint[]): bigint;
} = np.NoteTree;

/** Salt of the i-th note a wallet receives. Deterministic so a wallet can find its notes again. */
export const noteSalt = (secret: bigint, i: number): bigint => hash2(secret, 0x6e6f7465n + BigInt(i));

export interface OwnedNote {
  element: number;
  grams: bigint;
  saltIndex: number;
  salt: bigint;
  leaf: bigint;
  leafIndex: number;
  nullifier: bigint;
  change: boolean;
}

export interface SpendRequest {
  tree: NoteTreeLike;
  element: number;
  passportId: bigint;
  declaredGrams: bigint;
  ownerSecret: bigint;
  notes: { salt: bigint; grams: bigint; leafIndex: number }[];
  changeGrams: bigint;
  changeOwnerCommit: bigint;
  binding: bigint;
}

export interface BuiltSpend {
  inputs: Record<string, unknown>;
  publicInputs: `0x${string}`[];
  root: bigint;
  nullifiers: bigint[];
  changeLeaf: bigint;
}

const U64_MAX = (1n << 64n) - 1n;

function field(x: bigint, what: string): bigint {
  if (x < 0n || x >= P) throw new Error(`${what} is not below the field modulus`);
  return x;
}

/** Check a spend against the tree and lay out the circuit inputs (see tools/zk/prove.mjs). */
export function buildSpend(req: SpendRequest): BuiltSpend {
  const { tree, element, passportId, declaredGrams, notes, changeGrams, changeOwnerCommit, binding } = req;
  if (notes.length < 1 || notes.length > INPUTS) throw new Error(`1 to ${INPUTS} notes per spend`);
  const secret = field(req.ownerSecret, "ownerSecret");
  const root = tree.root;
  const salts: bigint[] = [];
  const grams: bigint[] = [];
  const leafIndices: number[] = [];
  const paths: bigint[][] = [];
  const nullifiers: bigint[] = [];
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
    if (n.grams <= 0n || n.grams > U64_MAX) throw new Error(`note ${i}: grams out of range`);
    field(n.salt, `note ${i} salt`);
    const leaf = noteLeaf(element, n.grams, ownerCommit(secret, n.salt));
    const index = n.leafIndex;
    if (index < 0 || tree.node(0, index) !== leaf) throw new Error(`note ${i}: leaf not in tree`);
    const path = tree.path(index);
    if (NoteTree.rootFrom(leaf, index, path) !== root) throw new Error(`note ${i}: path does not reach root`);
    salts.push(n.salt);
    grams.push(n.grams);
    leafIndices.push(index);
    paths.push(path);
    nullifiers.push(nullifierOf(secret, n.salt));
    total += n.grams;
  }
  if (new Set(nullifiers.filter((x) => x !== 0n).map(String)).size !== notes.length) throw new Error("the same note appears twice");
  if (declaredGrams <= 0n || declaredGrams > U64_MAX || changeGrams < 0n) throw new Error("grams out of range");
  if (total !== declaredGrams + changeGrams) throw new Error(`notes hold ${total} g, declared ${declaredGrams} + change ${changeGrams}`);
  const changeLeaf = changeGrams === 0n ? 0n : noteLeaf(element, changeGrams, field(changeOwnerCommit, "changeOwnerCommit"));
  const h = toHex32;
  const inputs = {
    root: h(root),
    element: h(element),
    passport_id: h(passportId),
    declared_grams: h(declaredGrams),
    nullifiers: nullifiers.map(h),
    change_leaf: h(changeLeaf),
    binding: h(binding),
    owner_secret: h(secret),
    salts: salts.map(h),
    grams: grams.map(h),
    leaf_indices: leafIndices.map(h),
    paths: paths.map((p) => p.map(h)),
    change_grams: h(changeGrams),
    change_owner_commit: h(changeOwnerCommit),
  };
  const publicInputs = [root, BigInt(element), passportId, declaredGrams, ...nullifiers, changeLeaf, binding].map(h);
  return { inputs, publicInputs, root, nullifiers, changeLeaf };
}

export interface MintedEvent {
  leafIndex: bigint;
  leaf: bigint;
  element: number;
  grams: bigint;
}

/**
 * Find the notes a secret owns among minted leaves, by trying the first
 * `scan` salts. Change notes do not reveal their grams on chain, so the caller
 * passes the ones it knows about (from its local wallet).
 */
export function findOwnedNotes(
  secret: bigint,
  minted: MintedEvent[],
  knownChange: { element: number; grams: bigint; saltIndex: number; leafIndex: number }[],
  scan = 96,
): OwnedNote[] {
  const commits = Array.from({ length: scan }, (_, i) => ({ i, salt: noteSalt(secret, i), commit: 0n }));
  for (const c of commits) c.commit = ownerCommit(secret, c.salt);
  const out: OwnedNote[] = [];
  for (const ev of minted) {
    for (const c of commits) {
      if (noteLeaf(ev.element, ev.grams, c.commit) === ev.leaf) {
        out.push({
          element: ev.element, grams: ev.grams, saltIndex: c.i, salt: c.salt, leaf: ev.leaf,
          leafIndex: Number(ev.leafIndex), nullifier: nullifierOf(secret, c.salt), change: false,
        });
        break;
      }
    }
  }
  for (const k of knownChange) {
    const salt = noteSalt(secret, k.saltIndex);
    out.push({
      element: k.element, grams: k.grams, saltIndex: k.saltIndex, salt,
      leaf: noteLeaf(k.element, k.grams, ownerCommit(secret, salt)), leafIndex: k.leafIndex,
      nullifier: nullifierOf(secret, salt), change: true,
    });
  }
  return out.sort((a, b) => a.leafIndex - b.leafIndex);
}

/** Smallest salt index not yet used by any of the given notes. */
export function nextSaltIndex(owned: { saltIndex: number }[], reserved: number[] = []): number {
  const used = new Set([...owned.map((n) => n.saltIndex), ...reserved]);
  let i = 0;
  while (used.has(i)) i++;
  return i;
}
