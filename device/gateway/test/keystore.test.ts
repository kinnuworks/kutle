import { test } from "node:test";
import assert from "node:assert/strict";
import { mkdtempSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { openKeystore, readKeystore, sealKeystore, writeKeystore } from "../../lib/keystore.ts";
import { ecdsaAddress, randomEcdsaKey } from "../../lib/keys.ts";
import { GatewaySigner, checkSignature } from "../../lib/signer.ts";

test("keystore seals and opens, and refuses a wrong passphrase", async () => {
  const ecdsaKey = randomEcdsaKey();
  const xi = crypto.getRandomValues(new Uint8Array(32));
  const pass = "correct horse battery staple";
  const ks = sealKeystore({ ecdsaKey, xi }, pass);
  assert.equal(ks.address, ecdsaAddress(ecdsaKey));
  const path = join(mkdtempSync(join(tmpdir(), "kutle-ks-")), "k.json");
  writeKeystore(path, ks);
  const back = openKeystore(readKeystore(path), pass);
  assert.equal(back.ecdsaKey, ecdsaKey);
  assert.deepEqual(back.xi, xi);
  assert.throws(() => openKeystore(ks, "wrong passphrase!!"), /passphrase/);
  assert.throws(() => sealKeystore({ ecdsaKey, xi }, "short"), /12/);

  const s = GatewaySigner.fromKeystore(path, pass);
  const sig = await s.signPop({ chainId: 31337n, registry: "0x00000000000000000000000000000000000d3c1e", deviceId: `0x${"11".repeat(32)}`, version: 1 });
  await checkSignature(s, sig);
});
