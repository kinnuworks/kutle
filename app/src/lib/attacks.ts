// The attack console: each attack sends a real transaction that the contracts
// must refuse. The expected error is the one the contract should raise.

import { decodeFunctionData, keccak256, stringToHex, bytesToHex, type Hex } from "viem";
import { sha256 } from "@noble/hashes/sha2.js";
import {
  conservationLedgerAbi, deviceRegistryAbi, kutleCouncilAbi, notePoolAbi, passportRegistryAbi, readingLogAbi,
} from "../abi/index.ts";
import { publicClient, roleAddress } from "./chain.ts";
import { dep, getBatches, getDemo, getLedgerBatch, type DemoData } from "./data.ts";
import { signAssay, four, type Assay } from "./assay.ts";
import { signNextBatch } from "./anchor.ts";
import { sendExpectingRevert, type FailedTx } from "./tx.ts";

export interface Attack {
  id: string;
  expected: string;
  /** other errors that mean the same refusal */
  accept?: string[];
  run: (demo: DemoData) => Promise<FailedTx>;
}

async function pendingAssay(demo: DemoData, f: (pending: readonly bigint[]) => { rec: bigint[]; loss: bigint[]; res: bigint[] }, lab: "lab" | "unaccreditedLab") {
  const batchId = BigInt(demo.batches.pending);
  const b = await getLedgerBatch(batchId);
  const { rec, loss, res } = f(b.pending);
  const labAddr = roleAddress(lab)!;
  const blk = await publicClient.getBlock();
  const a: Assay = {
    batchId, recovered: four(rec), loss: four(loss), residual: four(res),
    reportHash: keccak256(stringToHex(`attack console assay ${Date.now()}`)), lab: labAddr,
    nonce: b.assayCount, deadline: blk.timestamp + 86_400n,
  };
  const [rs, ls] = await Promise.all([signAssay("recycler", a), signAssay(lab, a)]);
  return sendExpectingRevert("recycler", { address: dep().conservationLedger, abi: conservationLedgerAbi, functionName: "settle", args: [a, rs, ls] });
}

/** Re-send the exact calldata of an earlier transaction. */
async function replay(hash: Hex) {
  const tx = await publicClient.getTransaction({ hash });
  return { input: tx.input, to: tx.to! };
}

async function latestBatchOf(demo: DemoData) {
  const bs = await getBatches({ deviceId: demo.devices.A.deviceId });
  return bs[bs.length - 1];
}

