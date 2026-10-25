// Key material helpers shared by the gateway's local signer and the
// provisioning station: KeyGen from a seed, the off-chain degeneracy floor,
// the seed commitment and the seed-wrap receiver (SPEC.md section 4).

import { ml_dsa44 } from "@noble/post-quantum/ml-dsa.js";
import { secp256k1 } from "@noble/curves/secp256k1.js";
import { sha256 } from "@noble/hashes/sha2.js";
import { bytesToHex, concat, hexToBytes, keccak256, stringToBytes, type Address, type Hex } from "viem";
import { privateKeyToAccount } from "viem/accounts";

export const PK_BYTES = 1312;
export const SIG_BYTES = 2420;

/** FIPS 204 Algorithm 6, ML-DSA.KeyGen_internal(xi). */
export function mldsaKeygen(xi: Uint8Array): { publicKey: Uint8Array; secretKey: Uint8Array } {
  if (xi.length !== 32) throw new Error("ML-DSA seed must be 32 bytes");
  return ml_dsa44.keygen(xi);
}

/** Pure ML-DSA-44 signature with an empty context over the 32 digest bytes. */
export function mldsaSign(digest: Hex, secretKey: Uint8Array): Hex {
  return bytesToHex(ml_dsa44.sign(hexToBytes(digest), secretKey));
}

export function mldsaVerify(digest: Hex, sig: Hex, publicKey: Uint8Array): boolean {
  return ml_dsa44.verify(hexToBytes(sig), hexToBytes(digest), publicKey);
}

export function seedCommitment(xi: Uint8Array): Hex {
  return keccak256(concat([stringToBytes("KUTLE_SEED_COMMIT_V1"), xi]));
}

// ---------------------------------------------------------------- the floor

const Q = 8_380_417;
const D = 13;
const GAMMA2 = (Q - 1) / 88;
export const MIN_LARGE = 512;

function isLarge(v: number): number {
  const t = v << D; // v < 1024, so t < Q and no reduction is needed
  const abs = t > Math.floor(Q / 2) ? Q - t : t;
  return abs > GAMMA2 ? 1 : 0;
}

/** Same count as MLDSAKey.largeLiftCount in contracts/src/libraries/MLDSAKey.sol. */
export function largeLiftCount(pk: Uint8Array): number {
  if (pk.length !== PK_BYTES) throw new Error(`ML-DSA-44 pk must be ${PK_BYTES} bytes, got ${pk.length}`);
  let big = 0;
  for (let off = 32; off < PK_BYTES; off += 5) {
    const [b0, b1, b2, b3, b4] = pk.subarray(off, off + 5);
    big += isLarge(b0 | ((b1 & 0x03) << 8));
    big += isLarge((b1 >> 2) | ((b2 & 0x0f) << 6));
    big += isLarge((b2 >> 4) | ((b3 & 0x3f) << 4));
    big += isLarge((b3 >> 6) | (b4 << 2));
  }
  return big;
}

export function requireNonDegenerate(pk: Uint8Array): number {
  const big = largeLiftCount(pk);
  if (big < MIN_LARGE) throw new Error(`degenerate ML-DSA key: only ${big} of 1024 t1 coefficients have a large centred lift`);
  return big;
}

/**
 * KeyGen-seed binding (SAFETY.md 3.1 (2)(ii)): re-derive the key from xi and
 * require it to equal the reported key byte for byte. Throws on mismatch.
 */
export function requireSeedBinding(xi: Uint8Array, reportedPk: Uint8Array, commitment?: Hex): void {
  if (commitment !== undefined && seedCommitment(xi) !== commitment.toLowerCase()) {
    throw new Error("seed does not match the device's commitment");
  }
  const { publicKey } = mldsaKeygen(xi);
  if (publicKey.length !== reportedPk.length || !publicKey.every((b, i) => b === reportedPk[i])) {
    throw new Error("KeyGen(seed) does not reproduce the reported public key");
  }
}

// ------------------------------------------------------------ ECDSA helpers

export function ecdsaAddress(privateKey: Hex): Address {
  return privateKeyToAccount(privateKey).address;
}

/** EIP-191 personal_sign over the raw 32 digest bytes, 65-byte r||s||v. */
export async function ecdsaSignDigest(privateKey: Hex, digest: Hex): Promise<Hex> {
  return privateKeyToAccount(privateKey).signMessage({ message: { raw: digest } });
}

// ---------------------------------------------------------------- seed wrap

const WRAP_TAG = stringToBytes("KUTLE_SEED_WRAP_V1");

export interface WrapKeys {
  kEnc: Uint8Array;
  kMac: Uint8Array;
}

export function wrapKeys(z: Uint8Array, E: Uint8Array, S: Uint8Array, deviceAddress: Address): WrapKeys {
  const info = concat([WRAP_TAG, E, S, hexToBytes(deviceAddress)]);
  return {
    kEnc: hexToBytes(keccak256(concat([new Uint8Array([1]), z, info]))),
    kMac: hexToBytes(keccak256(concat([new Uint8Array([2]), z, info]))),
  };
}

/** libsecp256k1's default ECDH output: sha256 of the compressed shared point. */
export function ecdhSha256(secretKey: Uint8Array, publicKey: Uint8Array): Uint8Array {
  return sha256(secp256k1.getSharedSecret(secretKey, publicKey, true));
}

/** Device side of the wrap, used for test vectors and for the gateway keystore tests. */
export function wrapSeed(xi: Uint8Array, ephemeralSecret: Uint8Array, stationPub: Uint8Array, deviceAddress: Address) {
  const E = secp256k1.getPublicKey(ephemeralSecret, true);
  const z = ecdhSha256(ephemeralSecret, stationPub);
  const { kEnc, kMac } = wrapKeys(z, E, stationPub, deviceAddress);
  const ct = xi.map((b, i) => b ^ kEnc[i]);
  const tag = hexToBytes(keccak256(concat([kMac, ct])));
  return { E, ct, tag };
}

export function unwrapSeed(
  stationSecret: Uint8Array,
  E: Uint8Array,
  ct: Uint8Array,
  tag: Uint8Array,
  deviceAddress: Address,
): Uint8Array {
  const S = secp256k1.getPublicKey(stationSecret, true);
  const z = ecdhSha256(stationSecret, E);
  const { kEnc, kMac } = wrapKeys(z, E, S, deviceAddress);
  const expect = hexToBytes(keccak256(concat([kMac, ct])));
  let diff = expect.length ^ tag.length;
  for (let i = 0; i < expect.length; i++) diff |= expect[i] ^ (tag[i] ?? 0);
  if (diff !== 0) throw new Error("seed wrap tag mismatch");
  return ct.map((b, i) => b ^ kEnc[i]);
}

export function newStationKey(): { secret: Uint8Array; pub: Uint8Array } {
  const secret = secp256k1.utils.randomSecretKey();
  return { secret, pub: secp256k1.getPublicKey(secret, true) };
}

export function randomEcdsaKey(): Hex {
  return bytesToHex(secp256k1.utils.randomSecretKey());
}
