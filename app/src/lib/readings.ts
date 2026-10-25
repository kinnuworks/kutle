// Plausible gauge readings for the seeded demo story. The record format is the
// one in device/SPEC.md; the values are generated, and the UI labels them as
// such. The live hardware path (ESP32 next to a real gauge) lives in device/.

import type { Hex } from "viem";
import { readingLeaf, type Reading } from "../vendor/device/reading.ts";
import { merkleProof, merkleRoot } from "../vendor/device/merkle.ts";

export type { Reading };

export interface PackState {
  designCapacity_mAh: number;
  /** state of health as a fraction of design capacity at the start */
  soh: number;
  /** cycles at the start */
  cycles: number;
  /** soh lost per cycle */
  fadePerCycle: number;
  /** cycles per day */
  cyclesPerDay: number;
}

// Small deterministic PRNG so the seeded chain is reproducible.
export function rng(seedNum: number) {
  let s = seedNum >>> 0 || 1;
  return () => {
    s ^= s << 13;
    s ^= s >>> 17;
    s ^= s << 5;
    return ((s >>> 0) % 1_000_000) / 1_000_000;
  };
}

/**
 * `count` readings starting at `fromTs`, `stepSec` apart. Mutates `st` so the
 * next batch continues where this one stopped.
 */
export function generateReadings(st: PackState, fromTs: number, count: number, stepSec: number, seedNum: number): Reading[] {
  const r = rng(seedNum);
  const out: Reading[] = [];
  for (let i = 0; i < count; i++) {
    const ts = fromTs + i * stepSec;
    const cyc = st.cycles + (st.cyclesPerDay * (i * stepSec)) / 86_400;
    const soh = Math.max(0.3, st.soh - st.fadePerCycle * (cyc - st.cycles));
    const fcc = Math.round(st.designCapacity_mAh * soh);
    const soc = Math.round(20 + 70 * Math.abs(Math.sin(i / 7 + seedNum)));
    const cellV = (k: number) => Math.round(3350 + soc * 8.2 + (r() - 0.5) * 18 + k * 3);
    const cells: [number, number, number] = [cellV(0), cellV(1), cellV(2)];
    const q = (k: number) => Math.min(65_535, Math.round(fcc * (1 + (k - 1) * 0.004) + (r() - 0.5) * 120));
    const ra = (k: number) => Math.round(40 + (1 - soh) * 140 + k * 2 + r() * 3);
    out.push({
      timestamp: ts,
      cycleCount: Math.floor(cyc),
      designCapacity_mAh: st.designCapacity_mAh,
      fullChargeCapacity_mAh: fcc,
      packVoltage_mV: cells[0] + cells[1] + cells[2],
      current_mA: Math.round((r() - 0.45) * 30_000),
      temperature_centiC: Math.round(2400 + r() * 900),
      stateOfCharge_pct: Math.min(100, soc),
      cellVoltage_mV: cells,
      cellQmax_mAh: [q(0), q(1), q(2)],
      cellResistance: [ra(0), ra(1), ra(2)],
    });
  }
  const span = (count - 1) * stepSec;
  st.cycles += (st.cyclesPerDay * span) / 86_400;
  st.soh = Math.max(0.3, st.soh - st.fadePerCycle * ((st.cyclesPerDay * span) / 86_400));
  return out;
}

export function batchOf(readings: Reading[]): { leaves: Hex[]; root: Hex; fromTs: number; toTs: number; count: number } {
  const leaves = readings.map(readingLeaf);
  return {
    leaves,
    root: merkleRoot(leaves),
    fromTs: readings[0].timestamp,
    toTs: readings[readings.length - 1].timestamp,
    count: readings.length,
  };
}

export { readingLeaf, merkleProof, merkleRoot };
