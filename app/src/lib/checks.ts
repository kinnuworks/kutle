// Pure check logic used by the Verify page. Kept free of network access so it
// can be unit tested; lib/verify.ts feeds it data read from the chain.

import { hexToBytes, keccak256, recoverMessageAddress, type Address, type Hex } from "viem";
import { ml_dsa44 } from "@noble/post-quantum/ml-dsa.js";
import { MAX_RECOVERY_BPS } from "./format.ts";

export const GRADE = { REUSE: 1, REPURPOSE: 2, BENCH_TEST: 3, RECYCLE: 4 } as const;
export const MIN_COVERAGE_BPS = 8_500;
export const BLOB_CODE_SIZE = 20_545;
export const MLDSA44_SIG_BYTES = 2_420;
export const MLDSA44_PK_BYTES = 1_312;

/** Same rule as PassportRegistry.gradeFor. */
export function gradeFor(lowBps: number, highBps: number): number {
  if (highBps < 6_000) return GRADE.RECYCLE;
  if (highBps - lowBps > 1_000) return GRADE.BENCH_TEST;
  if (lowBps >= 8_000) return GRADE.REUSE;
  if (lowBps >= 6_000) return GRADE.REPURPOSE;
  return GRADE.BENCH_TEST;
}

export interface ModelLike {
  maeBps: number;
  baselineMaeBps: number;
  coverageBps: number;
  registeredAt: bigint;
  active: boolean;
}

export function modelVerdict(m: ModelLike) {
  const registered = m.registeredAt > 0n;
  const beats = m.maeBps < m.baselineMaeBps;
  const coverageOk = m.coverageBps >= MIN_COVERAGE_BPS;
  return { registered, active: m.active, beats, coverageOk, ok: registered && m.active && beats && coverageOk };
}

export interface LedgerBatchLike {
  input: readonly bigint[];
  recovered: readonly bigint[];
  loss: readonly bigint[];
  pending: readonly bigint[];
  issuable: readonly bigint[];
  issued: readonly bigint[];
}

/** input = recovered + loss + pending for each element, and issued + issuable = recovered. */
export function conservationRows(b: LedgerBatchLike) {
  return [0, 1, 2, 3].map((e) => {
    const sum = b.recovered[e] + b.loss[e] + b.pending[e];
    const processed = b.input[e] - b.pending[e];
    const recoveryBps = processed > 0n ? Number((b.recovered[e] * 10_000n) / processed) : 0;
    return {
      element: e,
      input: b.input[e],
      recovered: b.recovered[e],
      loss: b.loss[e],
      pending: b.pending[e],
      balanced: sum === b.input[e],
      notesBalanced: b.issued[e] + b.issuable[e] === b.recovered[e],
      underCeiling: b.recovered[e] * 10_000n <= processed * BigInt(MAX_RECOVERY_BPS[e]),
      recoveryBps,
    };
  });
}

/** Per-element assay check the recycler console shows while typing. */
export function assayCheck(pending: bigint, recovered: bigint, loss: bigint, residual: bigint, element: number) {
  const balanced = recovered + loss + residual === pending;
  const processed = pending - residual;
  const ceiling = processed > 0n ? (processed * BigInt(MAX_RECOVERY_BPS[element])) / 10_000n : 0n;
  const underCeiling = recovered * 10_000n <= processed * BigInt(MAX_RECOVERY_BPS[element]);
  return { balanced, processed, ceiling, underCeiling, ok: balanced && underCeiling && residual <= pending };
}

/** Recycled grams per element from RecycledContentAdded events must equal the passport's numbers. */
export function recycledMatches(events: { element: number; grams: bigint }[], recorded: readonly bigint[]): boolean[] {
  const sums = [0n, 0n, 0n, 0n];
  for (const e of events) sums[e.element] += e.grams;
  return sums.map((s, i) => s === recorded[i]);
}

export interface HybridCheck {
  ecdsaRecovered: Address | null;
  ecdsaOk: boolean;
  mldsaOk: boolean;
  pkMatches: boolean;
  ecdsaSigBytes: number;
  mldsaSigBytes: number;
}

/**
 * Verify both signatures of a reading batch in the browser: ECDSA by recovering
 * the EIP-191 signer, ML-DSA-44 with the canonical public key (taken from the
 * registration transaction and checked against the on-chain pkHash).
 */
export async function verifyHybridOffline(p: {
  digest: Hex; ecdsaSig: Hex; mldsaSig: Hex; ecdsaSigner: Address; pk: Hex; pkHash: Hex;
}): Promise<HybridCheck> {
  let rec: Address | null = null;
  try {
    rec = await recoverMessageAddress({ message: { raw: p.digest }, signature: p.ecdsaSig });
  } catch {
    rec = null;
  }
  const pkMatches = keccak256(p.pk) === p.pkHash.toLowerCase() || keccak256(p.pk).toLowerCase() === p.pkHash.toLowerCase();
  let mldsaOk = false;
  try {
    mldsaOk = pkMatches && ml_dsa44.verify(hexToBytes(p.mldsaSig), hexToBytes(p.digest), hexToBytes(p.pk));
  } catch {
    mldsaOk = false;
  }
  return {
    ecdsaRecovered: rec,
    ecdsaOk: rec !== null && rec.toLowerCase() === p.ecdsaSigner.toLowerCase(),
    mldsaOk,
    pkMatches,
    ecdsaSigBytes: (p.ecdsaSig.length - 2) / 2,
    mldsaSigBytes: (p.mldsaSig.length - 2) / 2,
  };
}

/** Parse a passport reference: a number, "#12", a /p/12 link, or a GS1 Digital Link carrying ?pid=. */
export function parsePassportRef(input: string): bigint | null {
  const s = input.trim();
  if (!s) return null;
  if (/^#?\d+$/.test(s)) return BigInt(s.replace("#", ""));
  const m = s.match(/\/p\/(\d+)/) ?? s.match(/[?&]pid=(\d+)/);
  return m ? BigInt(m[1]) : null;
}
