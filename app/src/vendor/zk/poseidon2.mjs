// Poseidon2 over BN254, t = 4, as computed by Poseidon2Yul_BN254 on chain and by
// the noir-lang/poseidon package in circuits/shielded_spend.
//
// hash_n(x1..xn) for n <= 3 is a single permutation of [x1, x2, x3, n << 64]
// (missing inputs are zero) and returns state[0]. That is the sponge with
// IV = input_count << 64 and rate 3, which is all NotePool needs.

import { INTERNAL_DIAGONAL, ROUND_CONSTANTS } from './poseidon2-constants.mjs';

export const P = 21888242871839275222246405745257275088548364400416034343698204186575808495617n;

const ROUNDS_F = 8;
const ROUNDS_P = 56;

const mod = (x) => {
  const r = x % P;
  return r < 0n ? r + P : r;
};

const sbox = (x) => {
  const x2 = (x * x) % P;
  return (((x2 * x2) % P) * x) % P;
};

function externalMatrix(s) {
  const t0 = s[0] + s[1];
  const t1 = s[2] + s[3];
  const t2 = 2n * s[1] + t1;
  const t3 = 2n * s[3] + t0;
  const t4 = 4n * t1 + t3;
  const t5 = 4n * t0 + t2;
  const t6 = t3 + t5;
  const t7 = t2 + t4;
  return [mod(t6), mod(t5), mod(t7), mod(t4)];
}

function internalMatrix(s) {
  const sum = s[0] + s[1] + s[2] + s[3];
  return s.map((x, i) => mod(x * INTERNAL_DIAGONAL[i] + sum));
}

export function permute(input) {
  if (input.length !== 4) throw new Error('poseidon2: state must have 4 elements');
  let s = externalMatrix(input.map((x) => mod(BigInt(x))));
  const half = ROUNDS_F / 2;
  for (let r = 0; r < half; r++) {
    s = externalMatrix(s.map((x, i) => sbox(mod(x + ROUND_CONSTANTS[r][i]))));
  }
  for (let r = half; r < half + ROUNDS_P; r++) {
    s[0] = sbox(mod(s[0] + ROUND_CONSTANTS[r][0]));
    s = internalMatrix(s);
  }
  for (let r = half + ROUNDS_P; r < ROUNDS_F + ROUNDS_P; r++) {
    s = externalMatrix(s.map((x, i) => sbox(mod(x + ROUND_CONSTANTS[r][i]))));
  }
  return s;
}

/** Poseidon2 hash of 1 to 3 field elements, equal to IPoseidon2.hash_n. */
export function hash(inputs) {
  const n = inputs.length;
  if (n < 1 || n > 3) throw new Error('poseidon2: 1 to 3 inputs supported');
  const state = [0n, 0n, 0n, BigInt(n) << 64n];
  inputs.forEach((x, i) => {
    state[i] = mod(BigInt(x));
  });
  return permute(state)[0];
}

export const hash2 = (a, b) => hash([a, b]);
export const hash3 = (a, b, c) => hash([a, b, c]);
