import { describe, expect, it } from "vitest";
import { existsSync, readFileSync } from "node:fs";
import { resolve } from "node:path";
import { blobOf, deviceKey, hybridSign, mldsaVerify, rawDeployInitcode } from "./device.ts";
import { batchOf, generateReadings, merkleProof } from "./readings.ts";
import { verifyProof } from "../vendor/device/merkle.ts";

const FIXTURE = resolve(__dirname, "../../../contracts/test/fixtures/mldsa.json");

describe.skipIf(!existsSync(FIXTURE))("demo device keys", () => {
  const fx = existsSync(FIXTURE) ? JSON.parse(readFileSync(FIXTURE, "utf8")) : null;
  it("derives device A exactly as tools/fixtures/gen.mjs does", () => {
    const k = deviceKey("fixture:deviceA-v1");
    expect(k.pk).toBe(fx.keyA1.pk);
    expect(k.pkHash).toBe(fx.keyA1.pkHash);
    expect(k.ecdsa.address).toBe(fx.keyA1.ecdsaSigner);
    expect(blobOf(k)).toBe(fx.keyA1.blob);
  });
});

describe("signing and readings", () => {
  it("produces hybrid signatures of the expected sizes", async () => {
    const k = deviceKey("unit-test-device");
    const digest = ("0x" + "11".repeat(32)) as `0x${string}`;
    const { ecdsaSig, mldsaSig } = await hybridSign(k, digest);
    expect((ecdsaSig.length - 2) / 2).toBe(65);
    expect((mldsaSig.length - 2) / 2).toBe(2_420);
    expect(mldsaVerify(k, digest, mldsaSig)).toBe(true);
  });
  it("builds a Merkle tree whose proofs fold to the root", () => {
    const st = { designCapacity_mAh: 60_000, soh: 0.8, cycles: 1000, fadePerCycle: 0.0001, cyclesPerDay: 1 };
    const rs = generateReadings(st, 1_800_000_000, 11, 60, 3);
    const b = batchOf(rs);
    expect(b.count).toBe(11);
    for (let i = 0; i < rs.length; i++) expect(verifyProof(b.leaves[i], merkleProof(b.leaves, i), b.root)).toBe(true);
  });
  it("wraps runtime code in the 12-byte deploy stub", () => {
    expect(rawDeployInitcode("0xaabb")).toBe("0x61000280600c6000396000f3aabb");
  });
});
