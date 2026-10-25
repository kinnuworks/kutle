// Canonical reading record (SPEC.md section 1). The firmware's
// lib/kutle_core/src/reading.c implements the same encodings.

import { encodeAbiParameters, keccak256, parseAbiParameters, bytesToHex, hexToBytes, type Hex } from "viem";

export type Triple = [number, number, number];

export interface Reading {
  timestamp: number;
  cycleCount: number;
  designCapacity_mAh: number;
  fullChargeCapacity_mAh: number;
  packVoltage_mV: number;
  current_mA: number;
  temperature_centiC: number;
  stateOfCharge_pct: number;
  cellVoltage_mV: Triple;
  cellQmax_mAh: Triple;
  cellResistance: Triple;
}

export const READING_ABI = parseAbiParameters(
  "uint64, uint32, uint32, uint32, uint32, int32, int16, uint8, uint16[3], uint16[3], uint16[3]",
);

export const WIRE_BYTES = 49;
export const ENCODED_BYTES = 17 * 32;

const U32 = 0xffff_ffff;

function checkInt(name: string, v: number, min: number, max: number): void {
  if (!Number.isInteger(v) || v < min || v > max) {
    throw new RangeError(`reading.${name} = ${v} is outside [${min}, ${max}]`);
  }
}

/** Throws unless every field is an integer inside its type's range. */
export function validateReading(r: Reading): void {
  checkInt("timestamp", r.timestamp, 0, Number.MAX_SAFE_INTEGER);
  checkInt("cycleCount", r.cycleCount, 0, U32);
  checkInt("designCapacity_mAh", r.designCapacity_mAh, 0, U32);
  checkInt("fullChargeCapacity_mAh", r.fullChargeCapacity_mAh, 0, U32);
  checkInt("packVoltage_mV", r.packVoltage_mV, 0, U32);
  checkInt("current_mA", r.current_mA, -0x8000_0000, 0x7fff_ffff);
  checkInt("temperature_centiC", r.temperature_centiC, -0x8000, 0x7fff);
  checkInt("stateOfCharge_pct", r.stateOfCharge_pct, 0, 100);
  for (const k of ["cellVoltage_mV", "cellQmax_mAh", "cellResistance"] as const) {
    if (!Array.isArray(r[k]) || r[k].length !== 3) throw new RangeError(`reading.${k} must have 3 entries`);
    r[k].forEach((v, i) => checkInt(`${k}[${i}]`, v, 0, 0xffff));
  }
}

/** abi.encode of the record, 544 bytes. */
export function encodeReading(r: Reading): Hex {
  validateReading(r);
  return encodeAbiParameters(READING_ABI, [
    BigInt(r.timestamp),
    r.cycleCount,
    r.designCapacity_mAh,
    r.fullChargeCapacity_mAh,
    r.packVoltage_mV,
    r.current_mA,
    r.temperature_centiC,
    r.stateOfCharge_pct,
    r.cellVoltage_mV,
    r.cellQmax_mAh,
    r.cellResistance,
  ]);
}

/** leaf = keccak256(bytes.concat(keccak256(abi.encode(...)))) */
export function readingLeaf(r: Reading): Hex {
  return keccak256(keccak256(encodeReading(r)));
}

/** 49-byte big-endian wire form (SPEC.md 1.2). */
export function toWire(r: Reading): Uint8Array {
  validateReading(r);
  const b = new Uint8Array(WIRE_BYTES);
  const v = new DataView(b.buffer);
  v.setBigUint64(0, BigInt(r.timestamp));
  v.setUint32(8, r.cycleCount);
  v.setUint32(12, r.designCapacity_mAh);
  v.setUint32(16, r.fullChargeCapacity_mAh);
  v.setUint32(20, r.packVoltage_mV);
  v.setInt32(24, r.current_mA);
  v.setInt16(28, r.temperature_centiC);
  v.setUint8(30, r.stateOfCharge_pct);
  let off = 31;
  for (const arr of [r.cellVoltage_mV, r.cellQmax_mAh, r.cellResistance]) {
    for (const x of arr) {
      v.setUint16(off, x);
      off += 2;
    }
  }
  return b;
}

export function fromWire(bytes: Uint8Array): Reading {
  if (bytes.length !== WIRE_BYTES) throw new RangeError(`wire reading must be ${WIRE_BYTES} bytes, got ${bytes.length}`);
  const v = new DataView(bytes.buffer, bytes.byteOffset, bytes.byteLength);
  const ts = v.getBigUint64(0);
  if (ts > BigInt(Number.MAX_SAFE_INTEGER)) throw new RangeError("timestamp too large");
  const tri = (off: number): Triple => [v.getUint16(off), v.getUint16(off + 2), v.getUint16(off + 4)];
  const r: Reading = {
    timestamp: Number(ts),
    cycleCount: v.getUint32(8),
    designCapacity_mAh: v.getUint32(12),
    fullChargeCapacity_mAh: v.getUint32(16),
    packVoltage_mV: v.getUint32(20),
    current_mA: v.getInt32(24),
    temperature_centiC: v.getInt16(28),
    stateOfCharge_pct: v.getUint8(30),
    cellVoltage_mV: tri(31),
    cellQmax_mAh: tri(37),
    cellResistance: tri(43),
  };
  validateReading(r);
  return r;
}

export const toWireHex = (r: Reading): string => bytesToHex(toWire(r)).slice(2);
export const fromWireHex = (h: string): Reading => fromWire(hexToBytes((h.startsWith("0x") ? h : `0x${h}`) as Hex));

/** SBS 0x08 Temperature is in 0.1 K. */
export const deciKelvinToCentiC = (dK: number): number => dK * 10 - 27315;
