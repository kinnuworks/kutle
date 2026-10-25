// Typed reads from the deployed contracts. Every function here talks to the
// chain directly; nothing is cached on a server.

import { decodeFunctionData, type Address, type Hex } from "viem";
import {
  conservationLedgerAbi, deviceRegistryAbi, modelRegistryAbi, notePoolAbi, passportRegistryAbi, readingLogAbi,
} from "../abi/index.ts";
import { CHAIN_ID, FROM_BLOCK, deployment, type Deployment } from "../config/index.ts";
import { publicClient } from "./chain.ts";
import type { Reading } from "./readings.ts";

export function dep(): Deployment {
  if (!deployment) throw new Error(`No deployment for chain ${CHAIN_ID}`);
  return deployment;
}

// ---------------------------------------------------------------- demo data

export interface DemoData {
  chainId: number;
  generatedAt: string;
  roles: Record<string, Address>;
  devices: Record<string, { deviceId: Hex; label: string; operator: Address; ecdsaSigner: Address; pkBlob: Address; pkHash: Hex; registerTx: Hex }>;
  passports: Record<string, unknown> & {
    story: number;
    storyChild: number;
    newBattery: number;
    target: number;
    spares: number[];
  };
  batches: { settled: number; pending: number };
  txs: Record<string, string>;
  notes: {
    heldBackProof?: { provenFor: number; args: [string, number, string, string, string[], string, Hex] };
    makerChange: { element: number; grams: string; saltIndex: number; leafIndex: number }[];
    makerSaltsUsed: number;
    proofTimingsNode?: { witnessMs: number; proveMs: number };
  };
  model: { id: Hex; fromMetricsFile: boolean };
}

let demoCache: Promise<DemoData | null> | undefined;
export function getDemo(): Promise<DemoData | null> {
  demoCache ??= fetch(`./demo/${CHAIN_ID}.json`, { cache: "no-store" })
    .then((r) => (r.ok ? (r.json() as Promise<DemoData>) : null))
    .catch(() => null);
  return demoCache;
}

/** Off-chain reading records keyed by batch id (written by the gateway or the seeding script). */
export async function getReadingStore(): Promise<Record<string, Reading[]>> {
  try {
    const r = await fetch(`./demo/${CHAIN_ID}-readings.json`, { cache: "no-store" });
    return r.ok ? await r.json() : {};
  } catch {
    return {};
  }
}

export function passportRecord(demo: DemoData | null, id: number): Record<string, unknown> | undefined {
  const p = demo?.passports[String(id)] as { record?: Record<string, unknown>; gs1?: string } | undefined;
  return p?.record ? { ...p.record, gs1: p.gs1 } : undefined;
}

// ---------------------------------------------------------------- passports

export async function getPassport(id: bigint) {
  const d = dep();
  const [p, h] = await Promise.all([
    publicClient.readContract({ address: d.passportRegistry, abi: passportRegistryAbi, functionName: "passport", args: [id] }),
    publicClient.readContract({ address: d.passportRegistry, abi: passportRegistryAbi, functionName: "health", args: [id] }),
  ]);
  return { passport: p, health: h };
}
export type PassportView = Awaited<ReturnType<typeof getPassport>>;

export async function passportCount(): Promise<bigint> {
  return publicClient.readContract({ address: dep().passportRegistry, abi: passportRegistryAbi, functionName: "passportCount" });
}

export async function getLineage(id: bigint): Promise<{ id: bigint; status: number; category: number }[]> {
  // walk to the root, then down
  let root = id;
  for (let i = 0; i < 16; i++) {
    const { passport } = await getPassport(root);
    if (passport.parentId === 0n) break;
    root = passport.parentId;
  }
  const out: { id: bigint; status: number; category: number }[] = [];
  let cur = root;
  for (let i = 0; i < 16 && cur !== 0n; i++) {
    const { passport } = await getPassport(cur);
    out.push({ id: cur, status: passport.status, category: passport.category });
    cur = passport.childId;
  }
  return out;
}

export async function getHealthHistory(id: bigint) {
  const logs = await publicClient.getContractEvents({
    address: dep().passportRegistry, abi: passportRegistryAbi, eventName: "HealthRecorded", args: { passportId: id }, fromBlock: FROM_BLOCK,
  });
  const blocks = await Promise.all(logs.map((l) => publicClient.getBlock({ blockNumber: l.blockNumber })));
  return logs.map((l, i) => ({ ...l.args, at: Number(blocks[i].timestamp), tx: l.transactionHash }));
}
export type HealthEntry = Awaited<ReturnType<typeof getHealthHistory>>[number];

export async function getRecycledEvents(id: bigint) {
  return publicClient.getContractEvents({
    address: dep().passportRegistry, abi: passportRegistryAbi, eventName: "RecycledContentAdded", args: { passportId: id }, fromBlock: FROM_BLOCK,
  });
}

