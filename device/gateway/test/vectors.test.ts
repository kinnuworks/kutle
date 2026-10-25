// The TypeScript side of the shared test vectors; the firmware's native test
// (firmware/test/test_vectors) checks the same file.
import { test } from "node:test";
import assert from "node:assert/strict";
import { readFileSync } from "node:fs";
import { hexToBytes, keccak256, type Address, type Hex } from "viem";
import { batchDigest, popDigest } from "../../lib/digest.ts";
import {
  ecdsaAddress, ecdsaSignDigest, largeLiftCount, mldsaKeygen, mldsaVerify, seedCommitment, unwrapSeed, wrapSeed,
} from "../../lib/keys.ts";
import { merkleProof, merkleRoot, verifyProof } from "../../lib/merkle.ts";
import { encodeReading, fromWireHex, readingLeaf, toWireHex, type Reading } from "../../lib/reading.ts";

const V = JSON.parse(readFileSync(new URL("../../test-vectors.json", import.meta.url), "utf8"));

test("reading encodings and leaves", () => {
  for (const v of V.readings) {
    const r = v.reading as Reading;
    assert.equal(toWireHex(r), v.wire);
    assert.deepEqual(fromWireHex(v.wire), r);
    assert.equal(encodeReading(r), v.encoded);
    assert.equal(hexToBytes(v.encoded).length, 544);
    assert.equal(readingLeaf(r), v.leaf);
  }
});

test("out-of-range readings are rejected, never truncated", () => {
  const r = V.readings[0].reading as Reading;
  assert.throws(() => encodeReading({ ...r, stateOfCharge_pct: 101 }));
  assert.throws(() => encodeReading({ ...r, temperature_centiC: 40000 }));
  assert.throws(() => encodeReading({ ...r, cellVoltage_mV: [1, 2] as unknown as [number, number, number] }));
  assert.throws(() => encodeReading({ ...r, current_mA: 1.5 }));
});

test("Merkle roots and proofs", () => {
  const leaves = V.readings.map((v: { leaf: Hex }) => v.leaf);
  for (const t of V.trees) {
    const l = leaves.slice(0, t.n);
    assert.equal(merkleRoot(l), t.root);
    for (let i = 0; i < t.n; i++) {
      assert.deepEqual(merkleProof(l, i), t.proofs[i]);
      assert.ok(verifyProof(l[i], t.proofs[i], t.root));
    }
  }
  assert.equal(merkleRoot([leaves[0]]), leaves[0]);
  assert.throws(() => merkleRoot([]));
});

test("batch and pop digests", () => {
  for (const b of V.batches) {
    const d = batchDigest(BigInt(b.chainId), b.readingLog, {
      deviceId: b.deviceId, passportId: BigInt(b.passportId), seq: BigInt(b.seq), root: b.root,
      fromTs: BigInt(b.fromTs), toTs: BigInt(b.toTs), count: b.count,
    });
    assert.equal(d, b.digest);
  }
  for (const p of V.pops) {
    assert.equal(popDigest(BigInt(p.chainId), p.registry, p.deviceId, p.version, p.ecdsaSigner, p.pkHash), p.digest);
  }
});

test("key derivation, commitment and floor", () => {
  const k = V.keys;
  const { publicKey } = mldsaKeygen(hexToBytes(k.xi));
  assert.equal(keccak256(publicKey), k.pkHash);
  assert.equal(ecdsaAddress(k.ecdsaKey), k.address);
  assert.equal(seedCommitment(hexToBytes(k.xi)), k.commitment);
  assert.equal(largeLiftCount(publicKey), k.largeLiftCount);
});

test("signatures: ECDSA is deterministic, ML-DSA verifies", async () => {
  const k = V.keys;
  const pk = hexToBytes(k.pk);
  for (const b of V.batches) {
    assert.equal(await ecdsaSignDigest(k.ecdsaKey, b.digest), b.ecdsaSig);
    assert.ok(mldsaVerify(b.digest, b.mldsaSig, pk));
  }
});

test("seed wrap round trip", () => {
  const w = V.wrap;
  const again = wrapSeed(hexToBytes(w.xi), hexToBytes(w.ephemeralSecret), hexToBytes(w.stationPub), w.deviceAddress as Address);
  assert.equal(Buffer.from(again.E).toString("hex"), w.E.slice(2));
  assert.equal(Buffer.from(again.ct).toString("hex"), w.ct.slice(2));
  assert.equal(Buffer.from(again.tag).toString("hex"), w.tag.slice(2));
  const xi = unwrapSeed(hexToBytes(w.stationSecret), hexToBytes(w.E), hexToBytes(w.ct), hexToBytes(w.tag), w.deviceAddress);
  assert.equal(Buffer.from(xi).toString("hex"), w.xi.slice(2));
  const badTag = hexToBytes(w.tag);
  badTag[0] ^= 1;
  assert.throws(() => unwrapSeed(hexToBytes(w.stationSecret), hexToBytes(w.E), hexToBytes(w.ct), badTag, w.deviceAddress), /tag/);
  // Bound to the device address: unwrapping for another device fails.
  assert.throws(() => unwrapSeed(hexToBytes(w.stationSecret), hexToBytes(w.E), hexToBytes(w.ct), hexToBytes(w.tag), "0x0000000000000000000000000000000000000001"));
});
