import { useEffect, useRef, useState, type FormEvent } from "react";
import { Link, useNavigate, useParams } from "react-router-dom";
import { defineStrings, useLang, useStrings, type Lang } from "../i18n/index.tsx";
import { common } from "../i18n/common.ts";
import { resolvePassportRef, runChecks, type CheckResult } from "../lib/verify.ts";
import { errorMessage } from "../lib/errors.ts";
import { pct, shortHex } from "../lib/format.ts";
import { Icon } from "../components/ui.tsx";

const S = defineStrings({
  en: {
    eyebrow: "Independent verification",
    title: "Check a passport yourself.",
    lead: "Paste a passport number, a passport link or a GS1 Digital Link, or scan its QR code. Every check runs in this browser against the chain; nothing goes through a server of ours.",
    input: "Passport number, link or GS1 Digital Link",
    run: "Run checks",
    scan: "Scan QR",
    stopScan: "Stop camera",
    scanUnsupported: "This browser cannot read QR codes from the camera. Paste the link instead.",
    notFound: "Could not resolve that to a passport on this chain.",
    running: "Running checks",
    done: "checks passed",
    na: "not applicable",
    open: "Open passport",
    calls: "Calls made",
    titles: {
      exists: "Passport exists on chain",
      suite: "Device key suite and pinned verifier",
      signatures: "Reading batches carry both signatures",
      model: "Model is registered and beats its baseline",
      grade: "Grade recomputed with gradeFor",
      conservation: "Conservation in the recycler batch",
      nullifiers: "Recycled content backed by spent nullifiers",
      pool: "Every note is backed by assayed metal",
    } as Record<string, string>,
  },
  tr: {
    eyebrow: "Bağımsız doğrulama",
    title: "Bir pasaportu kendiniz kontrol edin.",
    lead: "Bir pasaport numarası, pasaport bağlantısı ya da GS1 Digital Link yapıştırın veya QR kodunu tarayın. Her kontrol bu tarayıcıda zincire karşı çalışır; hiçbir şey bizim bir sunucumuzdan geçmez.",
    input: "Pasaport numarası, bağlantı ya da GS1 Digital Link",
    run: "Kontrolleri çalıştır",
    scan: "QR tara",
    stopScan: "Kamerayı kapat",
    scanUnsupported: "Bu tarayıcı kameradan QR kodu okuyamıyor. Bunun yerine bağlantıyı yapıştırın.",
    notFound: "Bu girdi bu zincirde bir pasaporta çözümlenemedi.",
    running: "Kontroller çalışıyor",
    done: "kontrol geçti",
    na: "uygulanamaz",
    open: "Pasaportu aç",
    calls: "Yapılan çağrılar",
    titles: {
      exists: "Pasaport zincirde var",
      suite: "Cihaz anahtar paketi ve sabitlenmiş doğrulayıcı",
      signatures: "Okuma grupları iki imzayı da taşıyor",
      model: "Model kayıtlı ve temel modeli geçiyor",
      grade: "Derece gradeFor ile yeniden hesaplandı",
      conservation: "Geri dönüşüm partisinde korunum",
      nullifiers: "Geri dönüştürülmüş içerik harcanmış nullifier'larla destekleniyor",
      pool: "Her not analiz edilmiş metalle destekleniyor",
    } as Record<string, string>,
  },
});

