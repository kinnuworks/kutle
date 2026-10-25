// The demo maker's note wallet: finds its notes on chain from the owner secret,
// remembers change notes (their grams are private, so only the wallet knows them).

import { notePoolAbi } from "../abi/index.ts";
import { CHAIN_ID } from "../config/index.ts";
import { publicClient } from "./chain.ts";
import { dep, getDemo, getNoteEvents } from "./data.ts";
import { findOwnedNotes, NoteTree, type OwnedNote } from "./zk/notes.ts";

export interface KnownChange {
  element: number;
  grams: bigint;
  saltIndex: number;
  leafIndex: number;
}

const key = () => `kutle.wallet.change.${CHAIN_ID}.${dep().notePool.toLowerCase()}`;

export function localChange(): KnownChange[] {
  try {
    const raw = localStorage.getItem(key());
    return raw ? (JSON.parse(raw) as { element: number; grams: string; saltIndex: number; leafIndex: number }[]).map((x) => ({ ...x, grams: BigInt(x.grams) })) : [];
  } catch {
    return [];
  }
}

export function rememberChange(c: KnownChange) {
  try {
    const all = [...localChange().filter((x) => x.leafIndex !== c.leafIndex), c];
    localStorage.setItem(key(), JSON.stringify(all.map((x) => ({ ...x, grams: x.grams.toString() }))));
  } catch {
    /* storage blocked: the note stays spendable only in this session */
  }
}

export interface WalletNote extends OwnedNote {
  spent: boolean;
}

export async function loadWallet(secret: bigint) {
  const [demo, ev] = await Promise.all([getDemo(), getNoteEvents()]);
  const tree = NoteTree.fromEvents([...ev.minted, ...ev.change].map((l) => ({ leafIndex: l.args.leafIndex!, leaf: l.args.leaf!, root: l.args.root! })));
  const seeded: KnownChange[] = (demo?.notes.makerChange ?? []).map((x) => ({ ...x, grams: BigInt(x.grams) }));
  const known = [...seeded, ...localChange()].filter((k, i, all) => all.findIndex((y) => y.leafIndex === k.leafIndex) === i);
  // keep only change notes whose leaf really is in the tree
  const owned = findOwnedNotes(
    secret,
    ev.minted.map((m) => ({ leafIndex: m.args.leafIndex!, leaf: m.args.leaf!, element: m.args.element!, grams: m.args.grams! })),
    known,
  ).filter((n) => tree.node(0, n.leafIndex) === n.leaf);
  const spent = await Promise.all(
    owned.map((n) => publicClient.readContract({ address: dep().notePool, abi: notePoolAbi, functionName: "nullifierSpent", args: [n.nullifier] })),
  );
  return { tree, notes: owned.map((n, i) => ({ ...n, spent: spent[i] })) as WalletNote[], minted: ev.minted.length };
}
