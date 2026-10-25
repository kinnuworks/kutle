import type { Lang } from "../i18n/index.tsx";

export const ELEMENT_SYMBOLS = ["Co", "Li", "Ni", "Pb"] as const;

/** Mirrors contracts/src/libraries/Elements.sol (compile-time constants there). */
export const MIN_SHARE_2031_BPS = [1_600, 600, 600, 8_500] as const;
export const MIN_SHARE_2036_BPS = [2_600, 1_200, 1_500, 8_500] as const;
export const MAX_RECOVERY_BPS = [9_900, 9_800, 9_900, 9_900] as const;
export const RECOVERY_TARGET_2027_BPS = [9_000, 5_000, 9_000, 9_000] as const;

const locale = (lang: Lang) => (lang === "tr" ? "tr-TR" : "en-GB");

export function num(n: number | bigint, lang: Lang, digits = 0): string {
  return new Intl.NumberFormat(locale(lang), { maximumFractionDigits: digits, minimumFractionDigits: digits }).format(
    typeof n === "bigint" ? Number(n) : n,
  );
}

export function pct(bps: number | bigint, lang: Lang, digits = 1): string {
  return `${num(Number(bps) / 100, lang, digits)}%`;
}

export function grams(g: number | bigint, lang: Lang): string {
  const v = Number(g);
  if (Math.abs(v) >= 1_000_000) return `${num(v / 1_000_000, lang, 2)} t`;
  if (Math.abs(v) >= 10_000) return `${num(v / 1_000, lang, 1)} kg`;
  return `${num(v, lang)} g`;
}

export function shortHex(h: string, head = 6, tail = 4): string {
  if (!h || h.length <= head + tail + 2) return h;
  return `${h.slice(0, head + 2)}…${h.slice(-tail)}`;
}

export function date(ts: number | bigint, lang: Lang, withTime = false): string {
  const d = new Date(Number(ts) * 1000);
  return new Intl.DateTimeFormat(locale(lang), withTime ? { dateStyle: "medium", timeStyle: "short" } : { dateStyle: "medium" }).format(d);
}

export function ago(ts: number | bigint, lang: Lang, now = Date.now() / 1000): string {
  // a device clock slightly ahead of this browser reads as "now"
  const s = Math.max(0, Math.round(now - Number(ts)));
  const rtf = new Intl.RelativeTimeFormat(locale(lang), { numeric: "auto" });
  if (Math.abs(s) < 60) return rtf.format(-s, "second");
  if (Math.abs(s) < 3600) return rtf.format(-Math.round(s / 60), "minute");
  if (Math.abs(s) < 86_400) return rtf.format(-Math.round(s / 3600), "hour");
  return rtf.format(-Math.round(s / 86_400), "day");
}

export const bytesLen = (hex: string) => Math.max(0, (hex.length - 2) / 2);
