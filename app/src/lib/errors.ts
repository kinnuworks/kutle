// Decoding of revert data against every contract ABI in the system, including
// library errors (MLDSAKey, Conservation, Elements), the UltraHonk verifier's
// errors, and nested reverts such as KutleCouncil.CallFailed(bytes reason).

import { decodeErrorResult, toFunctionSelector, type Abi, type Hex } from "viem";

type AbiError = Extract<Abi[number], { type: "error" }>;
import * as abis from "../abi/index.ts";

export interface DecodedError {
  /** 4-byte selector, or "" for empty revert data */
  selector: Hex | "";
  name: string;
  /** contracts whose ABI declares this error */
  sources: string[];
  args: { name: string; type: string; value: string }[];
  /** error carried inside a bytes argument (e.g. CallFailed(reason)) */
  inner?: DecodedError;
  raw: Hex;
}

const SOURCES: Record<string, string> = {
  deviceRegistryAbi: "DeviceRegistry",
  readingLogAbi: "ReadingLog",
  passportRegistryAbi: "PassportRegistry",
  modelRegistryAbi: "ModelRegistry",
  conservationLedgerAbi: "ConservationLedger",
  notePoolAbi: "NotePool",
  kutleCouncilAbi: "KutleCouncil",
  timelockControllerAbi: "TimelockController",
  shieldedSpendVerifierAbi: "ShieldedSpendVerifier",
  mldsa44VerifierAbi: "MLDSA44Verifier",
  mldsaKeyAbi: "MLDSAKey",
  conservationAbi: "Conservation",
  elementsAbi: "Elements",
};

const STANDARD: AbiError[] = [
  { type: "error", name: "Error", inputs: [{ name: "message", type: "string" }] },
  { type: "error", name: "Panic", inputs: [{ name: "code", type: "uint256" }] },
];

const signature = (e: AbiError) => `${e.name}(${e.inputs.map((i) => i.type).join(",")})`;

/** selector -> { error item, contracts declaring it } */
export const errorIndex: Map<string, { item: AbiError; sources: Set<string> }> = (() => {
  const m = new Map<string, { item: AbiError; sources: Set<string> }>();
  const add = (item: AbiError, src: string) => {
    const sel = toFunctionSelector(signature(item)).toLowerCase();
    const cur = m.get(sel);
    if (cur) cur.sources.add(src);
    else m.set(sel, { item, sources: new Set([src]) });
  };
  for (const [key, list] of Object.entries(abis)) {
    for (const item of list as Abi) if (item.type === "error") add(item, SOURCES[key] ?? key);
  }
  for (const e of STANDARD) add(e, "Solidity");
  return m;
})();

export const errorAbi: AbiError[] = [...errorIndex.values()].map((v) => v.item);

const show = (v: unknown): string =>
  typeof v === "bigint" ? v.toString() : Array.isArray(v) ? `[${v.map(show).join(", ")}]` : String(v);

export function decodeRevertData(data: Hex, depth = 0): DecodedError {
  const raw = data;
  if (!data || data === "0x") return { selector: "", name: "empty revert", sources: [], args: [], raw };
  const selector = data.slice(0, 10).toLowerCase() as Hex;
  const hit = errorIndex.get(selector);
  if (!hit) return { selector, name: "unknown error", sources: [], args: [], raw };
  let decoded: { args?: readonly unknown[] };
  try {
    decoded = decodeErrorResult({ abi: [hit.item], data });
  } catch {
    return { selector, name: hit.item.name, sources: [...hit.sources], args: [], raw };
  }
  const args = hit.item.inputs.map((inp, i) => ({ name: inp.name ?? `arg${i}`, type: inp.type, value: show(decoded.args?.[i]) }));
  const out: DecodedError = { selector, name: hit.item.name, sources: [...hit.sources], args, raw };
  // A bytes argument that itself looks like revert data is decoded one level down.
  const bytesIdx = hit.item.inputs.findIndex((i) => i.type === "bytes");
  if (bytesIdx >= 0 && depth < 3) {
    const inner = decoded.args?.[bytesIdx] as Hex | undefined;
    if (inner && inner.length >= 10) out.inner = decodeRevertData(inner, depth + 1);
  }
  return out;
}

/** The innermost error, which is the one a reader cares about. */
export function rootCause(e: DecodedError): DecodedError {
  return e.inner ? rootCause(e.inner) : e;
}

/** Pull revert data out of a viem error (or anything shaped like one). */
export function revertDataFrom(err: unknown): Hex | undefined {
  const seen = new Set<unknown>();
  let cur: unknown = err;
  while (cur && typeof cur === "object" && !seen.has(cur)) {
    seen.add(cur);
    const o = cur as Record<string, unknown>;
    const d = o.data;
    if (typeof d === "string" && /^0x[0-9a-fA-F]*$/.test(d)) return d as Hex;
    if (d && typeof d === "object" && typeof (d as Record<string, unknown>).data === "string") return (d as { data: Hex }).data;
    if (typeof o.raw === "string" && /^0x[0-9a-fA-F]+$/.test(o.raw)) return o.raw as Hex;
    cur = o.cause;
  }
  return undefined;
}

export function formatDecoded(e: DecodedError): string {
  const args = e.args.filter((a) => a.type !== "bytes" || !e.inner).map((a) => a.value).join(", ");
  const own = `${e.name}(${args})`;
  return e.inner ? `${own} -> ${formatDecoded(e.inner)}` : own;
}

/** Short human message for any thrown error. */
export function errorMessage(err: unknown): string {
  const data = revertDataFrom(err);
  if (data) return formatDecoded(decodeRevertData(data));
  const o = err as { shortMessage?: string; message?: string };
  return o?.shortMessage ?? o?.message ?? String(err);
}
