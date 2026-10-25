// End to end on a local anvil chain with the real contracts and the real
// ML-DSA-44 verifier:
//
//   deploy -> provision an edge device (firmware host build) -> issue passport
//   -> anchor two batches -> prove a reading with ReadingLog.verifyReading
//   and the same for a gateway-mode (keystore) device.
//
// Needs ~/.foundry/bin/anvil (or anvil on PATH) and contracts/out from
// `forge build`. Skipped unless KUTLE_E2E=1:
//
//   KUTLE_E2E=1 node --test gateway/test/e2e.test.ts

import { test, before, after } from "node:test";
import assert from "node:assert/strict";
import { execFileSync, spawn, type ChildProcess } from "node:child_process";
import { existsSync, mkdtempSync, readFileSync } from "node:fs";
import { homedir, tmpdir } from "node:os";
import { join, resolve } from "node:path";
import { fileURLToPath } from "node:url";
import type { Hex } from "viem";
import { clients, deviceIdFromLabel, type Clients } from "../../lib/chain.ts";
import { randomEcdsaKey } from "../../lib/keys.ts";
import { sealKeystore, writeKeystore } from "../../lib/keystore.ts";
import type { Reading } from "../../lib/reading.ts";
import { EdgeSigner, GatewaySigner } from "../../lib/signer.ts";
import { provisionDevice } from "../../provision/src/register.ts";
import { ANVIL_KEY_0, deploySystem, issuePassport, type Deployment } from "../../scripts/local-chain.ts";
import { anchorPending, buildProof, chainCursor, verifyOnChain } from "../src/anchor.ts";
import { Store } from "../src/store.ts";

const enabled = process.env.KUTLE_E2E === "1";
const here = fileURLToPath(new URL(".", import.meta.url));
const fw = resolve(here, "../../firmware");
const V = JSON.parse(readFileSync(new URL("../../test-vectors.json", import.meta.url), "utf8"));
const ANVIL_KEY_1 = "0x59c6995e998f97a5a0044966f0945389dc9e86dae88c7a8412f4603b6b78690d" as Hex;

let anvil: ChildProcess | undefined;
let admin: Clients;
let relayer: Clients;
let d: Deployment;
const work = mkdtempSync(join(tmpdir(), "kutle-e2e-"));

function anvilBin(): string {
  const local = join(homedir(), ".foundry/bin/anvil");
  return existsSync(local) ? local : "anvil";
}

before(async () => {
  if (!enabled) return;
  execFileSync("make", ["-s", "-C", join(fw, "sim")], { stdio: "inherit" });
  const port = 18545 + Math.floor(Math.random() * 1000);
  anvil = spawn(anvilBin(), ["--port", String(port), "--hardfork", "osaka", "--gas-limit", "60000000"], { stdio: ["ignore", "pipe", "inherit"] });
  await new Promise<void>((res, rej) => {
    const t = setTimeout(() => rej(new Error("anvil did not start")), 20_000);
    anvil!.stdout!.on("data", (b: Buffer) => {
      if (b.toString().includes("Listening on")) {
        clearTimeout(t);
        res();
      }
    });
  });
  const rpc = `http://127.0.0.1:${port}`;
  admin = await clients(rpc, ANVIL_KEY_0);
  relayer = await clients(rpc, ANVIL_KEY_1);
  d = await deploySystem(admin);
});

after(() => {
  anvil?.kill();
});

/** The vector readings, moved to just before the chain's current time. */
async function freshReadings(offset: number): Promise<Reading[]> {
  const block = await admin.publicClient.getBlock();
  const base = Number(block.timestamp) - 3600 + offset;
  return V.readings.map((v: { reading: Reading }, i: number) => ({ ...v.reading, timestamp: base + i * 30 }));
}

test("edge device: provision, issue, anchor two batches, verify a reading", { skip: !enabled }, async () => {
  const deviceId = deviceIdFromLabel("e2e-edge-pack");
  const signer = await EdgeSigner.open(`sim:${join(fw, "sim/build/kutle-sim")} ${join(work, "edge-nvs")}`);
  try {
    const rec = await provisionDevice({
      clients: admin, registry: d.deviceRegistry, deviceId, operator: admin.wallet!.account.address, signer,
      outDir: join(work, "records"), log: () => {},
    });
    assert.equal(rec.locked, true);
    assert.equal(rec.seedBinding, "verified");

    const passportId = await issuePassport(admin, d, deviceId, "e2e-edge-pack");
    const target = { clients: relayer, readingLog: d.readingLog, passportId, deviceId };
    const store = new Store(deviceId, join(work, "data"));
    for (const r of await freshReadings(0)) store.appendReading(r);

    const b0 = await anchorPending(target, store, signer, { maxBatch: 4, log: () => {} });
    const b1 = await anchorPending(target, store, signer, { maxBatch: 4, log: () => {} });
    assert.equal(b0?.seq, "0");
    assert.equal(b1?.seq, "1");
    assert.equal(b1?.count, 3);
    assert.equal(await anchorPending(target, store, signer, { log: () => {} }), null);

    const cur = await chainCursor(target);
    assert.equal(cur.nextSeq, 2n);
    assert.equal(cur.lastToTs.toString(), b1!.toTs);

    // Every reading in both batches proves against its anchored root.
    for (const b of [b0!, b1!]) {
      for (let i = 0; i < b.count; i++) {
        const p = buildProof(store, { seq: b.seq, index: i });
        assert.equal(await verifyOnChain(relayer, d.readingLog, p), true);
      }
    }
    const p = buildProof(store, { wire: b1!.wires[2] });
    const forged = { ...p, leaf: `0x${"00".repeat(32)}` as Hex };
    assert.equal(await verifyOnChain(relayer, d.readingLog, forged), false);

    // A locked device cannot be provisioned again (its seed stays put).
    await assert.rejects(
      provisionDevice({ clients: admin, registry: d.deviceRegistry, deviceId: deviceIdFromLabel("other"), operator: admin.wallet!.account.address, signer, log: () => {} }),
      /already registered|locked/,
    );
  } finally {
    signer.close();
  }
});

test("gateway-mode device (keystore fallback): provision, anchor, verify", { skip: !enabled }, async () => {
  const deviceId = deviceIdFromLabel("e2e-gateway-pack");
  const pass = "e2e keystore passphrase";
  const ksPath = join(work, "gw.keystore.json");
  writeKeystore(ksPath, sealKeystore({ ecdsaKey: randomEcdsaKey(), xi: crypto.getRandomValues(new Uint8Array(32)) }, pass));
  process.env.KUTLE_KEYSTORE_PASSPHRASE = pass;
  const signer = GatewaySigner.fromKeystore(ksPath, pass);
  await provisionDevice({
    clients: admin, registry: d.deviceRegistry, deviceId, operator: admin.wallet!.account.address, signer,
    keystorePath: ksPath, outDir: join(work, "records"), log: () => {},
  });
  const passportId = await issuePassport(admin, d, deviceId, "e2e-gateway-pack");
  const store = new Store(deviceId, join(work, "data"));
  for (const r of await freshReadings(1000)) store.appendReading(r);
  const target = { clients: relayer, readingLog: d.readingLog, passportId, deviceId };
  const b = await anchorPending(target, store, signer, { log: () => {} });
  assert.equal(b?.count, 7);
  assert.equal(b?.signer, "gateway");
  const p = buildProof(store, { seq: "0", index: 6 });
  assert.equal(await verifyOnChain(relayer, d.readingLog, p), true);
});