function detail(r: CheckResult, lang: Lang, grade: Record<number, string>, status: Record<number, string>): string {
  const f = r.facts;
  const en = lang === "en";
  switch (r.id) {
    case "exists":
      return r.state === "pass"
        ? en ? `Status ${status[Number(f.status)]}, parent #${f.parent}, child #${f.child}.` : `Durum ${status[Number(f.status)]}, üst #${f.parent}, alt #${f.child}.`
        : en ? `No passport #${f.id}.` : `#${f.id} numaralı pasaport yok.`;
    case "suite":
      return en
        ? `Suite ${f.suite} (ECDSA + ML-DSA-44), ${f.enabled ? "enabled" : "disabled"}. Verifier code hash ${shortHex(String(f.verifierHash))} ${f.verifierHash === f.pinnedCodehash ? "matches" : "does not match"} the pinned hash. Key blob ${f.blobSize} bytes, ${f.blobPinned ? "pinned" : "changed"}. Key version ${f.keyVersion}${f.revoked ? ", revoked" : ""}.`
        : `Paket ${f.suite} (ECDSA + ML-DSA-44), ${f.enabled ? "etkin" : "devre dışı"}. Doğrulayıcı kod özeti ${shortHex(String(f.verifierHash))} sabitlenmiş özetle ${f.verifierHash === f.pinnedCodehash ? "eşleşiyor" : "eşleşmiyor"}. Anahtar verisi ${f.blobSize} bayt, ${f.blobPinned ? "sabit" : "değişmiş"}. Anahtar sürümü ${f.keyVersion}${f.revoked ? ", iptal edilmiş" : ""}.`;
    case "signatures":
      if (r.state === "na") return en ? "No reading batches for this passport." : "Bu pasaport için okuma grubu yok.";
      return en
        ? `${f.ok} of ${f.count} batches verified in this browser: ECDSA signer recovered and ML-DSA-44 signature (${f.mldsaBytes} bytes) checked against the registered key. Last anchor used ${f.gas} gas.`
        : `${f.count} gruptan ${f.ok} tanesi bu tarayıcıda doğrulandı: ECDSA imzalayıcısı geri elde edildi ve ML-DSA-44 imzası (${f.mldsaBytes} bayt) kayıtlı anahtara karşı kontrol edildi. Son sabitleme ${f.gas} gas kullandı.`;
    case "model":
      if (r.state === "na") return en ? "No health estimate yet." : "Henüz sağlık tahmini yok.";
      return en
        ? `Held-out error ${pct(Number(f.mae), lang, 2)} against a baseline of ${pct(Number(f.baseline), lang, 2)}, interval coverage ${pct(Number(f.coverage), lang)}, ${f.active ? "active" : "retired"}.`
        : `Ayrılmış veri hatası ${pct(Number(f.mae), lang, 2)}, temel model ${pct(Number(f.baseline), lang, 2)}, aralık kapsaması ${pct(Number(f.coverage), lang)}, ${f.active ? "aktif" : "emekli"}.`;
    case "grade":
      if (r.state === "na") return en ? "No grade recorded." : "Kayıtlı derece yok.";
      return en
        ? `Interval ${pct(Number(f.low), lang)} to ${pct(Number(f.high), lang)} gives "${grade[Number(f.onchain)]}" on chain and "${grade[Number(f.local)]}" in this browser; stored grade "${grade[Number(f.stored)]}". Cited batch ${f.citedOk ? "belongs to this passport" : "is not this passport's"}.`
        : `${pct(Number(f.low), lang)} ile ${pct(Number(f.high), lang)} aralığı zincirde "${grade[Number(f.onchain)]}", bu tarayıcıda "${grade[Number(f.local)]}" veriyor; kayıtlı derece "${grade[Number(f.stored)]}". Atıf yapılan grup ${f.citedOk ? "bu pasaporta ait" : "bu pasaporta ait değil"}.`;
    case "conservation": {
      if (r.state === "na") return en ? "This passport was not recycled." : "Bu pasaport geri dönüştürülmedi.";
      const rows = JSON.parse(String(f.rows)) as [string, string, string, string, boolean][];
      const els = ["Co", "Li", "Ni", "Pb"];
      const eq = rows.map((x, i) => (x[0] === "0" ? null : `${els[i]}: ${x[0]} = ${x[1]} + ${x[2]} + ${x[3]}`)).filter(Boolean).join("; ");
      return en
        ? `Batch #${f.batch} with ${f.passports} passports. input = recovered + loss + unprocessed, in grams: ${eq}. Input ${f.inputMatches ? "equals" : "differs from"} the sum of intake events.`
        : `#${f.batch} numaralı parti, ${f.passports} pasaport. girdi = geri kazanılan + kayıp + işlenmemiş, gram: ${eq}. Girdi, alım olaylarının toplamına ${f.inputMatches ? "eşit" : "eşit değil"}.`;
    }
    case "nullifiers":
      if (r.state === "na") return en ? "No recycled content declared." : "Beyan edilmiş geri dönüştürülmüş içerik yok.";
      if (f.inherited) return en ? `Inherited unchanged from parent #${f.inherited}.` : `Üst pasaport #${f.inherited} üzerinden değişmeden devralındı.`;
      return en
        ? `${f.spends} spends, ${f.nullifiers} nullifiers, ${f.allSpent ? "all marked spent" : "some not spent"}. Event totals ${f.matches ? "equal" : "differ from"} the passport's recycled grams.`
        : `${f.spends} harcama, ${f.nullifiers} nullifier, ${f.allSpent ? "hepsi harcanmış" : "bazıları harcanmamış"}. Olay toplamları pasaportun geri dönüştürülmüş gramlarına ${f.matches ? "eşit" : "eşit değil"}.`;
    case "pool": {
      const els = ["Co", "Li", "Ni", "Pb"];
      const m = String(f.minted).split(","), is = String(f.issued).split(","), rc = String(f.recovered).split(",");
      const parts = els.map((e, i) => (rc[i] === "0" ? null : `${e} ${m[i]} = ${is[i]} ≤ ${rc[i]}`)).filter(Boolean).join("; ");
      return en
        ? `Grams minted as notes equal grams issued by the ledger, which never exceed recovered metal, across ${f.batches} batches: ${parts}.`
        : `${f.batches} parti boyunca not olarak basılan gramlar defterin verdiği gramlara eşit ve geri kazanılan metali hiç aşmıyor: ${parts}.`;
    }
  }
  return "";
}

