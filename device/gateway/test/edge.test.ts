// Edge mode against the firmware's host build (firmware/sim), which runs the
// same protocol, key and signing code as the ESP32-S3 image.
import { test, before } from "node:test";
import assert from "node:assert/strict";
import { execFileSync } from "node:child_process";
import { mkdtempSync, readFileSync } from "node:fs";
import { tmpdir } from "node:os";
import { join, resolve } from "node:path";
import { fileURLToPath } from "node:url";
import { keccak256, type Address, type Hex } from "viem";
import { newStationKey, requireSeedBinding, unwrapSeed } from "../../lib/keys.ts";
import { EdgeClient } from "../../lib/edge.ts";
import { EdgeSigner, expectedBatch } from "../../lib/signer.ts";
import type { Reading } from "../../lib/reading.ts";

const fw = resolve(fileURLToPath(import.meta.url), "../../../firmware");
export const SIM = join(fw, "sim/build/kutle-sim");
const V = JSON.parse(readFileSync(new URL("../../test-vectors.json", import.meta.url), "utf8"));
const readings: Reading[] = V.readings.map((v: { reading: Reading }) => v.reading);

before(() => {
  execFileSync("make", ["-s", "-C", join(fw, "sim")], { stdio: "inherit" });
});

const ctx = (seq: bigint) => ({
  chainId: 31337n,
  readingLog: "0x000000000000000000000000000000000000106e" as Address,
  deviceId: V.batches[0].deviceId as Hex,
  passportId: 1n,
  seq,
});

test("edge device signs a batch it hashed itself, and the gateway checks it", async () => {
  const s = await EdgeSigner.open(`sim:${SIM} ${mkdtempSync(join(tmpdir(), "kutle-sim-"))}`);
  try {
    const got = await s.signBatch(ctx(0n), readings);
    const want = expectedBatch(ctx(0n), readings);
    assert.equal(got.root, want.root);
    assert.equal(got.root, V.trees[6].root);
    assert.equal(got.digest, want.digest);
    const pop = await s.signPop({ chainId: 31337n, registry: "0x00000000000000000000000000000000000d3c1e", deviceId: ctx(0n).deviceId, version: 1 });
    assert.equal(pop.digest.length, 66);
  } finally {
    s.close();
  }
});

test("the device refuses to go backwards in seq or time, and allows a retry", async () => {
  const s = await EdgeSigner.open(`sim:${SIM} ${mkdtempSync(join(tmpdir(), "kutle-sim-"))}`);
  try {
    await s.signBatch(ctx(5n), readings.slice(0, 3));
    await s.signBatch(ctx(5n), readings.slice(0, 3)); // retry of the same seq
    await assert.rejects(s.signBatch(ctx(4n), readings.slice(0, 3)), /stale-seq/);
    await assert.rejects(s.signBatch(ctx(6n), readings.slice(0, 2)), /window-regress/);
    await s.signBatch(ctx(6n), readings.slice(2, 5));
    // A different chain is a different context with its own guard.
    await s.signBatch({ ...ctx(0n), chainId: 1n }, readings.slice(0, 1));
  } finally {
    s.close();
  }
});

test("out-of-order readings and bad input are refused by the device", async () => {
  const c = EdgeClient.open(`sim:${SIM} ${mkdtempSync(join(tmpdir(), "kutle-sim-"))}`);
  try {
    const shuffled = [readings[1], readings[0]];
    await assert.rejects(c.signBatch(31337n, ctx(0n).readingLog, ctx(0n).deviceId, 1n, 0n, shuffled), /out-of-order/);
    await assert.rejects(c.request("BATCH 00 11 22"), /usage/);
    await assert.rejects(c.request("R 00"), /no-batch/);
    await assert.rejects(c.request("SAMPLE"), /not-smbus/);
  } finally {
    c.close();
  }
});

test("seed export: unwrap, commitment and KeyGen binding, then lock", async () => {
  const c = EdgeClient.open(`sim:${SIM} ${mkdtempSync(join(tmpdir(), "kutle-sim-"))}`);
  try {
    const id = await c.id();
    const pk = await c.publicKey();
    assert.equal(keccak256(pk), id.pkHash);
    const st = newStationKey();
    const w = await c.wrap(st.pub);
    const xi = unwrapSeed(st.secret, w.E, w.ct, w.tag, id.address);
    requireSeedBinding(xi, pk, id.commitment);
    await c.lock();
    assert.equal((await c.id()).locked, true);
    await assert.rejects(c.wrap(st.pub), /locked/);
  } finally {
    c.close();
  }
});

test("smbus mode: device samples its own gauge and signs its own buffer", async () => {
  const c = EdgeClient.open(`sim:${SIM} ${mkdtempSync(join(tmpdir(), "kutle-sim-"))} --smbus-fake`);
  try {
    assert.equal((await c.ping()).mode, "smbus");
    await assert.rejects(c.sample(), /no-time/);
    await c.setTime(1_800_000_000);
    for (let i = 0; i < 3; i++) await c.sample();
    const { wires, signed } = await c.ownBatch(31337n, ctx(0n).readingLog, ctx(0n).deviceId, 1n, 0n);
    assert.equal(wires.length, 3);
    assert.equal(signed.count, 3);
    assert.equal(await c.clear(3), 0);
  } finally {
    c.close();
  }
});
