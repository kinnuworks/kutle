import { useEffect, useMemo, useState, type ReactNode } from "react";
import { Link, useParams } from "react-router-dom";
import QRCode from "qrcode";
import type { Hex } from "viem";
import { defineStrings, useLang, useStrings, type Lang } from "../i18n/index.tsx";
import { common } from "../i18n/common.ts";
import { useAsync } from "../lib/hooks.ts";
import {
  dep, getBatches, getDemo, getDeviceKey, getHealthHistory, getLineage, getModel, getPassport, getReadingStore,
  getRecycledShares, passportRecord, type BatchEntry,
} from "../lib/data.ts";
import { publicClient } from "../lib/chain.ts";
import { readingLogAbi } from "../abi/index.ts";
import { readingLeaf, merkleProof, type Reading } from "../lib/readings.ts";
import { APP_URL } from "../config/index.ts";
import { MIN_SHARE_2031_BPS, MIN_SHARE_2036_BPS, date, grams, num, pct } from "../lib/format.ts";
import { ErrorBox, Hash, Loading, Pill, ShareBar, TxHash } from "../components/ui.tsx";
import { HealthChart } from "../components/HealthChart.tsx";
import { errorMessage } from "../lib/errors.ts";

type Audience = "public" | "legit" | "authority";
const RANK: Record<Audience, number> = { public: 0, legit: 1, authority: 2 };

