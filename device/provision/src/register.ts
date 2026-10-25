// Provisioning station logic: check a device's keys, publish its ML-DSA blob
// and register it in DeviceRegistry. The key ceremony around this is in
// provision/README.md.

import { mkdirSync, writeFileSync } from "node:fs";
import { dirname, join, resolve } from "node:path";
import { fileURLToPath } from "node:url";
import { bytesToHex, keccak256, type Address, type Hex } from "viem";
import { prepareBlob } from "../../../tools/mldsa/prepare.mjs";
import { deviceRegistryAbi, rawDeployInitcode, type Clients } from "../../lib/chain.ts";
import { newStationKey, requireNonDegenerate, requireSeedBinding, unwrapSeed } from "../../lib/keys.ts";
import { openKeystore, passphraseFromEnv, readKeystore } from "../../lib/keystore.ts";
import { EdgeSigner, type Signer } from "../../lib/signer.ts";

export const DEFAULT_OUT_DIR = resolve(dirname(fileURLToPath(import.meta.url)), "../out");

export interface ProvisionParams {
  clients: Clients; // wallet must hold REGISTRAR_ROLE
  registry: Address;
  deviceId: Hex;
  operator: Address;
  signer: Signer;
  /** gateway mode: the keystore the signer was opened from */
  keystorePath?: string;
  outDir?: string;
  log?: (s: string) => void;
}

export interface ProvisionRecord {
  deviceId: Hex;
  chainId: string;
  registry: Address;
  operator: Address;
  signerMode: "edge" | "gateway";
  ecdsaSigner: Address;
  pkHash: Hex;
  seedCommitment: Hex | null;
  seedBinding: "verified";
  largeLiftCount: number;
  pkBlob: Address;
  pkBlobCodehash: Hex;
  popDigest: Hex;
  registerTx: Hex;
  locked: boolean;
  at: string;
}

/**
 * KeyGen-seed binding (SAFETY.md 3.1 (2)(ii)). The seed is held in memory only
 * for the comparison and wiped afterwards.
 */
async function checkSeedBinding(p: ProvisionParams, log: (s: string) => void): Promise<Hex | null> {
  if (p.signer instanceof EdgeSigner) {
    const id = await p.signer.client.id();
    if (id.locked) {
      throw new Error("device is locked: it was provisioned before and will not export its seed again");
    }
    const station = newStationKey();
    const w = await p.signer.client.wrap(station.pub);
    const xi = unwrapSeed(station.secret, w.E, w.ct, w.tag, id.address);
    station.secret.fill(0);
    try {
      requireSeedBinding(xi, p.signer.publicKey, id.commitment);
    } finally {
      xi.fill(0);
    }
    log("seed binding: device seed unwrapped, matches its commitment, KeyGen(seed) reproduces the reported key");
    return id.commitment;
  }
  if (!p.keystorePath) throw new Error("gateway-mode provisioning needs the keystore path");
  const ks = readKeystore(p.keystorePath);
  const s = openKeystore(ks, passphraseFromEnv());
  try {
    requireSeedBinding(s.xi, p.signer.publicKey, ks.commitment);
  } finally {
    s.xi.fill(0);
  }
  log("seed binding: keystore seed reproduces the signer's key");
  return ks.commitment;
}

export async function provisionDevice(p: ProvisionParams): Promise<ProvisionRecord> {
  const log = p.log ?? ((s: string) => console.error(s));
  const { publicClient, wallet, chainId } = p.clients;
  if (!wallet) throw new Error("provisioning needs REGISTRAR_KEY");
  const pk = p.signer.publicKey;
  const pkHash = keccak256(pk);

  const role = await publicClient.readContract({ address: p.registry, abi: deviceRegistryAbi, functionName: "REGISTRAR_ROLE" });
  if (!(await publicClient.readContract({ address: p.registry, abi: deviceRegistryAbi, functionName: "hasRole", args: [role, wallet.account.address] }))) {
    throw new Error(`${wallet.account.address} does not hold REGISTRAR_ROLE on ${p.registry}`);
  }
  if (await publicClient.readContract({ address: p.registry, abi: deviceRegistryAbi, functionName: "pkHashUsed", args: [pkHash] })) {
    throw new Error("this ML-DSA key is already registered");
  }

  // 1. The complete criterion: the key comes from KeyGen on the device's seed.
  const commitment = await checkSeedBinding(p, log);

  // 2. The same floor the registry applies, so a bad key never costs gas.
  const big = requireNonDegenerate(pk);
  log(`degeneracy floor: ${big} of 1024 t1 coefficients have a large centred lift (need 512)`);

  // 3. Publish prepare(pk) as a raw data contract and compare it byte for byte.
  const blob = prepareBlob(pk);
  const deployHash = await wallet.sendTransaction({ data: rawDeployInitcode(blob) });
  const deployReceipt = await publicClient.waitForTransactionReceipt({ hash: deployHash });
  const pkBlob = deployReceipt.contractAddress;
  if (deployReceipt.status !== "success" || !pkBlob) throw new Error(`blob deployment ${deployHash} failed`);
  const code = await publicClient.getCode({ address: pkBlob });
  if (code?.toLowerCase() !== bytesToHex(blob)) throw new Error("deployed blob differs from prepare(pk)");
  const pkBlobCodehash = keccak256(blob);
  log(`pk blob: ${pkBlob} (${blob.length} bytes, codehash ${pkBlobCodehash})`);

  // 4. Proof of possession, cross-checked against the registry's own digest.
  const version = 1;
  const want = await publicClient.readContract({
    address: p.registry,
    abi: deviceRegistryAbi,
    functionName: "popDigest",
    args: [p.deviceId, version, p.signer.address, pkHash],
  });
  const pop = await p.signer.signPop({ chainId, registry: p.registry, deviceId: p.deviceId, version });
  if (pop.digest.toLowerCase() !== want.toLowerCase()) throw new Error("pop digest differs from DeviceRegistry.popDigest");

  // 5. Register.
  const { request } = await publicClient.simulateContract({
    account: wallet.account,
    address: p.registry,
    abi: deviceRegistryAbi,
    functionName: "registerDevice",
    args: [p.deviceId, p.operator, p.signer.address, bytesToHex(pk), pkBlob, pop.ecdsaSig, pop.mldsaSig],
  });
  const registerTx = await wallet.writeContract(request);
  const rr = await publicClient.waitForTransactionReceipt({ hash: registerTx });
  if (rr.status !== "success") throw new Error(`registerDevice ${registerTx} reverted`);
  log(`registered device ${p.deviceId} in ${registerTx} (gas ${rr.gasUsed})`);

  // 6. An edge device stops exporting its seed from now on.
  let locked = false;
  if (p.signer instanceof EdgeSigner) {
    await p.signer.client.lock();
    locked = true;
    log("device locked: seed export disabled");
  }

  const rec: ProvisionRecord = {
    deviceId: p.deviceId,
    chainId: chainId.toString(),
    registry: p.registry,
    operator: p.operator,
    signerMode: p.signer.mode,
    ecdsaSigner: p.signer.address,
    pkHash,
    seedCommitment: commitment,
    seedBinding: "verified",
    largeLiftCount: big,
    pkBlob,
    pkBlobCodehash,
    popDigest: pop.digest,
    registerTx,
    locked,
    at: new Date().toISOString(),
  };
  const out = p.outDir ?? DEFAULT_OUT_DIR;
  mkdirSync(out, { recursive: true });
  writeFileSync(join(out, `${p.deviceId.slice(0, 18)}-${chainId}.json`), JSON.stringify(rec, null, 2) + "\n");
  return rec;
}
