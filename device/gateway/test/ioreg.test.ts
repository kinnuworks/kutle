import { test } from "node:test";
import assert from "node:assert/strict";
import { readFileSync } from "node:fs";
import { parsePlist, readingFromIoreg, toSigned64 } from "../src/ioreg.ts";

const xml = readFileSync(new URL("./fixtures/ioreg-apple-smart-battery.plist", import.meta.url), "utf8");

test("captured ioreg output maps onto the reading record", () => {
  const r = readingFromIoreg(xml, 1_800_000_000);
  assert.deepEqual(r, {
    timestamp: 1_800_000_000,
    cycleCount: 170,
    designCapacity_mAh: 4629,
    fullChargeCapacity_mAh: 4393, // AppleRawMaxCapacity, not the 100 % MaxCapacity
    packVoltage_mV: 11572,
    current_mA: 1831,
    temperature_centiC: 3030,
    stateOfCharge_pct: 15, // BatteryData.StateOfCharge
    cellVoltage_mV: [3839, 3852, 3859],
    cellQmax_mAh: [4805, 4810, 4868],
    cellResistance: [55, 61, 61],
  });
});

test("negative currents printed as 64-bit two's complement are reinterpreted", () => {
  assert.equal(toSigned64(18446744073709551143n), -473);
  assert.equal(toSigned64(1831), 1831);
  const discharging = xml
    .replace(/(<key>InstantAmperage<\/key>\s*<integer>)\d+/, "$118446744073709550615")
    .replace(/(<key>Amperage<\/key>\s*<integer>)\d+/, "$118446744073709550615");
  assert.equal(readingFromIoreg(discharging, 1).current_mA, -1001);
});

test("plist parser handles the value types ioreg emits", () => {
  const v = parsePlist(
    `<?xml version="1.0"?><plist version="1.0"><dict><key>a</key><integer>-5</integer><key>b</key><real>1.5</real>` +
      `<key>c</key><true/><key>d</key><array><integer>1</integer><integer>2</integer></array>` +
      `<key>e</key><string>x &amp; y</string><key>f</key><data>AQI=</data><key>g</key><dict/></dict></plist>`,
  ) as Record<string, unknown>;
  assert.equal(v.a, -5);
  assert.equal(v.b, 1.5);
  assert.equal(v.c, true);
  assert.deepEqual(v.d, [1, 2]);
  assert.equal(v.e, "x & y");
  assert.deepEqual(v.f, Uint8Array.from([1, 2]));
  assert.deepEqual(v.g, {});
});

test("a missing gauge field is an error, not a zero", () => {
  const broken = xml.replace(/<key>CycleCount<\/key>\s*<integer>\d+<\/integer>/g, "");
  assert.throws(() => readingFromIoreg(broken, 1), /missing/);
});
