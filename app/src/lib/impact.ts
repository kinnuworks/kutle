// Avoided-emission factors. PassportRegistry uses the same ones on chain
// (MFG_G_PER_WH_LOW/HIGH and ALLOC_LOW/HIGH_BPS).
export const MFG_LOW = 58; // kg CO2e per kWh of cells, Fraunhofer ISI
export const MFG_HIGH = 92;
export const ALLOC_LOW = 0.15; // share relieved by a second life, Chalmers (energy allocation)
export const ALLOC_HIGH = 0.29;

/** Tonnes CO2e avoided by moving `kwh` of packs with `retained` capacity left into second life. */
export function avoidedTonnes(kwh: number, retained: number) {
  const k = kwh * retained;
  const lo = (k * MFG_LOW) / 1000;
  const hi = (k * MFG_HIGH) / 1000;
  return { lo, hi, aLo: lo * ALLOC_LOW, aHi: hi * ALLOC_HIGH };
}