export async function getRecycledShares(id: bigint) {
  const d = dep();
  return Promise.all(
    [0, 1, 2, 3].map(async (e) => {
      const [share, m31, m36] = await Promise.all([
        publicClient.readContract({ address: d.passportRegistry, abi: passportRegistryAbi, functionName: "recycledShareBps", args: [id, e] }),
        publicClient.readContract({ address: d.passportRegistry, abi: passportRegistryAbi, functionName: "meetsMinimum", args: [id, e, false] }),
        publicClient.readContract({ address: d.passportRegistry, abi: passportRegistryAbi, functionName: "meetsMinimum", args: [id, e, true] }),
      ]);
      return { element: e, shareBps: Number(share), meets2031: m31, meets2036: m36 };
    }),
  );
}

// ---------------------------------------------------------------- readings

export async function getBatches(filter: { passportId?: bigint; deviceId?: Hex }) {
  const logs = await publicClient.getContractEvents({
    address: dep().readingLog, abi: readingLogAbi, eventName: "BatchAnchored",
    args: { passportId: filter.passportId, deviceId: filter.deviceId }, fromBlock: FROM_BLOCK,
  });
  return logs.map((l) => ({ ...l.args, tx: l.transactionHash, blockNumber: l.blockNumber }));
}
export type BatchEntry = Awaited<ReturnType<typeof getBatches>>[number];

/** Gas used and signature sizes of the transaction that anchored a batch. */
export async function getAnchorTx(hash: Hex) {
  const [tx, receipt] = await Promise.all([publicClient.getTransaction({ hash }), publicClient.getTransactionReceipt({ hash })]);
  const { args } = decodeFunctionData({ abi: readingLogAbi, data: tx.input });
  const a = args as readonly unknown[];
  const ecdsaSig = a[7] as Hex;
  const mldsaSig = a[8] as Hex;
  return {
    gasUsed: receipt.gasUsed,
    from: tx.from,
    ecdsaSigBytes: (ecdsaSig.length - 2) / 2,
    mldsaSigBytes: (mldsaSig.length - 2) / 2,
    ecdsaSig, mldsaSig,
    input: tx.input,
    to: tx.to,
    blockNumber: receipt.blockNumber,
  };
}

export async function getDeviceKey(deviceId: Hex) {
  const d = dep();
  const dev = await publicClient.readContract({ address: d.deviceRegistry, abi: deviceRegistryAbi, functionName: "devices", args: [deviceId] });
  const [operator, keyVersion, exists] = dev;
  const key = exists
    ? await publicClient.readContract({ address: d.deviceRegistry, abi: deviceRegistryAbi, functionName: "key", args: [deviceId, keyVersion] })
    : undefined;
  return { operator, keyVersion, exists, key };
}

// ---------------------------------------------------------------- models

export async function getModel(modelId: Hex) {
  return publicClient.readContract({ address: dep().modelRegistry, abi: modelRegistryAbi, functionName: "model", args: [modelId] });
}

// ---------------------------------------------------------------- ledger

export async function getLedgerBatch(batchId: bigint) {
  return publicClient.readContract({ address: dep().conservationLedger, abi: conservationLedgerAbi, functionName: "batch", args: [batchId] });
}
export type LedgerBatch = Awaited<ReturnType<typeof getLedgerBatch>>;

export async function ledgerBatchCount(): Promise<bigint> {
  return publicClient.readContract({ address: dep().conservationLedger, abi: conservationLedgerAbi, functionName: "batchCount" });
}

export async function getNoteEvents() {
  const d = dep();
  const [minted, change, spent] = await Promise.all([
    publicClient.getContractEvents({ address: d.notePool, abi: notePoolAbi, eventName: "NoteMinted", fromBlock: FROM_BLOCK }),
    publicClient.getContractEvents({ address: d.notePool, abi: notePoolAbi, eventName: "ChangeNote", fromBlock: FROM_BLOCK }),
    publicClient.getContractEvents({ address: d.notePool, abi: notePoolAbi, eventName: "Spent", fromBlock: FROM_BLOCK }),
  ]);
  return { minted, change, spent };
}

export async function getImpactTotals() {
  const d = dep();
  const read = (functionName: "avoidedGramsLow" | "avoidedGramsHigh" | "avoidedGramsAllocLow" | "avoidedGramsAllocHigh") =>
    publicClient.readContract({ address: d.passportRegistry, abi: passportRegistryAbi, functionName });
  const [lo, hi, aLo, aHi] = await Promise.all([read("avoidedGramsLow"), read("avoidedGramsHigh"), read("avoidedGramsAllocLow"), read("avoidedGramsAllocHigh")]);
  const repurposed = await publicClient.getContractEvents({ address: d.passportRegistry, abi: passportRegistryAbi, eventName: "Repurposed", fromBlock: FROM_BLOCK });
  return { lo, hi, aLo, aHi, repurposed };
}
