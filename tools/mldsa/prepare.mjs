// Builds the prepared public-key blob that MLDSA44Verifier reads with EXTCODECOPY.
//
// A JavaScript port of the public-side math in
// contracts/lib/evm-ml-dsa-verifier/prepare/prepare.py (MIT, Fireblocks), kept
// byte-compatible with it: FIPS 204 pkDecode, ExpandA (Algorithm 32), the NTT
// (Algorithm 41) and the blob layout. The provisioning station (device/provision) uses this to build
// a device's blob; the Foundry tests confirm the verifier accepts it.
//
// Blob layout, 20,545 bytes:
//   [0]            0x00 (EIP-3541 prefix)
//   [1, 65)        tr    = SHAKE256(pk, 64)
//   [65, 4161)     t1hat = NTT(2^13 * t1), 4 polys x 32 words
//   [4161, 20545)  Ahat  = ExpandA(rho), 16 polys row-major i*4+j, 32 words each
// Each 32-byte word holds coefficients 8w..8w+7, coefficient 8w+s at bit 32*s,
// serialised big-endian.

import { shake128, shake256 } from "@noble/hashes/sha3.js";

const Q = 8380417;
const N = 256;
const D = 13;
const K = 4;
const L = 4;
const ZETA = 1753;
export const BLOB_SIZE = 20545;
export const PK_SIZE = 1312;

const brv8 = (i) => parseInt(i.toString(2).padStart(8, "0").split("").reverse().join(""), 2);

function powMod(base, exp, mod) {
  let r = 1n;
  let b = BigInt(base) % BigInt(mod);
  let e = BigInt(exp);
  const m = BigInt(mod);
  while (e > 0n) {
    if (e & 1n) r = (r * b) % m;
    b = (b * b) % m;
    e >>= 1n;
  }
  return Number(r);
}

const ZETAS = Array.from({ length: 256 }, (_, i) => powMod(ZETA, brv8(i), Q));

const mod = (x) => ((x % Q) + Q) % Q;
// Products of two values below q reach 7e13, inside the 2^53 exact range.
const mulmod = (a, b) => mod(a * b);

export function ntt(a) {
  const w = a.slice();
  let m = 0;
  for (let len = 128; len >= 1; len >>= 1) {
    for (let start = 0; start < N; start += 2 * len) {
      m += 1;
      const z = ZETAS[m];
      for (let j = start; j < start + len; j++) {
        const t = mulmod(z, w[j + len]);
        w[j + len] = mod(w[j] - t);
        w[j] = mod(w[j] + t);
      }
    }
  }
  return w;
}

function rejNttPoly(seed) {
  let want = 3 * N + 96;
  for (;;) {
    const buf = shake128(seed, { dkLen: want });
    const out = [];
    for (let i = 0; i + 3 <= buf.length && out.length < N; i += 3) {
      const v = buf[i] | (buf[i + 1] << 8) | ((buf[i + 2] & 0x7f) << 16);
      if (v < Q) out.push(v);
    }
    if (out.length === N) return out;
    want *= 2; // the XOF prefix property keeps this deterministic
  }
}

function expandA(rho) {
  const rows = [];
  for (let i = 0; i < K; i++) {
    const row = [];
    for (let j = 0; j < L; j++) {
      const seed = new Uint8Array(34);
      seed.set(rho, 0);
      seed[32] = j;
      seed[33] = i;
      row.push(rejNttPoly(seed));
    }
    rows.push(row);
  }
  return rows;
}

function pkDecode(pk) {
  if (pk.length !== PK_SIZE) throw new Error(`ML-DSA-44 pk must be ${PK_SIZE} bytes, got ${pk.length}`);
  const rho = pk.slice(0, 32);
  const t1 = [];
  for (let r = 0; r < K; r++) {
    const off = 32 + 320 * r;
    const row = [];
    for (let i = 0; i < N; i++) {
      const bit = 10 * i;
      const byte = off + (bit >> 3);
      const shift = bit & 7;
      const v = (pk[byte] | (pk[byte + 1] << 8) | ((pk[byte + 2] ?? 0) << 16)) >> shift;
      row.push(v & 0x3ff);
    }
    t1.push(row);
  }
  return { rho, t1 };
}

function compact32(coeffs) {
  const out = new Uint8Array(32 * 32);
  for (let w = 0; w < 32; w++) {
    // coefficient s sits at bit 32*s of a big-endian word, so it occupies bytes
    // [28 - 4s, 32 - 4s) of the word, most significant byte first.
    for (let s = 0; s < 8; s++) {
      const c = coeffs[8 * w + s];
      const base = w * 32 + (28 - 4 * s);
      out[base] = (c >>> 24) & 0xff;
      out[base + 1] = (c >>> 16) & 0xff;
      out[base + 2] = (c >>> 8) & 0xff;
      out[base + 3] = c & 0xff;
    }
  }
  return out;
}

/** @param {Uint8Array} pk the 1312-byte FIPS 204 ML-DSA-44 public key */
export function prepareBlob(pk) {
  const { rho, t1 } = pkDecode(pk);
  const aHat = expandA(rho);
  const t1Hat = t1.map((row) => ntt(row.map((c) => mod(c * (1 << D)))));
  const blob = new Uint8Array(BLOB_SIZE);
  let off = 1; // blob[0] = 0x00
  blob.set(shake256(pk, { dkLen: 64 }), off);
  off += 64;
  for (let i = 0; i < K; i++) {
    blob.set(compact32(t1Hat[i]), off);
    off += 1024;
  }
  for (let i = 0; i < K; i++) {
    for (let j = 0; j < L; j++) {
      blob.set(compact32(aHat[i][j]), off);
      off += 1024;
    }
  }
  if (off !== BLOB_SIZE) throw new Error(`blob size ${off}`);
  return blob;
}