export const ATTACKS: Attack[] = [
  {
    id: "overCeiling",
    expected: "OverCeiling",
    run: (demo) => pendingAssay(demo, (p) => ({ rec: [...p], loss: [0n, 0n, 0n, 0n], res: [0n, 0n, 0n, 0n] }), "lab"),
  },
  {
    id: "overClaim",
    expected: "Unbalanced",
    run: (demo) =>
      pendingAssay(demo, (p) => ({
        rec: [p[0] + 1_500n, (p[1] * 60n) / 100n, (p[2] * 96n) / 100n, 0n],
        loss: [0n, p[1] - (p[1] * 60n) / 100n, p[2] - (p[2] * 96n) / 100n, 0n],
        res: [0n, 0n, 0n, 0n],
      }), "lab"),
  },
  {
    id: "replayAssay",
    expected: "WrongNonce",
    run: async (demo) => {
      const { input } = await replay(demo.txs.settle as Hex);
      const { args } = decodeFunctionData({ abi: conservationLedgerAbi, data: input });
      return sendExpectingRevert("recycler", { address: dep().conservationLedger, abi: conservationLedgerAbi, functionName: "settle", args: args as readonly unknown[] });
    },
  },
  {
    id: "unaccreditedLab",
    expected: "LabNotAccredited",
    run: (demo) =>
      pendingAssay(demo, (p) => {
        const rec = [(p[0] * 95n) / 100n, (p[1] * 60n) / 100n, (p[2] * 96n) / 100n, (p[3] * 95n) / 100n];
        return { rec, loss: p.map((x, i) => x - rec[i]), res: [0n, 0n, 0n, 0n] };
      }, "unaccreditedLab"),
  },
  {
    id: "doubleSpend",
    expected: "NullifierUsed",
    run: async (demo) => {
      const d = dep();
      const { input } = await replay(demo.txs.spendCobalt as Hex);
      const { args } = decodeFunctionData({ abi: notePoolAbi, data: input });
      const a = [...(args as readonly unknown[])];
      const known = await publicClient.readContract({ address: d.notePool, abi: notePoolAbi, functionName: "isKnownRoot", args: [a[3] as bigint] });
      if (!known) a[3] = await publicClient.readContract({ address: d.notePool, abi: notePoolAbi, functionName: "currentRoot" });
      return sendExpectingRevert("manufacturer", { address: d.notePool, abi: notePoolAbi, functionName: "spend", args: a });
    },
  },
  {
    id: "wrongPassport",
    // The generated UltraHonk verifier reverts on a failed sumcheck; NotePool
    // raises BadProof when a verifier returns false instead.
    expected: "SumcheckFailed",
    accept: ["BadProof", "ShpleminiFailed"],
    run: async (demo) => {
      const h = demo.notes.heldBackProof;
      if (!h) throw new Error("no held-back proof in the demo data");
      const [, element, grams, root, nfs, change, proof] = h.args;
      return sendExpectingRevert("manufacturer", {
        address: dep().notePool, abi: notePoolAbi, functionName: "spend",
        args: [BigInt(demo.passports.target), element, BigInt(grams), BigInt(root), nfs.map(BigInt), BigInt(change), proof],
      });
    },
  },
  {
    id: "replayBatch",
    expected: "BadSequence",
    run: async (demo) => {
      const last = await latestBatchOf(demo);
      const { input } = await replay(last.tx);
      const { args } = decodeFunctionData({ abi: readingLogAbi, data: input });
      return sendExpectingRevert("relayer", { address: dep().readingLog, abi: readingLogAbi, functionName: "anchor", args: args as readonly unknown[] });
    },
  },
  {
    id: "ecdsaOnly",
    expected: "BadMldsaPoP",
    run: async (demo) => {
      const b = await signNextBatch(demo.devices.A.label, demo.devices.A.deviceId, { forgeMldsa: true });
      return sendExpectingRevert("relayer", { address: dep().readingLog, abi: readingLogAbi, functionName: "anchor", args: b.args });
    },
  },
  {
    id: "revokedKey",
    expected: "KeyIsRevoked",
    run: async (demo) => {
      const c = demo.devices.C;
      const b = await signNextBatch(c.label, c.deviceId, { passportId: BigInt(demo.passports.target) });
      return sendExpectingRevert("relayer", { address: dep().readingLog, abi: readingLogAbi, functionName: "anchor", args: b.args });
    },
  },
  {
    id: "degenerateKey",
    expected: "DegenerateKey",
    run: async (demo) => {
      // t1 all zeros: forgeable without any secret (same construction as tools/fixtures/gen.mjs).
      const pk = new Uint8Array(1312);
      pk.set(sha256(new TextEncoder().encode("kutle-fixture:degenerate-rho")), 0);
      const id = keccak256(stringToHex(`attack-degenerate-${Date.now()}`));
      return sendExpectingRevert("registrar", {
        address: dep().deviceRegistry, abi: deviceRegistryAbi, functionName: "registerDevice",
        args: [id, roleAddress("manufacturer")!, roleAddress("relayer")!, bytesToHex(pk), demo.devices.A.pkBlob, "0x", "0x"],
      });
    },
  },
  {
    id: "foreignGrade",
    expected: "BatchNotForPassport",
    run: async (demo) => {
      const last = await latestBatchOf(demo);
      return sendExpectingRevert("grader", {
        address: dep().passportRegistry, abi: passportRegistryAbi, functionName: "recordHealth",
        args: [BigInt(demo.passports.target), last.batchId!, demo.model.id, 9_600, 9_400, 9_800, 2_500],
      });
    },
  },
  {
    id: "badModel",
    expected: "DoesNotBeatBaseline",
    run: async (demo) =>
      sendExpectingRevert("relayer", { address: dep().council, abi: kutleCouncilAbi, functionName: "execute", args: [BigInt(demo.txs.badModelProposal)] }),
  },
];

export async function runAttack(id: string): Promise<FailedTx> {
  const demo = await getDemo();
  if (!demo) throw new Error("No demo data for this chain");
  const a = ATTACKS.find((x) => x.id === id);
  if (!a) throw new Error(`unknown attack ${id}`);
  return a.run(demo);
}
