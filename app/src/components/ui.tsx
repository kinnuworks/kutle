import { useState, type ReactNode } from "react";
import { useStrings } from "../i18n/index.tsx";
import { common } from "../i18n/common.ts";
import { explorerTx } from "../lib/chain.ts";
import { errorMessage, revertDataFrom, decodeRevertData, type DecodedError } from "../lib/errors.ts";
import { shortHex } from "../lib/format.ts";

export const Icon = {
  check: (
    <svg viewBox="0 0 24 24" fill="none" stroke="currentColor" strokeWidth="2.4" strokeLinecap="round" strokeLinejoin="round" aria-hidden="true"><path d="M5 12.5l4.5 4.5L19 7.5" /></svg>
  ),
  x: (
    <svg viewBox="0 0 24 24" fill="none" stroke="currentColor" strokeWidth="2.4" strokeLinecap="round" aria-hidden="true"><path d="M6 6l12 12M18 6L6 18" /></svg>
  ),
  dash: (
    <svg viewBox="0 0 24 24" fill="none" stroke="currentColor" strokeWidth="2.4" strokeLinecap="round" aria-hidden="true"><path d="M7 12h10" /></svg>
  ),
  menu: (
    <svg viewBox="0 0 24 24" fill="none" stroke="currentColor" strokeWidth="2" strokeLinecap="round" aria-hidden="true"><path d="M4 7h16M4 12h16M4 17h16" /></svg>
  ),
  shield: (
    <svg viewBox="0 0 24 24" fill="none" stroke="currentColor" strokeWidth="1.75" strokeLinecap="round" strokeLinejoin="round" aria-hidden="true"><path d="M12 3l7 3v6c0 4.5-3 7.5-7 9-4-1.5-7-4.5-7-9V6z" /></svg>
  ),
};

export function Spinner({ label }: { label?: string }) {
  return (
    <span role="status" className="row muted small">
      <span className="spinner" aria-hidden="true" />
      {label}
    </span>
  );
}

export function Loading() {
  const s = useStrings(common);
  return (
    <div className="stack-sm" aria-busy="true">
      <Spinner label={s.loading} />
      <div className="skeleton" style={{ width: "70%" }} />
      <div className="skeleton" style={{ width: "50%" }} />
    </div>
  );
}

export function ErrorBox({ error, onRetry }: { error: unknown; onRetry?: () => void }) {
  const s = useStrings(common);
  return (
    <div className="notice notice--error" role="alert">
      <strong>{s.error}</strong>
      <pre>{errorMessage(error)}</pre>
      {onRetry && (
        <button className="btn btn-sm btn-outline" style={{ marginTop: 10 }} onClick={onRetry}>
          {s.retry}
        </button>
      )}
    </div>
  );
}

export function Hash({ value, href, head = 8, tail = 6 }: { value: string; href?: string; head?: number; tail?: number }) {
  const s = useStrings(common);
  const [copied, setCopied] = useState(false);
  const copy = async () => {
    try {
      await navigator.clipboard.writeText(value);
      setCopied(true);
      setTimeout(() => setCopied(false), 1200);
    } catch {
      /* clipboard blocked */
    }
  };
  const text = shortHex(value, head, tail);
  return (
    <span className="hash" title={value}>
      {href ? (
        <a href={href} target="_blank" rel="noreferrer">
          <code>{text}</code>
        </a>
      ) : (
        <code>{text}</code>
      )}
      <button type="button" onClick={copy} aria-label={`${s.copy} ${value}`}>
        {copied ? s.copied : s.copy}
      </button>
    </span>
  );
}

export const TxHash = ({ hash }: { hash: string }) => <Hash value={hash} href={explorerTx(hash)} />;

export function Stat({ label, value, sub }: { label: ReactNode; value: ReactNode; sub?: ReactNode }) {
  return (
    <div className="stat">
      <div className="stat__label">{label}</div>
      <div className="stat__value">{value}</div>
      {sub && <div className="stat__sub">{sub}</div>}
    </div>
  );
}

export function Pill({ kind, children }: { kind?: "pass" | "fail" | "warn" | "ink"; children: ReactNode }) {
  return <span className={`pill${kind ? ` pill--${kind}` : ""}`}>{children}</span>;
}

export function DemoKeysTag() {
  const s = useStrings(common);
  return (
    <span className="tag-demo" title={s.demoKeysNote}>
      {Icon.shield && <span style={{ width: 12, height: 12, display: "inline-block" }}>{Icon.shield}</span>}
      {s.demoKeys}
    </span>
  );
}

export function DecodedErrorView({ e }: { e: DecodedError }) {
  return (
    <div className="stack-sm">
      <div className="row">
        <code className="mono break" style={{ fontWeight: 600 }}>
          {e.name}({e.args.filter((a) => !(a.type === "bytes" && e.inner)).map((a) => a.value).join(", ")})
        </code>
        {e.sources.length > 0 && <span className="small muted">{e.sources.join(", ")}</span>}
        {e.selector && <span className="small muted mono">{e.selector}</span>}
      </div>
      {e.inner && (
        <div style={{ paddingLeft: 14, borderLeft: "2px solid var(--line-2)" }}>
          <DecodedErrorView e={e.inner} />
        </div>
      )}
    </div>
  );
}

export function decodeThrown(err: unknown): DecodedError | null {
  const d = revertDataFrom(err);
  return d ? decodeRevertData(d) : null;
}

/** Horizontal share bar with 2031 and 2036 markers. */
const EL_VARS = ["--el-co", "--el-li", "--el-ni", "--el-pb"];
export function ShareBar({ shareBps, min31, min36, label, element }: { shareBps: number; min31: number; min36: number; label: string; element?: number }) {
  const w = Math.min(100, shareBps / 100);
  return (
    <div className="bar-track" role="img" aria-label={label}>
      <div className="bar-fill" style={{ width: `${w}%`, background: element !== undefined ? `var(${EL_VARS[element]})` : undefined }} />
      <span className="bar-mark" data-y="2031" style={{ left: `${min31 / 100}%` }} />
      <span className="bar-mark" data-y="2036" style={{ left: `${min36 / 100}%` }} />
    </div>
  );
}
