import type { Lang } from "../i18n/index.tsx";
import { date, pct } from "../lib/format.ts";

export interface HealthPoint {
  at: number;
  soh: number;
  low: number;
  high: number;
  passportId?: number;
}

/** State of health over time with the prediction interval and the grade floors (80% reuse, 60% repurpose). */
export function HealthChart({ points, lang, label }: { points: HealthPoint[]; lang: Lang; label: string }) {
  const W = 640;
  const H = 240;
  const pad = { l: 44, r: 16, t: 14, b: 30 };
  if (!points.length) return null;
  const t0 = Math.min(...points.map((p) => p.at));
  const t1 = Math.max(...points.map((p) => p.at));
  const span = Math.max(1, t1 - t0);
  const yMin = 5_000;
  const yMax = 10_000;
  const x = (t: number) => pad.l + ((t - t0) / span) * (W - pad.l - pad.r);
  const y = (v: number) => pad.t + (1 - (v - yMin) / (yMax - yMin)) * (H - pad.t - pad.b);
  const sorted = [...points].sort((a, b) => a.at - b.at);
  const line = sorted.map((p, i) => `${i ? "L" : "M"}${x(p.at).toFixed(1)},${y(p.soh).toFixed(1)}`).join(" ");
  const ticks = [5_000, 6_000, 7_000, 8_000, 9_000, 10_000];
  return (
    <svg className="chart" viewBox={`0 0 ${W} ${H}`} role="img" aria-label={label}>
      {ticks.map((v) => (
        <g key={v}>
          <line className="grid" x1={pad.l} x2={W - pad.r} y1={y(v)} y2={y(v)} />
          <text x={pad.l - 8} y={y(v) + 4} textAnchor="end">{pct(v, lang, 0)}</text>
        </g>
      ))}
      <line className="floor" x1={pad.l} x2={W - pad.r} y1={y(8_000)} y2={y(8_000)} />
      <line className="floor" x1={pad.l} x2={W - pad.r} y1={y(6_000)} y2={y(6_000)} />
      {sorted.map((p, i) => (
        <rect key={`b${i}`} className="band" x={x(p.at) - 7} width={14} y={y(p.high)} height={Math.max(2, y(p.low) - y(p.high))} rx={4} />
      ))}
      <path className="line" d={line} />
      {sorted.map((p, i) => (
        <circle key={`p${i}`} className="pt" cx={x(p.at)} cy={y(p.soh)} r={4.5}>
          <title>{`${date(p.at, lang)}: ${pct(p.soh, lang)} (${pct(p.low, lang)} … ${pct(p.high, lang)})`}</title>
        </circle>
      ))}
      <text x={pad.l} y={H - 8}>{date(t0, lang)}</text>
      <text x={W - pad.r} y={H - 8} textAnchor="end">{date(t1, lang)}</text>
    </svg>
  );
}
