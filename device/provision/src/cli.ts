// Provisioning station CLI. See provision/README.md for the key ceremony.
//
//   node provision/src/cli.ts keygen --out <file>            new gateway-mode keystore
//   node provision/src/cli.ts inspect                        show what an edge device reports
//   node provision/src/cli.ts register --operator <addr> (--device-id <bytes32> | --label <text>)
//
// Environment:
//   RPC_URL, DEVICE_REGISTRY, REGISTRAR_KEY
//   KUTLE_SIGNER=edge|gateway, KUTLE_DEVICE, KUTLE_KEYSTORE, KUTLE_KEYSTORE_PASSPHRASE

import { existsSync } from "node:fs";
import { parseArgs } from "node:util";
import { bytesToHex, type Hex } from "viem";
import { secp256k1 } from "@noble/curves/secp256k1.js";
import { asAddress, asBytes32, clients, deviceIdFromLabel, requireEnv } from "../../lib/chain.ts";
import { largeLiftCount, mldsaKeygen, requireNonDegenerate } from "../../lib/keys.ts";
import { passphraseFromEnv, sealKeystore, writeKeystore } from "../../lib/keystore.ts";
import { EdgeSigner, openSigner } from "../../lib/signer.ts";
import { provisionDevice } from "./register.ts";

const { positionals, values } = parseArgs({
  allowPositionals: true,
  options: {
    out: { type: "string" },
    operator: { type: "string" },
    "device-id": { type: "string" },
    label: { type: "string" },
  },
});

async function main() {
  switch (positionals[0]) {
    case "keygen": {
      if (!values.out) throw new Error("--out <file> is required");
      if (existsSync(values.out)) throw new Error(`${values.out} exists; refusing to overwrite a keystore`);
      // Both secrets come from the OS CSPRNG on the station and are written
      // only in sealed form.
      const ecdsaKey = bytesToHex(secp256k1.utils.randomSecretKey());
      const xi = crypto.getRandomValues(new Uint8Array(32));
      const big = requireNonDegenerate(mldsaKeygen(xi).publicKey);
      const ks = sealKeystore({ ecdsaKey, xi }, passphraseFromEnv());
      xi.fill(0);
      writeKeystore(values.out, ks);
      console.log(JSON.stringify({ keystore: values.out, address: ks.address, pkHash: ks.pkHash, commitment: ks.commitment, largeLiftCount: big }, null, 2));
      return;
    }
    case "inspect": {
      const s = await EdgeSigner.open(requireEnv("KUTLE_DEVICE"));
      try {
        const info = await s.client.ping();
        const id = await s.client.id();
        console.log(JSON.stringify({ ...info, ...id, largeLiftCount: largeLiftCount(s.publicKey) }, null, 2));
      } finally {
        s.close();
      }
      return;
    }
    case "register": {
      if (!values.operator) throw new Error("--operator <address> is required");
      const deviceId = values["device-id"]
        ? asBytes32(values["device-id"])
        : values.label
          ? deviceIdFromLabel(values.label)
          : (() => {
              throw new Error("--device-id or --label is required");
            })();
      const c = await clients(requireEnv("RPC_URL"), requireEnv("REGISTRAR_KEY") as Hex);
      const mode = process.env.KUTLE_SIGNER ?? "edge";
      const signer = await openSigner({ mode, device: process.env.KUTLE_DEVICE, keystore: process.env.KUTLE_KEYSTORE });
      try {
        const rec = await provisionDevice({
          clients: c,
          registry: asAddress(requireEnv("DEVICE_REGISTRY")),
          deviceId,
          operator: asAddress(values.operator),
          signer,
          keystorePath: process.env.KUTLE_KEYSTORE,
        });
        console.log(JSON.stringify(rec, null, 2));
      } finally {
        signer.close();
      }
      return;
    }
    default:
      console.log("usage: cli.ts keygen --out <file> | inspect | register --operator <addr> (--device-id <bytes32> | --label <text>)");
  }
}

main().catch((e) => {
  console.error(`error: ${e instanceof Error ? e.message : e}`);
  process.exit(1);
});
