import { useState } from "react";
import { Link } from "react-router-dom";
import type { Hex } from "viem";
import { defineStrings, useLang, useStrings } from "../i18n/index.tsx";
import { common } from "../i18n/common.ts";
import { useAsync } from "../lib/hooks.ts";
import { dep, getAnchorTx, getBatches, getDemo, getDeviceKey } from "../lib/data.ts";
import { readingLogAbi } from "../abi/index.ts";
import { signNextBatch } from "../lib/anchor.ts";
import { sendAndWait } from "../lib/tx.ts";
import { errorMessage } from "../lib/errors.ts";
import { demoKey } from "../config/index.ts";
import { ago, date, num } from "../lib/format.ts";
import { DemoKeysTag, ErrorBox, Hash, Loading, Pill, Stat, TxHash } from "../components/ui.tsx";

const S = defineStrings({
  en: {
    eyebrow: "Live device",
    title: "The demo device, as it reports.",
    lead: "Batches anchored by the demo device, read from ReadingLog events and refreshed every five seconds. Each row cost one ML-DSA-44 and one ECDSA verification on chain.",
    device: "Device",
    operator: "Operator",
    keyVersion: "Key version",
    status: "Key status",
    valid: "valid",
    revoked: "revoked",
    latest: "Latest batches",
    seq: "Seq",
    passport: "Passport",
    window: "Window",
    readings: "Readings",
    gas: "Gas",
    mldsa: "ML-DSA bytes",
    anchored: "Anchored",
    none: "No batches yet.",
    signNow: "Sign and anchor a batch now",
    signNote: "Generates eight readings, signs their Merkle root in this browser with the device's demo ECDSA and ML-DSA-44 keys, and relays it.",
    signing: "Signing and sending",
    sent: "Anchored",
    noKeys: "No relayer key configured, so this page is read only.",
    photo: "Photo slot: the laptop with the ESP32-S3 board next to its battery gauge. To be supplied by the team.",
    hardware: "On real hardware, an ESP32-S3 reads the gauge and signs batches itself; see device/ in the repository. The batches below come from the demo script's device key on the local chain.",
    refresh: "refreshing every 5 s",
    total: "Batches on chain",
    last: "Last anchor",
  },
  tr: {
    eyebrow: "Canlı cihaz",
    title: "Demo cihazı, raporladığı haliyle.",
    lead: "Demo cihazının sabitlediği gruplar, ReadingLog olaylarından okunur ve beş saniyede bir yenilenir. Her satır zincirde bir ML-DSA-44 ve bir ECDSA doğrulamasına mal oldu.",
    device: "Cihaz",
    operator: "İşletmeci",
    keyVersion: "Anahtar sürümü",
    status: "Anahtar durumu",
    valid: "geçerli",
    revoked: "iptal edildi",
    latest: "Son gruplar",
    seq: "Sıra",
    passport: "Pasaport",
    window: "Zaman aralığı",
    readings: "Okuma",
    gas: "Gas",
    mldsa: "ML-DSA bayt",
    anchored: "Sabitlendi",
    none: "Henüz grup yok.",
    signNow: "Şimdi bir grup imzala ve sabitle",
    signNote: "Sekiz okuma üretir, Merkle kökünü bu tarayıcıda cihazın demo ECDSA ve ML-DSA-44 anahtarlarıyla imzalar ve iletir.",
    signing: "İmzalanıyor ve gönderiliyor",
    sent: "Sabitlendi",
    noKeys: "İletici anahtarı ayarlanmamış, bu sayfa yalnızca okunur.",
    photo: "Fotoğraf yeri: pil göstergesinin yanında ESP32-S3 kartı olan dizüstü bilgisayar. Ekip tarafından sağlanacak.",
    hardware: "Gerçek donanımda bir ESP32-S3 göstergeyi okur ve grupları kendisi imzalar; depodaki device/ klasörüne bakın. Aşağıdaki gruplar yerel zincirde demo betiğinin cihaz anahtarından gelir.",
    refresh: "5 saniyede bir yenileniyor",
    total: "Zincirdeki gruplar",
    last: "Son sabitleme",
  },
});

async function load() {
  const demo = await getDemo();
  const dev = demo?.devices.A;
  if (!dev) return null;
  const [key, batches] = await Promise.all([getDeviceKey(dev.deviceId), getBatches({ deviceId: dev.deviceId })]);
  const latest = batches.slice(-12).reverse();
  const txs = await Promise.all(latest.map((b) => getAnchorTx(b.tx)));
  return { dev, key, total: batches.length, latest: latest.map((b, i) => ({ ...b, gas: txs[i].gasUsed, mldsa: txs[i].mldsaSigBytes })) };
}

