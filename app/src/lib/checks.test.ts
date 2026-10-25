import { describe, expect, it } from "vitest";
import { existsSync, readFileSync } from "node:fs";
import { resolve } from "node:path";
import type { Hex } from "viem";
import {
  GRADE, assayCheck, conservationRows, gradeFor, modelVerdict, parsePassportRef, recycledMatches, verifyHybridOffline,
} from "./checks.ts";

const FIXTURE = resolve(__dirname, "../../../contracts/test/fixtures/mldsa.json");

describe("gradeFor mirrors PassportRegistry.gradeFor", () => {
  it("matches the Solidity grade table", () => {
    expect(gradeFor(8_000, 8_900)).toBe(GRADE.REUSE);
    expect(gradeFor(7_999, 8_600)).toBe(GRADE.REPURPOSE);
    expect(gradeFor(6_000, 6_900)).toBe(GRADE.REPURPOSE);
    expect(gradeFor(5_900, 6_500)).toBe(GRADE.BENCH_TEST);
    expect(gradeFor(7_000, 8_200)).toBe(GRADE.BENCH_TEST);
    expect(gradeFor(4_000, 5_999)).toBe(GRADE.RECYCLE);
  });
  it("never grades a pack below 60% for anything but recycling", () => {
    for (let lo = 0; lo <= 12_000; lo += 137) {
      for (let hi = lo; hi <= 12_000; hi += 251) {
        const g = gradeFor(lo, hi);
        if (hi < 6_000) expect(g).toBe(GRADE.RECYCLE);
        if (g === GRADE.REUSE) expect(lo).toBeGreaterThanOrEqual(8_000);
        if (g === GRADE.REPURPOSE) expect(hi - lo).toBeLessThanOrEqual(1_000);
      }
    }
  });
});

describe("conservation", () => {
  const b = {
    input: [7_500n, 11_000n, 66_000n, 0n],
    recovered: [7_125n, 6_600n, 63_360n, 0n],
    loss: [375n, 4_400n, 2_640n, 0n],
    pending: [0n, 0n, 0n, 0n],
    issuable: [625n, 0n, 57_360n, 0n],
    issued: [6_500n, 6_600n, 6_000n, 0n],
  };
  it("accepts a balanced batch", () => {
    const rows = conservationRows(b);
    expect(rows.every((r) => r.balanced && r.notesBalanced && r.underCeiling)).toBe(true);
    expect(rows[0].recoveryBps).toBe(9_500);
  });
  it("flags a batch whose books do not balance", () => {
    const bad = { ...b, loss: [374n, 4_400n, 2_640n, 0n] };
    expect(conservationRows(bad)[0].balanced).toBe(false);
  });
  it("flags issuance that does not match recovered metal", () => {
    expect(conservationRows({ ...b, issued: [7_000n, 6_600n, 6_000n, 0n] })[0].notesBalanced).toBe(false);
  });
  it("applies the per-element physical ceiling to an assay", () => {
    expect(assayCheck(7_500n, 7_425n, 75n, 0n, 0).ok).toBe(true); // exactly 99%
    expect(assayCheck(7_500n, 7_500n, 0n, 0n, 0).underCeiling).toBe(false); // 100%
    expect(assayCheck(7_500n, 7_000n, 400n, 0n, 0).balanced).toBe(false);
    const withResidual = assayCheck(7_500n, 6_930n, 70n, 500n, 0);
    expect(withResidual.processed).toBe(7_000n);
    expect(withResidual.ok).toBe(true);
  });
});

describe("model and recycled content", () => {
  it("requires a model to beat its baseline and reach 85% coverage", () => {
    const m = { maeBps: 150, baselineMaeBps: 320, coverageBps: 9_000, registeredAt: 1n, active: true };
    expect(modelVerdict(m).ok).toBe(true);
    expect(modelVerdict({ ...m, maeBps: 400 }).ok).toBe(false);
    expect(modelVerdict({ ...m, coverageBps: 8_400 }).ok).toBe(false);
    expect(modelVerdict({ ...m, registeredAt: 0n }).ok).toBe(false);
  });
  it("matches event totals against a passport's recycled grams", () => {
    expect(recycledMatches([{ element: 0, grams: 1_200n }, { element: 1, grams: 400n }, { element: 1, grams: 300n }], [1_200n, 700n, 0n, 0n])).toEqual([true, true, true, true]);
    expect(recycledMatches([{ element: 0, grams: 1_200n }], [1_000n, 0n, 0n, 0n])[0]).toBe(false);
  });
  it("parses passport references", () => {
    expect(parsePassportRef("7")).toBe(7n);
    expect(parsePassportRef("#12")).toBe(12n);
    expect(parsePassportRef("https://example.org/app/#/p/6")).toBe(6n);
    expect(parsePassportRef("https://id.kutle.example/01/08690000000017/21/KD60?pid=3")).toBe(3n);
    expect(parsePassportRef("https://id.kutle.example/01/08690000000017/21/KD60")).toBeNull();
    expect(parsePassportRef("")).toBeNull();
  });
});

describe.skipIf(!existsSync(FIXTURE))("hybrid signature check against the contract fixtures", () => {
  const fx = existsSync(FIXTURE) ? JSON.parse(readFileSync(FIXTURE, "utf8")) : null;
  const b0 = fx?.batches[0];
  const base = () => ({ digest: b0.digest as Hex, ecdsaSig: b0.ecdsaSig as Hex, mldsaSig: b0.mldsaSig as Hex, ecdsaSigner: fx.keyA1.ecdsaSigner, pk: fx.keyA1.pk as Hex, pkHash: fx.keyA1.pkHash as Hex });

  it("accepts the fixture batch signed by key A1 (ECDSA and ML-DSA-44)", async () => {
    const r = await verifyHybridOffline(base());
    expect(r).toMatchObject({ ecdsaOk: true, mldsaOk: true, pkMatches: true, mldsaSigBytes: 2_420, ecdsaSigBytes: 65 });
  });
  it("refuses a valid ECDSA signature paired with an ML-DSA signature over another digest", async () => {
    const r = await verifyHybridOffline({ ...base(), mldsaSig: fx.batches[1].mldsaSig });
    expect(r.ecdsaOk).toBe(true);
    expect(r.mldsaOk).toBe(false);
  });
  it("refuses a tampered digest and a key that does not match the registered hash", async () => {
    const t = await verifyHybridOffline({ ...base(), digest: fx.batches[1].digest });
    expect(t.ecdsaOk || t.mldsaOk).toBe(false);
    const k = await verifyHybridOffline({ ...base(), pkHash: fx.keyB1.pkHash });
    expect(k.pkMatches).toBe(false);
    expect(k.mldsaOk).toBe(false);
  });
});
