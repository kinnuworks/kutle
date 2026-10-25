// Batching and anchoring. The chain is the source of truth for the per-device
// sequence number and the end of the last anchored window; both are read
// before every batch, so a batch relayed by someone else, or a crash between
// sending a transaction and recording it, does not leave the gateway out of
// step.

import { decodeEventLog, type Address, type Hex } from "viem";
import { passportAbi, readingLogAbi, type Clients } from "../../lib/chain.ts";
import { merkleProof } from "../../lib/merkle.ts";
import { fromWireHex, readingLeaf, toWireHex } from "../../lib/reading.ts";
import type { Signer } from "../../lib/signer.ts";
import type { Store, StoredBatch } from "./store.ts";

export const MAX_BATCH = 256; // matches KUTLE_MAX_BATCH in the firmware

export interface AnchorTarget {
  clients: Clients;
  readingLog: Address;
  passportId: bigint;
  deviceId: Hex;
}

export async function chainCursor(t: AnchorTarget): Promise<{ nextSeq: bigint; lastToTs: bigint }> {
  const pc = t.clients.publicClient;
  const [nextSeq, lastToTs] = await Promise.all([
    pc.readContract({ address: t.readingLog, abi: readingLogAbi, functionName: "nextSeq", args: [t.deviceId] }),
    pc.readContract({ address: t.readingLog, abi: readingLogAbi, functionName: "lastToTs", args: [t.deviceId] }),
  ]);
  return { nextSeq, lastToTs };
}

/**
 * Sign and anchor the oldest pending readings, up to maxBatch of them.
 * Returns the recorded batch, or null when nothing is pending.
 */
export async function anchorPending(
  t: AnchorTarget,
  store: Store,
  signer: Signer,
  opts: { maxBatch?: number; minBatch?: number; log?: (s: string) => void } = {},
): Promise<StoredBatch | null> {
  const log = opts.log ?? ((s: string) => console.error(s));
  const maxBatch = Math.min(opts.maxBatch ?? MAX_BATCH, MAX_BATCH);
  const { wallet, publicClient, chainId } = t.clients;
  if (!wallet) throw new Error("anchoring needs RELAYER_KEY to pay for the transaction");

  const bound = await publicClient.readContract({
    address: await publicClient.readContract({ address: t.readingLog, abi: readingLogAbi, functionName: "passports" }),
    abi: passportAbi,
    functionName: "deviceOf",
    args: [t.passportId],
  });
  if (bound.toLowerCase() !== t.deviceId.toLowerCase()) {
    throw new Error(`passport ${t.passportId} is bound to device ${bound}, not ${t.deviceId} (or is not active)`);
  }

  const { nextSeq, lastToTs } = await chainCursor(t);
  const { start, readings } = store.pending();
  let skip = 0;
  while (skip < readings.length && BigInt(readings[skip].timestamp) < lastToTs) skip++;
  if (skip > 0) log(`skipping ${skip} reading(s) older than the last anchored window (lastToTs ${lastToTs})`);
  const take = readings.slice(skip, skip + maxBatch);
  if (take.length === 0 || take.length < (opts.minBatch ?? 1)) {
    if (skip > 0) store.setState({ cursor: start + skip });
    return null;
  }

  const ctx = { chainId, readingLog: t.readingLog, deviceId: t.deviceId, passportId: t.passportId, seq: nextSeq };
  const signed = await signer.signBatch(ctx, take);
  log(`batch seq ${nextSeq}: ${signed.count} readings, root ${signed.root}, signed in ${signer.mode} mode`);

  const { request } = await publicClient.simulateContract({
    account: wallet.account,
    address: t.readingLog,
    abi: readingLogAbi,
    functionName: "anchor",
    args: [t.deviceId, t.passportId, nextSeq, signed.root, signed.fromTs, signed.toTs, signed.count, signed.ecdsaSig, signed.mldsaSig],
  });
  const txHash = await wallet.writeContract(request);
  const receipt = await publicClient.waitForTransactionReceipt({ hash: txHash });
  if (receipt.status !== "success") throw new Error(`anchor transaction ${txHash} reverted`);

  let batchId: Hex | undefined;
  for (const l of receipt.logs) {
    if (l.address.toLowerCase() !== t.readingLog.toLowerCase()) continue;
    try {
      const ev = decodeEventLog({ abi: readingLogAbi, data: l.data, topics: l.topics });
      if (ev.eventName === "BatchAnchored" && ev.args.seq === nextSeq) batchId = ev.args.batchId;
    } catch {
      /* not ours */
    }
  }
  if (!batchId) throw new Error(`no BatchAnchored event for seq ${nextSeq} in ${txHash}`);

  const rec: StoredBatch = {
    seq: nextSeq.toString(),
    batchId,
    passportId: t.passportId.toString(),
    root: signed.root,
    fromTs: signed.fromTs.toString(),
    toTs: signed.toTs.toString(),
    count: signed.count,
    digest: signed.digest,
    txHash,
    signer: signer.mode,
    wires: take.map(toWireHex),
  };
  store.appendBatch(rec);
  store.setState({ cursor: start + skip + take.length });
  log(`anchored seq ${nextSeq} as ${batchId} in ${txHash} (gas ${receipt.gasUsed})`);
  return rec;
}

export interface ReadingProof {
  batchId: Hex;
  seq: string;
  index: number;
  leaf: Hex;
  proof: Hex[];
  root: Hex;
}

/** Find a reading by its wire hex, or by (seq, index), and build its proof. */
export function buildProof(store: Store, q: { wire?: string; seq?: string; index?: number }): ReadingProof {
  for (const b of store.batches()) {
    let index = -1;
    if (q.wire !== undefined) index = b.wires.indexOf(q.wire.replace(/^0x/, "").toLowerCase());
    else if (q.seq === b.seq && q.index !== undefined && q.index < b.wires.length) index = q.index;
    if (index < 0) continue;
    const leaves = b.wires.map((w) => readingLeaf(fromWireHex(w)));
    return { batchId: b.batchId, seq: b.seq, index, leaf: leaves[index], proof: merkleProof(leaves, index), root: b.root };
  }
  throw new Error("reading not found in any anchored batch");
}

export async function verifyOnChain(clients: Clients, readingLog: Address, p: ReadingProof): Promise<boolean> {
  return clients.publicClient.readContract({
    address: readingLog,
    abi: readingLogAbi,
    functionName: "verifyReading",
    args: [p.batchId, p.leaf, p.proof],
  });
}