const S = defineStrings({
  en: {
    eyebrow: "Battery passport",
    audience: "Who is looking",
    aud: { public: "Public", legit: "Legitimate interest", authority: "Authority" } as Record<Audience, string>,
    audNote: {
      public: "Annex XIII(1): information accessible to the public.",
      legit: "Annex XIII(2) and (4): also visible to repairers, repurposers, recyclers and others with a legitimate interest, including state of health.",
      authority: "Annex XIII(3): also visible to notified bodies, market surveillance authorities and the Commission.",
    } as Record<Audience, string>,
    hiddenFor: "visible from",
    identity: "Identity",
    operator: "Economic operator",
    category: "Battery category",
    model: "Model",
    chemistry: "Chemistry",
    manufacturer: "Manufacturer",
    manufacturedOn: "Date of manufacture",
    mass: "Mass",
    capacity: "Rated capacity",
    footprint: "Carbon footprint",
    issued: "Passport issued",
    gs1: "GS1 Digital Link identifier",
    dataHash: "Record hash (sha256 of the Battery Pass JSON)",
    gs1Hash: "Identifier hash on chain",
    device: "Fuel-gauge device",
    deviceKey: "Device key",
    keyVersion: "key version",
    revoked: "revoked",
    valid: "valid",
    composition: "Composition and recycled content",
    compLead: "Grams of each element in the battery and the share backed by spent recycled-metal notes, against the Article 8 minimums.",
    min31: "2031 minimum",
    min36: "2036 minimum",
    meets: "meets",
    misses: "misses",
    noElement: "not contained",
    locked: "Recycled content is locked for this passport.",
    health: "Health history",
    healthLead: "Each estimate cites a signed reading batch from this battery's own device and the model that produced it.",
    soh: "State of health",
    interval: "Interval",
    grade: "Grade",
    rul: "Remaining cycles",
    when: "Recorded",
    batch: "Reading batch",
    noHealth: "No health estimate recorded yet.",
    modelErr: "Model held-out error",
    lineage: "Lineage",
    lineageLead: "Article 77(6): a repurposed battery gets a new passport linked to the one before it.",
    current: "this passport",
    statusTitle: "Status",
    recycler: "Closed at recycler batch",
    qr: "Scan to open",
    qrNote: "A GS1 Digital Link path (01 = GTIN, 21 = serial) resolved by this app.",
    verifyReading: "Verify a reading",
    vrLead: "Pick a batch and one of its readings. The page hashes the reading, builds its Merkle path, and asks ReadingLog.verifyReading on chain.",
    pickBatch: "Batch",
    pickReading: "Reading",
    tamper: "Change one field before checking (cycle count + 1)",
    check: "Check on chain",
    leaf: "Leaf",
    path: "Merkle path",
    root: "Signed root",
    result: "ReadingLog.verifyReading returned",
    noReadings: "The reading records for this batch are not published with this app (the gateway that produced them keeps them).",
    noBatches: "No reading batches anchored for this passport.",
    verifyAll: "Run every check",
    notFound: "No passport with this id on this chain.",
    fields: { ts: "time", cyc: "cycles", fcc: "full charge", v: "pack voltage", t: "temperature", soc: "charge" },
  },
  tr: {
    eyebrow: "Batarya pasaportu",
    audience: "Kim bakıyor",
    aud: { public: "Herkes", legit: "Meşru menfaat", authority: "Yetkili makam" } as Record<Audience, string>,
    audNote: {
      public: "Ek XIII(1): kamuya açık bilgiler.",
      legit: "Ek XIII(2) ve (4): onarımcılar, yeniden amaçlayanlar, geri dönüşümcüler ve meşru menfaati olan diğer kişilere de açık, sağlık durumu dahil.",
      authority: "Ek XIII(3): onaylanmış kuruluşlara, piyasa gözetim makamlarına ve Komisyona da açık.",
    } as Record<Audience, string>,
    hiddenFor: "şu düzeyden itibaren görünür:",
    identity: "Kimlik",
    operator: "Ekonomik işletmeci",
    category: "Batarya kategorisi",
    model: "Model",
    chemistry: "Kimya",
    manufacturer: "Üretici",
    manufacturedOn: "Üretim tarihi",
    mass: "Kütle",
    capacity: "Anma kapasitesi",
    footprint: "Karbon ayak izi",
    issued: "Pasaport veriliş tarihi",
    gs1: "GS1 Digital Link tanımlayıcısı",
    dataHash: "Kayıt özeti (Battery Pass JSON'un sha256 değeri)",
    gs1Hash: "Zincirdeki tanımlayıcı özeti",
    device: "Yakıt göstergesi cihazı",
    deviceKey: "Cihaz anahtarı",
    keyVersion: "anahtar sürümü",
    revoked: "iptal edildi",
    valid: "geçerli",
    composition: "Bileşim ve geri dönüştürülmüş içerik",
    compLead: "Bataryadaki her elementin gramı ve harcanmış geri dönüştürülmüş metal notlarıyla desteklenen pay, 8. Madde asgari oranlarına göre.",
    min31: "2031 asgari oranı",
    min36: "2036 asgari oranı",
    meets: "karşılıyor",
    misses: "karşılamıyor",
    noElement: "içermiyor",
    locked: "Bu pasaportun geri dönüştürülmüş içeriği kilitli.",
    health: "Sağlık geçmişi",
    healthLead: "Her tahmin, bu bataryanın kendi cihazından gelen imzalı bir okuma grubuna ve onu üreten modele dayanır.",
    soh: "Sağlık durumu",
    interval: "Aralık",
    grade: "Derece",
    rul: "Kalan döngü",
    when: "Kayıt",
    batch: "Okuma grubu",
    noHealth: "Henüz sağlık tahmini kaydedilmedi.",
    modelErr: "Modelin ayrılmış veri hatası",
    lineage: "Soy bağı",
    lineageLead: "77(6). Madde: yeniden amaçlanan bataryaya öncekine bağlı yeni bir pasaport verilir.",
    current: "bu pasaport",
    statusTitle: "Durum",
    recycler: "Kapatıldığı geri dönüşüm partisi",
    qr: "Açmak için tarayın",
    qrNote: "Bu uygulamanın çözdüğü bir GS1 Digital Link yolu (01 = GTIN, 21 = seri numarası).",
    verifyReading: "Bir okumayı doğrula",
    vrLead: "Bir grup ve onun okumalarından birini seçin. Sayfa okumayı özetler, Merkle yolunu kurar ve zincirde ReadingLog.verifyReading çağırır.",
    pickBatch: "Grup",
    pickReading: "Okuma",
    tamper: "Kontrolden önce bir alanı değiştir (döngü sayısı + 1)",
    check: "Zincirde kontrol et",
    leaf: "Yaprak",
    path: "Merkle yolu",
    root: "İmzalı kök",
    result: "ReadingLog.verifyReading sonucu",
    noReadings: "Bu grubun okuma kayıtları bu uygulamayla yayımlanmıyor (onları üreten ağ geçidi saklar).",
    noBatches: "Bu pasaport için sabitlenmiş okuma grubu yok.",
    verifyAll: "Tüm kontrolleri çalıştır",
    notFound: "Bu zincirde bu numarayla bir pasaport yok.",
    fields: { ts: "zaman", cyc: "döngü", fcc: "tam şarj", v: "paket gerilimi", t: "sıcaklık", soc: "şarj" },
  },
});