export default function Device() {
  const s = useStrings(S);
  const c = useStrings(common);
  const { lang } = useLang();
  const q = useAsync(load, [], 5000);
  const [send, setSend] = useState<{ busy?: boolean; hash?: Hex; err?: string }>({});
  const canWrite = Boolean(demoKey("relayer"));

  const anchorNow = async () => {
    if (!q.data) return;
    setSend({ busy: true });
    try {
      const b = await signNextBatch(q.data.dev.label, q.data.dev.deviceId);
      const { hash } = await sendAndWait("relayer", { address: dep().readingLog, abi: readingLogAbi, functionName: "anchor", args: b.args });
      setSend({ hash });
      q.reload();
    } catch (e) {
      setSend({ err: errorMessage(e) });
    }
  };

  return (
    <div className="stack-lg console">
      <header className="page-head">
        <span className="eyebrow"><span className="dot" />{s.eyebrow}</span>
        <h1>{s.title}</h1>
        <p className="lead">{s.lead}</p>
      </header>
      {q.loading && !q.data ? <Loading /> : q.error != null && !q.data ? <ErrorBox error={q.error} onRetry={q.reload} /> : !q.data ? (
        <div className="notice notice--warn">{c.noDeployment}</div>
      ) : (
        <>
          <div className="grid grid-2" style={{ alignItems: "start" }}>
            <section className="card stack-md">
              <dl className="kv">
                <dt>{s.device}</dt><dd><Hash value={q.data.dev.deviceId} /></dd>
                <dt>{s.operator}</dt><dd><Hash value={q.data.key.operator} /></dd>
                <dt>{s.keyVersion}</dt><dd>{q.data.key.keyVersion}</dd>
                <dt>{s.status}</dt><dd><Pill kind={q.data.key.key?.revokedAt ? "fail" : "pass"}>{q.data.key.key?.revokedAt ? s.revoked : s.valid}</Pill></dd>
              </dl>
              <div className="grid grid-2">
                <Stat label={s.total} value={num(q.data.total, lang)} sub={s.refresh} />
                <Stat label={s.last} value={q.data.latest[0] ? ago(Number(q.data.latest[0].toTs), lang) : "…"} />
              </div>
              <div className="stack-sm">
                <div className="row">
                  <button className="btn btn-candy btn-sm" onClick={anchorNow} disabled={!canWrite || send.busy}>{s.signNow}</button>
                  <DemoKeysTag />
                </div>
                <p className="small muted">{canWrite ? s.signNote : s.noKeys}</p>
                <div aria-live="polite">
                  {send.busy && <span className="row small muted"><span className="spinner" aria-hidden="true" />{s.signing}</span>}
                  {send.hash && <span className="row small"><Pill kind="pass">{s.sent}</Pill><TxHash hash={send.hash} /></span>}
                  {send.err && <div className="notice notice--error">{send.err}</div>}
                </div>
              </div>
            </section>
            <figure className="card stack-sm" style={{ margin: 0 }}>
              <div role="img" aria-label={s.photo} style={{ aspectRatio: "4/3", borderRadius: 28, background: "var(--wallpaper-soft)", boxShadow: "inset 0 0 0 1px var(--line)", display: "grid", placeItems: "center", padding: 24, textAlign: "center" }}>
                <span className="small muted">[{s.photo}]</span>
              </div>
              <figcaption className="small muted">{s.hardware}</figcaption>
            </figure>
          </div>

          <section className="stack-sm">
            <div className="row-between"><h2 style={{ fontSize: 19 }}>{s.latest}</h2><span className="small muted row"><span className="spinner" style={{ width: 10, height: 10, opacity: q.loading ? 1 : 0 }} aria-hidden="true" />{s.refresh}</span></div>
            {q.data.latest.length === 0 ? <p className="muted">{s.none}</p> : (
              <div className="table-wrap">
                <table className="table">
                  <thead><tr><th className="num">{s.seq}</th><th>{s.passport}</th><th>{s.window}</th><th className="num">{s.readings}</th><th className="num">{s.gas}</th><th className="num">{s.mldsa}</th><th>{s.keyVersion}</th><th>{c.tx}</th></tr></thead>
                  <tbody>
                    {q.data.latest.map((b) => (
                      <tr key={b.batchId}>
                        <td className="num">{String(b.seq)}</td>
                        <td><Link to={`/p/${b.passportId}`} style={{ textDecoration: "underline" }}>#{String(b.passportId)}</Link></td>
                        <td>{date(Number(b.fromTs), lang, true)} · {ago(Number(b.toTs), lang)}</td>
                        <td className="num">{b.count}</td>
                        <td className="num">{num(b.gas, lang)}</td>
                        <td className="num">{num(b.mldsa, lang)}</td>
                        <td>v{b.keyVersion}</td>
                        <td><TxHash hash={b.tx} /></td>
                      </tr>
                    ))}
                  </tbody>
                </table>
              </div>
            )}
          </section>
        </>
      )}
    </div>
  );
}