type BarcodeDetectorCtor = new (o: { formats: string[] }) => { detect(src: CanvasImageSource): Promise<{ rawValue: string }[]> };

export default function Verify() {
  const s = useStrings(S);
  const c = useStrings(common);
  const { lang } = useLang();
  const { id } = useParams();
  const nav = useNavigate();
  const [input, setInput] = useState(id ?? "");
  const [results, setResults] = useState<CheckResult[]>([]);
  const [state, setState] = useState<"idle" | "running" | "done">("idle");
  const [err, setErr] = useState<string>();
  const [pid, setPid] = useState<bigint>();
  const [scanning, setScanning] = useState(false);
  const videoRef = useRef<HTMLVideoElement>(null);
  const runId = useRef(0);

  const run = async (ref: string) => {
    const my = ++runId.current;
    setErr(undefined);
    setResults([]);
    setState("running");
    try {
      const resolved = await resolvePassportRef(ref);
      if (resolved === null) {
        setErr(s.notFound);
        setState("idle");
        return;
      }
      setPid(resolved);
      for await (const r of runChecks(resolved)) {
        if (my !== runId.current) return;
        setResults((xs) => [...xs, r]);
      }
      setState("done");
    } catch (e) {
      if (my === runId.current) {
        setErr(errorMessage(e));
        setState("done");
      }
    }
  };

  useEffect(() => {
    if (id) {
      setInput(id);
      run(id);
    }
    // eslint-disable-next-line react-hooks/exhaustive-deps
  }, [id]);

  const submit = (e: FormEvent) => {
    e.preventDefault();
    const ref = input.trim();
    if (/^#?\d+$/.test(ref)) nav(`/verify/${ref.replace("#", "")}`);
    else run(ref);
  };

  const scan = async () => {
    const BD = (window as unknown as { BarcodeDetector?: BarcodeDetectorCtor }).BarcodeDetector;
    if (!BD || !navigator.mediaDevices?.getUserMedia) {
      setErr(s.scanUnsupported);
      return;
    }
    setScanning(true);
    const stream = await navigator.mediaDevices.getUserMedia({ video: { facingMode: "environment" } }).catch(() => null);
    if (!stream) {
      setScanning(false);
      setErr(s.scanUnsupported);
      return;
    }
    const v = videoRef.current!;
    v.srcObject = stream;
    await v.play();
    const det = new BD({ formats: ["qr_code"] });
    const stop = () => {
      stream.getTracks().forEach((t) => t.stop());
      setScanning(false);
    };
    const loop = async () => {
      if (!stream.active) return;
      const codes = await det.detect(v).catch(() => []);
      if (codes[0]) {
        stop();
        const raw = codes[0].rawValue;
        setInput(raw);
        const m = raw.match(/#\/(01\/\d+\/21\/[^?#]+)/);
        if (m) nav(`/${m[1]}`);
        else run(raw);
        return;
      }
      requestAnimationFrame(loop);
    };
    loop();
    (v as HTMLVideoElement & { _stop?: () => void })._stop = stop;
  };

  const passed = results.filter((r) => r.state === "pass").length;
  const applicable = results.filter((r) => r.state !== "na").length;

  return (
    <div className="stack-lg console">
      <header className="page-head">
        <span className="eyebrow">{s.eyebrow}</span>
        <h1>{s.title}</h1>
        <p className="lead">{s.lead}</p>
      </header>
      <form className="card row" onSubmit={submit} style={{ alignItems: "flex-end" }}>
        <div className="field" style={{ flex: "1 1 320px" }}>
          <label htmlFor="ref">{s.input}</label>
          <input id="ref" className="input" value={input} onChange={(e) => setInput(e.target.value)} placeholder="7" autoComplete="off" spellCheck={false} />
        </div>
        <button className="btn btn-ink" type="submit" disabled={state === "running" || !input.trim()}>{s.run}</button>
        <button className="btn btn-outline" type="button" onClick={scanning ? () => (videoRef.current as HTMLVideoElement & { _stop?: () => void })?._stop?.() : scan}>
          {scanning ? s.stopScan : s.scan}
        </button>
      </form>
      <video ref={videoRef} hidden={!scanning} muted playsInline style={{ width: "100%", maxWidth: 360, borderRadius: 14 }} />
      {err && <div className="notice notice--error" role="alert">{err}</div>}

      {(results.length > 0 || state === "running") && (
        <section aria-live="polite" className="stack-md">
          <div className="row-between">
            <h2 className="t-h3" style={{ fontSize: 24 }}>{c.passport} #{String(pid ?? "")}</h2>
            <div className="row">
              {state === "running" ? (
                <span className="row muted small"><span className="spinner" aria-hidden="true" />{s.running}</span>
              ) : (
                <span className={`pill ${passed === applicable ? "pill--pass" : "pill--fail"}`}>{passed} / {applicable} {s.done}</span>
              )}
              {pid !== undefined && <Link className="btn btn-sm btn-outline" to={`/p/${pid}`}>{s.open}</Link>}
            </div>
          </div>
          <div className="checks">
            {results.map((r) => (
              <article key={r.id} className="check" data-state={r.state}>
                <span className="check__icon">{r.state === "pass" ? Icon.check : r.state === "fail" ? Icon.x : Icon.dash}</span>
                <div>
                  <div className="check__title">{s.titles[r.id] ?? r.id}</div>
                  <div className="check__detail">{detail(r, lang, c.grade, c.status)}</div>
                  {r.calls.length > 0 && (
                    <details style={{ marginTop: 6 }}>
                      <summary className="small muted" style={{ cursor: "pointer" }}>{s.calls}</summary>
                      <div className="check__call">{r.calls.map((x, i) => <div key={i}>{x}</div>)}</div>
                    </details>
                  )}
                </div>
                <span className={`pill ${r.state === "pass" ? "pill--pass" : r.state === "fail" ? "pill--fail" : ""}`}>
                  {r.state === "pass" ? c.pass : r.state === "fail" ? c.fail : s.na}
                </span>
              </article>
            ))}
          </div>
        </section>
      )}
    </div>
  );
}