async function load(id: bigint) {
  const [pv, demo] = await Promise.all([getPassport(id), getDemo()]);
  if (pv.passport.status === 0) return { missing: true as const };
  const [history, lineage, shares, batches, deviceKey] = await Promise.all([
    getHealthHistory(id), getLineage(id), getRecycledShares(id), getBatches({ passportId: id }), getDeviceKey(pv.passport.deviceId),
  ]);
  const model = pv.health.at ? await getModel(pv.health.modelId) : undefined;
  return { missing: false as const, ...pv, demo, record: passportRecord(demo, Number(id)), history, lineage, shares, batches, deviceKey, model };
}

/** "https://id.kutle.example/01/<gtin>/21/<serial>" -> app resolver URL with the same path. */
export function resolverUrl(gs1: string | undefined, id: bigint): string {
  const m = gs1?.match(/\/01\/(\d{8,14})\/21\/([^/?#]+)/);
  const base = APP_URL.replace(/#.*$/, "");
  return m ? `${base}#/01/${m[1]}/21/${m[2]}` : `${base}#/p/${id}`;
}

export default function Passport() {
  const { id: idParam } = useParams();
  const s = useStrings(S);
  const c = useStrings(common);
  const { lang } = useLang();
  const id = BigInt(idParam && /^\d+$/.test(idParam) ? idParam : "0");
  const q = useAsync(() => load(id), [String(id)]);
  const [aud, setAud] = useState<Audience>("public");
  const [qr, setQr] = useState<string>();

  const d = q.data && !q.data.missing ? q.data : undefined;
  const qrUrl = d ? resolverUrl(d.record?.gs1 as string | undefined, id) : "";
  useEffect(() => {
    if (!qrUrl) return;
    QRCode.toDataURL(qrUrl, { margin: 0, width: 300, errorCorrectionLevel: "M" }).then(setQr, () => setQr(undefined));
  }, [qrUrl]);

  if (q.loading && !q.data) return <Loading />;
  if (q.error != null) return <ErrorBox error={q.error} onRetry={q.reload} />;
  if (!d) return <div className="notice notice--warn">{s.notFound}</div>;

  const p = d.passport;
  const r = d.record ?? {};
  const F = ({ label, min, children }: { label: string; min: Audience; children: ReactNode }) => (
    <>
      <dt>{label}</dt>
      <dd>{RANK[aud] >= RANK[min] ? children : <span className="hidden-field">{s.hiddenFor} {s.aud[min]}</span>}</dd>
    </>
  );

  return (
    <div className="stack-lg console">
      <header className="row-between" style={{ alignItems: "flex-start" }}>
        <div className="page-head" style={{ marginBottom: 0 }}>
          <span className="eyebrow">{s.eyebrow}</span>
          <h1>{c.passport} #{String(id)}</h1>
          <div className="row" style={{ marginTop: 12 }}>
            <Pill kind={p.status === 1 ? "pass" : p.status === 4 ? "fail" : "ink"}>{c.status[p.status]}</Pill>
            <Pill>{c.category[p.category] ?? p.category}</Pill>
            {typeof r.model === "string" && <Pill>{r.model}</Pill>}
            <Link className="btn btn-sm btn-outline" to={`/verify/${id}`}>{s.verifyAll}</Link>
          </div>
        </div>
        <figure style={{ margin: 0, textAlign: "center" }}>
          {qr ? <img className="qr" src={qr} alt={`${s.qr}: ${qrUrl}`} /> : <div className="qr" />}
          <figcaption className="small muted" style={{ maxWidth: 190, marginTop: 6 }}>{s.qrNote}</figcaption>
        </figure>
      </header>

      <section className="card stack-sm" aria-label={s.audience}>
        <div className="row-between">
          <strong>{s.audience}</strong>
          <div className="segmented" role="tablist" aria-label={s.audience}>
            {(["public", "legit", "authority"] as Audience[]).map((a) => (
              <button key={a} role="tab" aria-selected={aud === a} onClick={() => setAud(a)}>{s.aud[a]}</button>
            ))}
          </div>
        </div>
        <p className="small muted">{s.audNote[aud]}</p>
      </section>

      <div className="grid grid-2" style={{ alignItems: "start" }}>
        <section className="card">
          <h2>{s.identity}</h2>
          <dl className="kv" style={{ marginTop: 10 }}>
            <F label={s.operator} min="public"><Hash value={p.operator} /></F>
            <F label={s.manufacturer} min="public">{String(r.manufacturer ?? "")}</F>
            <F label={s.category} min="public">{c.category[p.category]}</F>
            <F label={s.model} min="public">{String(r.model ?? "")}</F>
            <F label={s.chemistry} min="public">{String(r.chemistry ?? "")}</F>
            <F label={s.manufacturedOn} min="public">{String(r.manufacturedOn ?? "")}</F>
            <F label={s.mass} min="public">{num(p.massGrams / 1000, lang, 1)} kg</F>
            <F label={s.capacity} min="public">{num(p.capacityWh / 1000, lang, 1)} kWh</F>
            <F label={s.footprint} min="public">{r.carbonFootprint_kgCO2e_per_kWh ? `${r.carbonFootprint_kgCO2e_per_kWh} kg CO2e/kWh` : ""}</F>
            <F label={s.issued} min="public">{date(Number(p.issuedAt), lang)}</F>
            <F label={s.gs1} min="public"><span className="mono small break">{String(r.gs1 ?? "")}</span></F>
            <F label={s.device} min="legit"><Hash value={p.deviceId} /></F>
            <F label={s.deviceKey} min="authority">
              {d.deviceKey.key && (
                <span className="stack-sm" style={{ display: "block" }}>
                  <Hash value={d.deviceKey.key.ecdsaSigner} />{" "}
                  <span className="small muted">{s.keyVersion} {d.deviceKey.keyVersion} · </span>
                  <Pill kind={d.deviceKey.key.revokedAt ? "fail" : "pass"}>{d.deviceKey.key.revokedAt ? s.revoked : s.valid}</Pill>
                </span>
              )}
            </F>
            <F label={s.dataHash} min="authority"><Hash value={p.dataHash} /></F>
            <F label={s.gs1Hash} min="authority"><Hash value={p.gs1Hash} /></F>
          </dl>
        </section>

        <div className="stack-md">
          <section className="card stack-sm">
            <h2>{s.composition}</h2>
            <p className="small muted">{s.compLead}</p>
            {d.shares.map((x) => {
              const comp = p.composition[x.element];
              return (
                <div key={x.element} className="stack-sm" style={{ paddingTop: 8 }}>
                  <div className="row-between small">
                    <strong>{c.elements[x.element]}</strong>
                    {comp === 0n ? (
                      <span className="muted">{s.noElement}</span>
                    ) : (
                      <span className="row">
                        <span>{RANK[aud] >= 1 ? `${grams(p.recycled[x.element], lang)} / ${grams(comp, lang)} · ` : ""}<strong>{pct(x.shareBps, lang)}</strong></span>
                        <Pill kind={x.meets2031 ? "pass" : "fail"}>2031 {x.meets2031 ? s.meets : s.misses}</Pill>
                        <Pill kind={x.meets2036 ? "pass" : "warn"}>2036 {x.meets2036 ? s.meets : s.misses}</Pill>
                      </span>
                    )}
                  </div>
                  {comp > 0n && (
                    <ShareBar element={x.element} shareBps={x.shareBps} min31={MIN_SHARE_2031_BPS[x.element]} min36={MIN_SHARE_2036_BPS[x.element]}
                      label={`${c.elements[x.element]}: ${pct(x.shareBps, lang)}; ${s.min31} ${pct(MIN_SHARE_2031_BPS[x.element], lang, 0)}, ${s.min36} ${pct(MIN_SHARE_2036_BPS[x.element], lang, 0)}`} />
                  )}
                </div>
              );
            })}
            <p className="small muted">| {s.min31} · <span style={{ color: "var(--warn)" }}>|</span> {s.min36}{p.recycledLocked ? ` · ${s.locked}` : ""}</p>
          </section>

          <section className="card stack-sm">
            <h2>{s.lineage}</h2>
            <p className="small muted">{s.lineageLead}</p>
            <ol className="row" style={{ listStyle: "none", padding: 0, margin: 0 }}>
              {d.lineage.map((l, i) => (
                <li key={String(l.id)} className="row">
                  {i > 0 && <span aria-hidden="true" className="muted">→</span>}
                  {l.id === id ? (
                    <span className="pill pill--ink" aria-current="true">#{String(l.id)} · {c.status[l.status]}</span>
                  ) : (
                    <Link className="pill" to={`/p/${l.id}`}>#{String(l.id)} · {c.status[l.status]}</Link>
                  )}
                </li>
              ))}
            </ol>
            {p.status === 3 && <p className="small">{s.recycler} #{String(p.recyclerBatch)}</p>}
          </section>
        </div>
      </div>

      <section className="card stack-md">
        <div>
          <h2>{s.health}</h2>
          <p className="small muted">{s.healthLead}</p>
        </div>
        {RANK[aud] < 1 ? (
          <p className="hidden-field muted">{s.hiddenFor} {s.aud.legit}</p>
        ) : d.history.length === 0 ? (
          <p className="muted">{s.noHealth}</p>
        ) : (
          <>
            <HealthChart lang={lang} label={s.health} points={d.history.map((h) => ({ at: h.at, soh: h.sohBps!, low: h.lowBps!, high: h.highBps! }))} />
            <div className="table-wrap">
              <table className="table">
                <thead>
                  <tr><th>{s.when}</th><th className="num">{s.soh}</th><th>{s.interval}</th><th>{s.grade}</th><th className="num">{s.rul}</th><th>{s.batch}</th><th>{c.tx}</th></tr>
                </thead>
                <tbody>
                  {[...d.history].reverse().map((h) => (
                    <tr key={h.tx}>
                      <td>{date(h.at, lang)}</td>
                      <td className="num">{pct(h.sohBps!, lang)}</td>
                      <td>{pct(h.lowBps!, lang)} {c.to} {pct(h.highBps!, lang)}</td>
                      <td><Pill kind={h.grade === 4 ? "fail" : h.grade === 3 ? "warn" : "pass"}>{c.grade[h.grade!]}</Pill></td>
                      <td className="num">{num(h.rulCycles!, lang)}</td>
                      <td><Hash value={h.readingBatch!} head={6} tail={4} /></td>
                      <td><TxHash hash={h.tx} /></td>
                    </tr>
                  ))}
                </tbody>
              </table>
            </div>
            {d.model && <p className="small muted">{s.model}: <span className="mono">{d.model.uri}</span> · {s.modelErr} {pct(d.model.maeBps, lang, 2)} vs {pct(d.model.baselineMaeBps, lang, 2)}</p>}
          </>
        )}
      </section>

      {RANK[aud] >= 1 && <VerifyReading batches={d.batches} lang={lang} />}
    </div>
  );
}

function VerifyReading({ batches, lang }: { batches: BatchEntry[]; lang: Lang }) {
  const s = useStrings(S);
  const c = useStrings(common);
  const store = useAsync(getReadingStore, []);
  const [bi, setBi] = useState(batches.length - 1);
  const [ri, setRi] = useState(0);
  const [tamper, setTamper] = useState(false);
  const [res, setRes] = useState<{ ok?: boolean; err?: string; running?: boolean }>({});
  const b = batches[bi];
  const readings: Reading[] | undefined = b ? store.data?.[b.batchId!] : undefined;
  const reading = readings?.[Math.min(ri, (readings?.length ?? 1) - 1)];
  const proof = useMemo(() => {
    if (!readings || !reading) return undefined;
    const leaves = readings.map(readingLeaf);
    const idx = readings.indexOf(reading);
    const used = tamper ? { ...reading, cycleCount: reading.cycleCount + 1 } : reading;
    return { leaf: readingLeaf(used), path: merkleProof(leaves, idx) };
  }, [readings, reading, tamper]);
  useEffect(() => setRes({}), [bi, ri, tamper]);

  if (!batches.length) return <section className="card"><h2>{s.verifyReading}</h2><p className="muted">{s.noBatches}</p></section>;

  const run = async () => {
    if (!proof || !b) return;
    setRes({ running: true });
    try {
      const ok = await publicClient.readContract({ address: dep().readingLog, abi: readingLogAbi, functionName: "verifyReading", args: [b.batchId as Hex, proof.leaf, proof.path] });
      setRes({ ok });
    } catch (e) {
      setRes({ err: errorMessage(e) });
    }
  };

  return (
    <section className="card stack-md" aria-labelledby="vr">
      <div>
        <h2 id="vr">{s.verifyReading}</h2>
        <p className="small muted">{s.vrLead}</p>
      </div>
      <div className="grid grid-2">
        <div className="field">
          <label htmlFor="vr-batch">{s.pickBatch}</label>
          <select id="vr-batch" className="input" value={bi} onChange={(e) => { setBi(Number(e.target.value)); setRi(0); }}>
            {batches.map((x, i) => (
              <option key={x.batchId} value={i}>#{String(x.seq)} · {date(Number(x.toTs), lang, true)} · {x.count} {s.pickReading.toLowerCase()}</option>
            ))}
          </select>
        </div>
        <div className="field">
          <label htmlFor="vr-reading">{s.pickReading}</label>
          <select id="vr-reading" className="input" value={ri} onChange={(e) => setRi(Number(e.target.value))} disabled={!readings}>
            {(readings ?? []).map((x, i) => (
              <option key={i} value={i}>{i + 1}. {date(x.timestamp, lang, true)} · {x.cycleCount} {s.fields.cyc}</option>
            ))}
          </select>
        </div>
      </div>
      {store.loading && !store.data ? <Loading /> : !readings ? (
        <p className="notice">{s.noReadings}</p>
      ) : reading && proof && b ? (
        <>
          <div className="small muted">
            {s.fields.cyc} {reading.cycleCount} · {s.fields.fcc} {num(reading.fullChargeCapacity_mAh, lang)} mAh · {s.fields.v} {num(reading.packVoltage_mV / 1000, lang, 2)} V · {s.fields.t} {num(reading.temperature_centiC / 100, lang, 1)} °C · {s.fields.soc} {reading.stateOfCharge_pct}% <span className="tag-demo">{c.simulated}</span>
          </div>
          <label className="row small" style={{ cursor: "pointer" }}>
            <input type="checkbox" className="switch" checked={tamper} onChange={(e) => setTamper(e.target.checked)} />
            {s.tamper}
          </label>
          <dl className="kv">
            <dt>{s.leaf}</dt><dd><Hash value={proof.leaf} /></dd>
            <dt>{s.path}</dt><dd className="stack-sm">{proof.path.map((h, i) => <div key={i}><Hash value={h} /></div>)}</dd>
            <dt>{s.root}</dt><dd><Hash value={b.root!} /></dd>
          </dl>
          <div className="row">
            <button className="btn btn-ink btn-sm" onClick={run} disabled={res.running}>{s.check}</button>
            {res.running && <span className="spinner" aria-hidden="true" />}
            <span aria-live="polite">
              {res.ok !== undefined && (
                <span className="row small">{s.result} <Pill kind={res.ok ? "pass" : "fail"}>{String(res.ok)}</Pill></span>
              )}
              {res.err && <span className="notice notice--error">{res.err}</span>}
            </span>
          </div>
          <p className="small muted mono">ReadingLog.verifyReading({b.batchId?.slice(0, 10)}…, {proof.leaf.slice(0, 10)}…, [{proof.path.length}])</p>
        </>
      ) : null}
    </section>
  );
}
