// Reads this Mac's battery gauge through `ioreg -r -c AppleSmartBattery -a`
// and maps it onto the canonical reading record (SPEC.md section 1).

import { execFileSync } from "node:child_process";
import type { Reading, Triple } from "../../lib/reading.ts";
import { validateReading } from "../../lib/reading.ts";

export type PlistValue = string | number | bigint | boolean | Uint8Array | Date | PlistValue[] | { [k: string]: PlistValue };

const TOKEN = /<(\/?)([a-zA-Z]+)(?:\s[^>]*?)?(\/)?>|([^<]+)/g;

/** Small XML plist parser: dict, array, integer, real, string, true, false, data, date. */
export function parsePlist(xml: string): PlistValue {
  const body = xml.replace(/<\?xml[^>]*\?>/, "").replace(/<!DOCTYPE[^>]*>/, "");
  const toks: { close: boolean; tag?: string; selfClose?: boolean; text?: string }[] = [];
  for (const m of body.matchAll(TOKEN)) {
    if (m[2]) toks.push({ close: m[1] === "/", tag: m[2], selfClose: !!m[3] });
    else if (m[4].trim()) toks.push({ close: false, text: m[4] });
  }
  let i = 0;
  const unescape = (s: string) =>
    s.replace(/&lt;/g, "<").replace(/&gt;/g, ">").replace(/&quot;/g, '"').replace(/&apos;/g, "'").replace(/&amp;/g, "&");
  const text = (tag: string): string => {
    let s = "";
    while (i < toks.length && !(toks[i].close && toks[i].tag === tag)) s += toks[i++].text ?? "";
    i++; // closing tag
    return s;
  };
  const value = (): PlistValue => {
    const t = toks[i++];
    if (!t || !t.tag || t.close) throw new Error(`plist: unexpected token at ${i}`);
    if (t.selfClose) {
      if (t.tag === "true") return true;
      if (t.tag === "false") return false;
      if (t.tag === "dict") return {};
      if (t.tag === "array") return [];
      if (t.tag === "string") return "";
      throw new Error(`plist: empty <${t.tag}/>`);
    }
    switch (t.tag) {
      case "plist":
        { const v = value(); i++; return v; }
      case "dict": {
        const o: { [k: string]: PlistValue } = {};
        while (!(toks[i].close && toks[i].tag === "dict")) {
          if (toks[i].tag !== "key") throw new Error("plist: dict entry without <key>");
          i++;
          const k = unescape(text("key"));
          o[k] = value();
        }
        i++;
        return o;
      }
      case "array": {
        const a: PlistValue[] = [];
        while (!(toks[i].close && toks[i].tag === "array")) a.push(value());
        i++;
        return a;
      }
      case "integer": {
        const s = text("integer").trim();
        const b = BigInt(s);
        return b >= BigInt(Number.MIN_SAFE_INTEGER) && b <= BigInt(Number.MAX_SAFE_INTEGER) ? Number(b) : b;
      }
      case "real":
        return Number(text("real").trim());
      case "string":
        return unescape(text("string"));
      case "data":
        return Uint8Array.from(Buffer.from(text("data").replace(/\s+/g, ""), "base64"));
      case "date":
        return new Date(text("date").trim());
      case "true":
        text("true");
        return true;
      case "false":
        text("false");
        return false;
      default:
        throw new Error(`plist: unsupported <${t.tag}>`);
    }
  };
  return value();
}

type Dict = { [k: string]: PlistValue };

/** ioreg prints negative values as 64-bit two's complement. */
export function toSigned64(v: PlistValue | undefined): number | undefined {
  if (v === undefined) return undefined;
  if (typeof v === "number") return v >= 2 ** 63 ? Number(BigInt(v) - (1n << 64n)) : v;
  if (typeof v === "bigint") return Number(v >= 1n << 63n ? v - (1n << 64n) : v);
  return undefined;
}

const num = (v: PlistValue | undefined): number | undefined => (typeof v === "number" ? v : typeof v === "bigint" ? Number(v) : undefined);

function triple(v: PlistValue | undefined): Triple {
  const a = Array.isArray(v) ? v.map((x) => num(x) ?? 0) : [];
  return [a[0] ?? 0, a[1] ?? 0, a[2] ?? 0];
}

function first(...vals: (number | undefined)[]): number {
  for (const v of vals) if (v !== undefined) return v;
  throw new Error("battery field missing from ioreg output");
}

/** Map one AppleSmartBattery entry to a reading. */
export function readingFromIoreg(xml: string, timestamp: number): Reading {
  const root = parsePlist(xml);
  const entry = (Array.isArray(root) ? root[0] : root) as Dict | undefined;
  if (!entry || typeof entry !== "object") throw new Error("no AppleSmartBattery entry in ioreg output");
  const bd = (entry.BatteryData ?? {}) as Dict;
  const r: Reading = {
    timestamp,
    cycleCount: first(num(entry.CycleCount), num(bd.CycleCount)),
    designCapacity_mAh: first(num(entry.DesignCapacity), num(bd.DesignCapacity)),
    fullChargeCapacity_mAh: first(num(entry.AppleRawMaxCapacity), num(entry.NominalChargeCapacity)),
    packVoltage_mV: first(num(entry.Voltage), num(bd.Voltage)),
    current_mA: first(toSigned64(entry.InstantAmperage), toSigned64(entry.Amperage)),
    temperature_centiC: first(num(entry.Temperature)),
    stateOfCharge_pct: first(num(bd.StateOfCharge), num(entry.CurrentCapacity)),
    cellVoltage_mV: triple(bd.CellVoltage),
    cellQmax_mAh: triple(bd.Qmax),
    cellResistance: triple(bd.WeightedRa),
  };
  validateReading(r);
  return r;
}

export function captureIoreg(): string {
  return execFileSync("ioreg", ["-r", "-c", "AppleSmartBattery", "-a"], { encoding: "utf8", maxBuffer: 16 << 20 });
}

export function sampleThisMac(now = Math.floor(Date.now() / 1000)): Reading {
  return readingFromIoreg(captureIoreg(), now);
}
