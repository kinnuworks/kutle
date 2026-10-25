// Demo device keys and batch signing, shared by the seeding script (Node) and
// the browser consoles. Every key here is derived from a public label, so these
// are testnet demo keys and must never protect anything of value.
//
// Device A uses the same derivation as tools/fixtures/gen.mjs, so its ML-DSA-44
// public key equals contracts/test/fixtures/mldsa.json keyA1.pk.

import { ml_dsa44 } from "@noble/post-quantum/ml-dsa.js";
import { sha256 } from "@noble/hashes/sha2.js";
import { bytesToHex, hexToBytes, keccak256, type Hex } from "viem";
import { privateKeyToAccount, type PrivateKeyAccount } from "viem/accounts";
import { prepareBlob } from "../vendor/mldsa/prepare.mjs";

export const MLDSA44_SIG_BYTES = 2420;
export const MLDSA44_PK_BYTES = 1312;

export interface DeviceKey {
  label: string;
  ecdsa: PrivateKeyAccount;
  ecdsaPrivateKey: Hex;
  publicKey: Uint8Array;
  secretKey: Uint8Array;
  pk: Hex;
  pkHash: Hex;
}

const utf8 = (s: string) => new TextEncoder().encode(s);
const seed = (s: string) => sha256(utf8(s));

/**
 * label "fixture:deviceA-v1" reproduces tools/fixtures/gen.mjs; any other label
 * uses the "kutle-demo:" namespace.
 */
export function deviceKey(label: string): DeviceKey {
  const ns = label.startsWith("fixture:") ? "kutle-fixture" : "kutle-demo";
  const name = label.replace(/^fixture:/, "");
  const { publicKey, secretKey } = ml_dsa44.keygen(seed(`${ns}:mldsa:${name}`));
  const ecdsaPrivateKey = bytesToHex(seed(`${ns}:ecdsa:${name}`));
  const ecdsa = privateKeyToAccount(ecdsaPrivateKey);
  const pk = bytesToHex(publicKey);
  return { label, ecdsa, ecdsaPrivateKey, publicKey, secretKey, pk, pkHash: keccak256(pk) };
}

/** The 20,545-byte prepared blob the on-chain verifier reads as code. */
export function blobOf(k: DeviceKey): Hex {
  return bytesToHex(prepareBlob(k.publicKey) as Uint8Array);
}

/** Init code that deploys `runtime` verbatim (same stub as Deploy.s.sol _deployRaw). */
export function rawDeployInitcode(runtime: Hex): Hex {
  const len = (runtime.length - 2) / 2;
  if (len >= 0x10000) throw new Error("runtime too large");
  return `0x61${len.toString(16).padStart(4, "0")}80600c6000396000f3${runtime.slice(2)}` as Hex;
}

export function mldsaSign(k: DeviceKey, digest: Hex): Hex {
  return bytesToHex(ml_dsa44.sign(hexToBytes(digest), k.secretKey));
}

export function mldsaVerify(k: DeviceKey, digest: Hex, sig: Hex): boolean {
  return ml_dsa44.verify(hexToBytes(sig), hexToBytes(digest), k.publicKey);
}

/** Both signatures over a digest: EIP-191 ECDSA and raw ML-DSA-44 (SPEC.md section 3). */
export async function hybridSign(k: DeviceKey, digest: Hex): Promise<{ ecdsaSig: Hex; mldsaSig: Hex }> {
  const ecdsaSig = await k.ecdsa.signMessage({ message: { raw: digest } });
  return { ecdsaSig, mldsaSig: mldsaSign(k, digest) };
}

export const byteLength = (h: Hex) => (h.length - 2) / 2;
