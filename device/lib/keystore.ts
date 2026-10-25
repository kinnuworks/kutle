// Encrypted keystore for the gateway's fallback signer. The two device secrets
// (ecdsaKey, xi) are sealed with AES-256-GCM under a key from scrypt. The public
// fields are stored in the clear so the gateway can check it holds the key the
// registry knows without decrypting.

import { createCipheriv, createDecipheriv, randomBytes, scryptSync } from "node:crypto";
import { readFileSync, writeFileSync } from "node:fs";
import { bytesToHex, hexToBytes, keccak256, type Address, type Hex } from "viem";
import { ecdsaAddress, mldsaKeygen, seedCommitment } from "./keys.ts";

export interface KeystoreFile {
  version: 1;
  kind: "kutle-device-keystore";
  address: Address;
  pkHash: Hex;
  commitment: Hex;
  kdf: { name: "scrypt"; N: number; r: number; p: number; salt: Hex };
  cipher: { name: "aes-256-gcm"; iv: Hex; tag: Hex; ct: Hex };
}

export interface DeviceSecrets {
  ecdsaKey: Hex;
  xi: Uint8Array;
}

const N = 1 << 17;
const R = 8;
const P = 1;

function deriveKey(pass: string, salt: Buffer, n: number, r: number, p: number): Buffer {
  return scryptSync(pass.normalize("NFKC"), salt, 32, { N: n, r, p, maxmem: 256 * n * r });
}

export function sealKeystore(secrets: DeviceSecrets, passphrase: string): KeystoreFile {
  if (passphrase.length < 12) throw new Error("keystore passphrase must be at least 12 characters");
  const salt = randomBytes(32);
  const iv = randomBytes(12);
  const key = deriveKey(passphrase, salt, N, R, P);
  const c = createCipheriv("aes-256-gcm", key, iv);
  const address = ecdsaAddress(secrets.ecdsaKey);
  c.setAAD(Buffer.from(address.toLowerCase()));
  const plain = Buffer.concat([Buffer.from(hexToBytes(secrets.ecdsaKey)), Buffer.from(secrets.xi)]);
  const ct = Buffer.concat([c.update(plain), c.final()]);
  plain.fill(0);
  key.fill(0);
  return {
    version: 1,
    kind: "kutle-device-keystore",
    address,
    pkHash: keccak256(mldsaKeygen(secrets.xi).publicKey),
    commitment: seedCommitment(secrets.xi),
    kdf: { name: "scrypt", N, r: R, p: P, salt: bytesToHex(salt) },
    cipher: { name: "aes-256-gcm", iv: bytesToHex(iv), tag: bytesToHex(c.getAuthTag()), ct: bytesToHex(ct) },
  };
}

export function openKeystore(ks: KeystoreFile, passphrase: string): DeviceSecrets {
  if (ks.kind !== "kutle-device-keystore" || ks.version !== 1) throw new Error("not a Kütle device keystore");
  const key = deriveKey(passphrase, Buffer.from(hexToBytes(ks.kdf.salt)), ks.kdf.N, ks.kdf.r, ks.kdf.p);
  const d = createDecipheriv("aes-256-gcm", key, Buffer.from(hexToBytes(ks.cipher.iv)));
  d.setAAD(Buffer.from(ks.address.toLowerCase()));
  d.setAuthTag(Buffer.from(hexToBytes(ks.cipher.tag)));
  let plain: Buffer;
  try {
    plain = Buffer.concat([d.update(Buffer.from(hexToBytes(ks.cipher.ct))), d.final()]);
  } catch {
    throw new Error("wrong keystore passphrase or corrupted keystore");
  } finally {
    key.fill(0);
  }
  const secrets = { ecdsaKey: bytesToHex(plain.subarray(0, 32)), xi: new Uint8Array(plain.subarray(32, 64)) };
  plain.fill(0);
  if (ecdsaAddress(secrets.ecdsaKey) !== ks.address) throw new Error("keystore address does not match its key");
  if (seedCommitment(secrets.xi) !== ks.commitment) throw new Error("keystore commitment does not match its seed");
  return secrets;
}

export const readKeystore = (path: string): KeystoreFile => JSON.parse(readFileSync(path, "utf8"));
export const writeKeystore = (path: string, ks: KeystoreFile): void =>
  writeFileSync(path, JSON.stringify(ks, null, 2) + "\n", { mode: 0o600 });

export function passphraseFromEnv(): string {
  const p = process.env.KUTLE_KEYSTORE_PASSPHRASE;
  if (!p) throw new Error("set KUTLE_KEYSTORE_PASSPHRASE to unlock the keystore");
  return p;
}
