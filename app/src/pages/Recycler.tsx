import { useEffect, useMemo, useState } from "react";
import { Link } from "react-router-dom";
import { parseEventLogs, toHex, type Hex } from "viem";
import { sha256 } from "@noble/hashes/sha2.js";
import { defineStrings, useLang, useStrings } from "../i18n/index.tsx";
import { common } from "../i18n/common.ts";
import { useAsync } from "../lib/hooks.ts";
import { dep, getDemo, getLedgerBatch, getPassport, ledgerBatchCount, passportCount } from "../lib/data.ts";
import { conservationLedgerAbi } from "../abi/index.ts";
import { publicClient, roleAddress } from "../lib/chain.ts";
import { sendAndWait } from "../lib/tx.ts";
import { errorMessage } from "../lib/errors.ts";
import { assayCheck } from "../lib/checks.ts";
import { signAssay, four, type Assay } from "../lib/assay.ts";
import { loadWallet } from "../lib/wallet.ts";
import { nextSaltIndex, noteSalt, ownerCommit } from "../lib/zk/notes.ts";
import { demoSecret } from "../config/index.ts";
import { ELEMENT_SYMBOLS, MAX_RECOVERY_BPS, grams, num } from "../lib/format.ts";
import { DemoKeysTag, ErrorBox, Hash, Loading, Pill, TxHash } from "../components/ui.tsx";

const DEFAULT_RECOVERY = [95, 60, 96, 95];

const S = defineStrings({
  en: {
    eyebrow: "Recycler console",
    title: "Turn end-of-life packs into recycled metal, gram for gram.",
    lead: "Open a batch, feed it passports, record a lab assay co-signed by the recycler and an accredited lab, then issue the recovered metal as private notes. The ledger keeps input = recovered + loss + unprocessed for every element.",
    s1: "1. Batch",
    s2: "2. Intake",
    s3: "3. Assay",
    s4: "4. Signatures and settlement",
    s5: "5. Issue notes",
    batch: "Batch",
    open: "Open a new batch",
    passports: "passports",
    passport1: "passport",
    assays: "assays",
    assay1: "assay",
    tainted: "tainted",
    noBatch: "No batch yet.",
    intakeLead: "Active passports the demo manufacturer issued. Intake closes them for good; their declared metal becomes the batch input.",
    intake: "Close and feed in",
    afterAssay: "This batch already has an assay, so its input is fixed.",
    noneActive: "No active end-of-life passports left.",
    pending: "Unprocessed",
    recovered: "Recovered",
    loss: "Loss",
    residual: "Left unprocessed",
    ceiling: "Ceiling",
    balanced: "balanced",
    unbalanced: "does not balance",
    over: "over the ceiling",
    lab: "Lab",
    accredited: "accredited demo lab",
    unaccredited: "unaccredited lab (will be refused)",
    report: "Assay report text (its sha256 goes on chain)",
    signRec: "Sign as recycler",
    signLab: "Sign as lab",
    digest: "EIP-712 digest",
    onchainDigest: "ConservationLedger.assayDigest agrees",
    settle: "Settle on chain",
    nothing: "Nothing pending in this batch.",
    issuable: "Issuable",
    issued: "Issued",
    element: "Element",
    split: "Note sizes in grams, comma separated",
    issue: "Issue to the demo maker's wallet",
    issueNote: "Each note commits to the maker's secret; the grams are public here and private from then on.",
    done: "Done",
    seeMaker: "Spend them in the maker console",
    willRefuse: "This assay does not balance or claims more than the ceiling. The contract will refuse it; settle it anyway to see the decoded error.",
  },
  tr: {
    eyebrow: "Geri dönüşümcü konsolu",
    title: "Ömrünü tamamlamış paketleri gram gram geri dönüştürülmüş metale çevirin.",
    lead: "Bir parti açın, ona pasaportlar verin, geri dönüşümcü ve akredite bir laboratuvarın ortak imzaladığı bir analizi kaydedin, sonra geri kazanılan metali gizli notlar olarak verin. Defter her element için girdi = geri kazanılan + kayıp + işlenmemiş eşitliğini korur.",
    s1: "1. Parti",
    s2: "2. Alım",
    s3: "3. Analiz",
    s4: "4. İmzalar ve kapanış",
    s5: "5. Not ver",
    batch: "Parti",
    open: "Yeni parti aç",
    passports: "pasaport",
    passport1: "pasaport",
    assays: "analiz",
    assay1: "analiz",
    tainted: "lekeli",
    noBatch: "Henüz parti yok.",
    intakeLead: "Demo üreticinin verdiği aktif pasaportlar. Alım onları kalıcı olarak kapatır; beyan edilen metalleri partinin girdisi olur.",
    intake: "Kapat ve partiye ekle",
    afterAssay: "Bu partinin zaten bir analizi var, girdisi sabit.",
    noneActive: "Ömrünü tamamlamış aktif pasaport kalmadı.",
    pending: "İşlenmemiş",
    recovered: "Geri kazanılan",
    loss: "Kayıp",
    residual: "İşlenmeden kalan",
    ceiling: "Tavan",
    balanced: "dengede",
    unbalanced: "dengelenmiyor",
    over: "tavanın üstünde",
    lab: "Laboratuvar",
    accredited: "akredite demo laboratuvarı",
    unaccredited: "akredite olmayan laboratuvar (reddedilecek)",
    report: "Analiz raporu metni (sha256 değeri zincire yazılır)",
    signRec: "Geri dönüşümcü olarak imzala",
    signLab: "Laboratuvar olarak imzala",
    digest: "EIP-712 özeti",
    onchainDigest: "ConservationLedger.assayDigest aynı sonucu veriyor",
    settle: "Zincirde kapat",
    nothing: "Bu partide işlenmemiş bir şey yok.",
    issuable: "Verilebilir",
    issued: "Verilen",
    element: "Element",
    split: "Gram cinsinden not büyüklükleri, virgülle ayrılmış",
    issue: "Demo üreticinin cüzdanına ver",
    issueNote: "Her not üreticinin sırrına bağlanır; gramlar burada açıktır, sonrasında gizlidir.",
    done: "Tamam",
    seeMaker: "Üretici konsolunda harcayın",
    willRefuse: "Bu analiz dengelenmiyor ya da tavanın üstünde talep ediyor. Sözleşme reddedecek; çözülmüş hatayı görmek için yine de kapatabilirsiniz.",
  },
});

async function loadBatches() {
  const n = Number(await ledgerBatchCount());
  const me = roleAddress("recycler")?.toLowerCase();
  // The seeded batch without an assay stays untouched for the attack console.
  const held = (await getDemo())?.batches.pending;
  const out: { id: bigint; b: Awaited<ReturnType<typeof getLedgerBatch>> }[] = [];
  for (let i = 1; i <= n; i++) {
    const b = await getLedgerBatch(BigInt(i));
    if ((!me || b.recycler.toLowerCase() === me) && i !== held) out.push({ id: BigInt(i), b });
  }
  return out;
}

async function loadIntakeCandidates() {
  const demo = await getDemo();
  const reserved = new Set([demo?.passports.storyChild, demo?.passports.newBattery, demo?.passports.target].map(String));
  const me = roleAddress("manufacturer")?.toLowerCase();
  const n = Number(await passportCount());
  const out: { id: bigint; comp: readonly bigint[] }[] = [];
  for (let i = 1; i <= n; i++) {
    if (reserved.has(String(i))) continue;
    const { passport } = await getPassport(BigInt(i));
    if (passport.status === 1 && passport.operator.toLowerCase() === me) out.push({ id: BigInt(i), comp: passport.composition });
  }
  return out;
}

export default function Recycler() {
  const s = useStrings(S);
  const { lang } = useLang();
  const batches = useAsync(loadBatches, []);
  const cands = useAsync(loadIntakeCandidates, []);
  const [sel, setSel] = useState<string>("");
  const [picked, setPicked] = useState<string[]>([]);
  const [busy, setBusy] = useState<string>();
  const [msg, setMsg] = useState<{ kind: "ok" | "err"; text: string; hash?: Hex }>();

  const list = batches.data ?? [];
  useEffect(() => {
    if (!sel && list.length) setSel(String(list[list.length - 1].id));
  }, [list, sel]);
  const cur = list.find((x) => String(x.id) === sel);

  const act = async (name: string, f: () => Promise<Hex | void>) => {
    setBusy(name);
    setMsg(undefined);
    try {
      const hash = await f();
      setMsg({ kind: "ok", text: s.done, hash: hash || undefined });
      batches.reload();
      cands.reload();
    } catch (e) {
      setMsg({ kind: "err", text: errorMessage(e) });
    } finally {
      setBusy(undefined);
    }
  };

  const openBatch = () =>
    act("open", async () => {
      const { hash, receipt } = await sendAndWait("recycler", { address: dep().conservationLedger, abi: conservationLedgerAbi, functionName: "openBatch", args: [] });
      const ev = parseEventLogs({ abi: conservationLedgerAbi, logs: receipt.logs }).find((l) => l.eventName === "BatchOpened");
      if (ev && ev.eventName === "BatchOpened") setSel(String(ev.args.batchId));
      return hash;
    });

  const intake = () =>
    act("intake", async () => {
      const { hash } = await sendAndWait("recycler", { address: dep().conservationLedger, abi: conservationLedgerAbi, functionName: "intake", args: [BigInt(sel), picked.map(BigInt)] });
      setPicked([]);
      return hash;
    });

  return (
    <div className="stack-lg console">
      <header className="page-head">
        <span className="eyebrow"><span className="dot" />{s.eyebrow}</span>
        <h1>{s.title}</h1>
        <p className="lead">{s.lead}</p>
        <div style={{ marginTop: 12 }}><DemoKeysTag /></div>
      </header>

      {msg && (
        <div className={`notice ${msg.kind === "ok" ? "notice--ok" : "notice--error"} row`} role={msg.kind === "err" ? "alert" : "status"}>
          <span>{msg.text}</span>{msg.hash && <TxHash hash={msg.hash} />}
        </div>
      )}

      <section className="card stack-md">
        <div className="row-between">
          <h2>{s.s1}</h2>
          <button className="btn btn-ink btn-sm" onClick={openBatch} disabled={!!busy}>{s.open}</button>
        </div>
        {batches.loading && !batches.data ? <Loading /> : batches.error != null ? <ErrorBox error={batches.error} onRetry={batches.reload} /> : list.length === 0 ? <p className="muted">{s.noBatch}</p> : (
          <div className="segmented" role="tablist" aria-label={s.batch} style={{ flexWrap: "wrap" }}>
            {list.map((x) => (
              <button key={String(x.id)} role="tab" aria-selected={sel === String(x.id)} onClick={() => setSel(String(x.id))}>
                {s.batch} #{String(x.id)} · {x.b.passportCount} {x.b.passportCount === 1 ? s.passport1 : s.passports} · {x.b.assayCount} {x.b.assayCount === 1 ? s.assay1 : s.assays}{x.b.tainted ? ` · ${s.tainted}` : ""}
              </button>
            ))}
          </div>
        )}
      </section>

      {cur && (
        <>
          <section className="card stack-md">
            <h2>{s.s2}</h2>
            <p className="small muted">{s.intakeLead}</p>
            {cur.b.assayCount > 0 ? <p className="notice">{s.afterAssay}</p> : cands.loading && !cands.data ? <Loading /> : !cands.data?.length ? <p className="muted">{s.noneActive}</p> : (
              <>
                <div className="chips" role="group" aria-label={s.s2}>
                  {cands.data.map((p) => (
                    <button key={String(p.id)} className="chip" aria-pressed={picked.includes(String(p.id))}
                      onClick={() => setPicked((xs) => (xs.includes(String(p.id)) ? xs.filter((x) => x !== String(p.id)) : [...xs, String(p.id)]))}>
                      #{String(p.id)} · {p.comp.map((g, i) => (g > 0n ? `${ELEMENT_SYMBOLS[i]} ${grams(g, lang)}` : null)).filter(Boolean).join(", ")}
                    </button>
                  ))}
                </div>
                <div><button className="btn btn-ink btn-sm" onClick={intake} disabled={!picked.length || !!busy}>{s.intake} ({picked.length})</button></div>
              </>
            )}
          </section>

          <AssayStep batchId={cur.id} b={cur.b} busy={!!busy} act={act} />
          <IssueStep batchId={cur.id} b={cur.b} busy={!!busy} act={act} />
        </>
      )}
    </div>
  );
}

type Batch = Awaited<ReturnType<typeof getLedgerBatch>>;
type Act = (name: string, f: () => Promise<Hex | void>) => Promise<void>;

function AssayStep({ batchId, b, busy, act }: { batchId: bigint; b: Batch; busy: boolean; act: Act }) {
  const s = useStrings(S);
  const c = useStrings(common);
  const { lang } = useLang();
  const pending = b.pending;
  const defaults = () => pending.map((p, i) => ({ rec: ((p * BigInt(DEFAULT_RECOVERY[i])) / 100n).toString(), res: "0" }));
  const [rows, setRows] = useState(defaults);
  const [lab, setLab] = useState<"lab" | "unaccreditedLab">("lab");
  const [report, setReport] = useState("ICP-OES assay, demo lab");
  const [sigs, setSigs] = useState<{ rec?: Hex; lab?: Hex; digest?: Hex; agrees?: boolean }>({});
  const [deadline, setDeadline] = useState<bigint>(0n);
  useEffect(() => {
    setRows(defaults());
    setSigs({});
    // eslint-disable-next-line react-hooks/exhaustive-deps
  }, [String(batchId), pending.join(",")]);
  useEffect(() => {
    publicClient.getBlock().then((blk) => setDeadline(blk.timestamp + 86_400n));
  }, [String(batchId)]);

  const parsed = rows.map((r, i) => {
    const rec = /^\d+$/.test(r.rec) ? BigInt(r.rec) : 0n;
    const res = /^\d+$/.test(r.res) ? BigInt(r.res) : 0n;
    const loss = pending[i] - rec - res;
    return { rec, res, loss: loss < 0n ? 0n : loss, rawLoss: loss, chk: assayCheck(pending[i], rec, loss < 0n ? 0n : loss, res, i) };
  });
  const anyPending = pending.some((p) => p > 0n);
  const allOk = parsed.every((p, i) => pending[i] === 0n || (p.chk.ok && p.rawLoss >= 0n));
  const assay: Assay = useMemo(
    () => ({
      batchId, recovered: four(parsed.map((p) => p.rec)), loss: four(parsed.map((p) => p.loss)), residual: four(parsed.map((p) => p.res)),
      reportHash: toHex(sha256(new TextEncoder().encode(report))), lab: roleAddress(lab)!, nonce: b.assayCount, deadline,
    }),
    // eslint-disable-next-line react-hooks/exhaustive-deps
    [JSON.stringify(rows), lab, report, b.assayCount, deadline, String(batchId)],
  );
  useEffect(() => setSigs({}), [assay]);

  const [signErr, setSignErr] = useState<string>();
  const sign = async (who: "recycler" | "lab") => {
    setSignErr(undefined);
    const sig = await signAssay(who === "recycler" ? "recycler" : lab, assay);
    const digest = await publicClient.readContract({ address: dep().conservationLedger, abi: conservationLedgerAbi, functionName: "assayDigest", args: [assay] });
    setSigs((x) => ({ ...x, [who === "recycler" ? "rec" : "lab"]: sig, digest, agrees: true }));
  };
  const settle = () =>
    act("settle", async () => (await sendAndWait("recycler", { address: dep().conservationLedger, abi: conservationLedgerAbi, functionName: "settle", args: [assay, sigs.rec!, sigs.lab!] })).hash);

  return (
    <>
      <section className="card stack-md">
        <h2>{s.s3}</h2>
        {!anyPending ? <p className="muted">{s.nothing}</p> : (
          <div className="stack-sm">
            {parsed.map((p, i) => pending[i] === 0n ? null : (
              <div key={i} className="stack-sm" style={{ padding: 12, borderRadius: 12, background: "var(--sunk)" }}>
                <div className="row-between">
                  <strong><span style={{ display: "inline-block", width: 8, height: 8, borderRadius: 4, marginRight: 6, background: `var(--el-${ELEMENT_SYMBOLS[i].toLowerCase()})` }} />{c.elements[i]}</strong>
                  <span className="row small">
                    <span className="mono">{num(pending[i], lang)} = {num(p.rec, lang)} + {num(p.rawLoss, lang)} + {num(p.res, lang)}</span>
                    {p.rawLoss < 0n || !p.chk.balanced ? <Pill kind="fail">{s.unbalanced}</Pill> : !p.chk.underCeiling ? <Pill kind="fail">{s.over}</Pill> : <Pill kind="pass">{s.balanced}</Pill>}
                  </span>
                </div>
                <div className="row">
                  <label className="field" style={{ flex: "1 1 140px" }}><span className="label">{s.recovered} (g)</span>
                    <input className="input" inputMode="numeric" value={rows[i].rec} onChange={(e) => setRows((r) => r.map((x, j) => (j === i ? { ...x, rec: e.target.value.replace(/\D/g, "") } : x)))} /></label>
                  <label className="field" style={{ flex: "1 1 140px" }}><span className="label">{s.residual} (g)</span>
                    <input className="input" inputMode="numeric" value={rows[i].res} onChange={(e) => setRows((r) => r.map((x, j) => (j === i ? { ...x, res: e.target.value.replace(/\D/g, "") } : x)))} /></label>
                  <div className="field" style={{ flex: "1 1 140px" }}><span className="label">{s.loss} (g)</span><div className="input" style={{ display: "flex", alignItems: "center" }}>{num(p.loss, lang)}</div></div>
                </div>
                <div className="small muted">{s.ceiling}: {num(p.chk.ceiling, lang)} g ({MAX_RECOVERY_BPS[i] / 100}% · {num(p.chk.processed, lang)} g {c.processed})</div>
              </div>
            ))}
            <div className="grid grid-2">
              <div className="field">
                <label htmlFor="lab">{s.lab}</label>
                <select id="lab" className="input" value={lab} onChange={(e) => setLab(e.target.value as "lab" | "unaccreditedLab")}>
                  <option value="lab">{s.accredited}</option>
                  <option value="unaccreditedLab">{s.unaccredited}</option>
                </select>
              </div>
              <div className="field">
                <label htmlFor="report">{s.report}</label>
                <input id="report" className="input" value={report} onChange={(e) => setReport(e.target.value)} />
              </div>
            </div>
          </div>
        )}
      </section>

      {!anyPending && (
        <section className="card stack-sm"><h2>{s.s4}</h2><p className="muted">{s.nothing}</p></section>
      )}
      {anyPending && (
        <section className="card stack-md">
          <h2>{s.s4}</h2>
          <div className="row">
            <button className="btn btn-outline btn-sm" onClick={() => sign("recycler").catch((e) => setSignErr(errorMessage(e)))} disabled={busy}>{s.signRec}</button>
            <button className="btn btn-outline btn-sm" onClick={() => sign("lab").catch((e) => setSignErr(errorMessage(e)))} disabled={busy}>{s.signLab}</button>
          </div>
          <dl className="kv">
            <dt>{s.digest}</dt><dd>{sigs.digest ? <><Hash value={sigs.digest} /> <span className="small muted">{s.onchainDigest}</span></> : "…"}</dd>
            <dt>{s.signRec}</dt><dd>{sigs.rec ? <Hash value={sigs.rec} /> : "…"}</dd>
            <dt>{s.signLab}</dt><dd>{sigs.lab ? <Hash value={sigs.lab} /> : "…"}</dd>
            <dt>nonce · deadline</dt><dd className="mono small">{assay.nonce} · {String(assay.deadline)} · reportHash <Hash value={assay.reportHash} /></dd>
          </dl>
          <div><button className="btn btn-candy" onClick={settle} disabled={busy || !sigs.rec || !sigs.lab}>{s.settle}</button></div>
          {!allOk && <p className="notice notice--warn">{s.willRefuse}</p>}
          {signErr && <div className="notice notice--error">{signErr}</div>}
        </section>
      )}
    </>
  );
}

function IssueStep({ batchId, b, busy, act }: { batchId: bigint; b: Batch; busy: boolean; act: Act }) {
  const s = useStrings(S);
  const c = useStrings(common);
  const { lang } = useLang();
  const elems = [0, 1, 2, 3].filter((e) => b.issuable[e] > 0n || b.issued[e] > 0n);
  const [el, setEl] = useState<number>(elems.find((e) => b.issuable[e] > 0n) ?? 0);
  const [split, setSplit] = useState("");
  useEffect(() => {
    const x = b.issuable[el];
    setSplit(x > 0n ? [x / 2n, x - x / 2n].filter((g) => g > 0n).join(", ") : "");
  }, [el, b.issuable[el]]);
  if (!elems.length) return null;
  const sizes = split.split(",").map((x) => x.trim()).filter(Boolean);
  const ok = sizes.length > 0 && sizes.every((x) => /^\d+$/.test(x) && BigInt(x) > 0n) && sizes.reduce((a, x) => a + BigInt(x), 0n) <= b.issuable[el];
  const secret = demoSecret("MAKER");

  const issue = () =>
    act("issue", async () => {
      if (!secret) throw new Error("VITE_DEMO_MAKER_SECRET is not set");
      const w = await loadWallet(secret);
      const demo = await getDemo();
      const reserved = Array.from({ length: demo?.notes.makerSaltsUsed ?? 0 }, (_, i) => i);
      const commits: bigint[] = [];
      const taken = [...w.notes];
      for (let i = 0; i < sizes.length; i++) {
        const idx = nextSaltIndex(taken, reserved);
        taken.push({ ...taken[0], saltIndex: idx });
        commits.push(ownerCommit(secret, noteSalt(secret, idx)));
      }
      const { hash } = await sendAndWait("recycler", {
        address: dep().conservationLedger, abi: conservationLedgerAbi, functionName: "issueNotes",
        args: [batchId, el, sizes.map(BigInt), commits],
      });
      return hash;
    });

  return (
    <section className="card stack-md">
      <h2>{s.s5}</h2>
      <div className="table-wrap">
        <table className="table">
          <thead><tr><th>{s.element}</th><th className="num">{s.recovered}</th><th className="num">{s.issued}</th><th className="num">{s.issuable}</th></tr></thead>
          <tbody>
            {elems.map((e) => (
              <tr key={e}><td>{c.elements[e]}</td><td className="num">{grams(b.recovered[e], lang)}</td><td className="num">{grams(b.issued[e], lang)}</td><td className="num">{grams(b.issuable[e], lang)}</td></tr>
            ))}
          </tbody>
        </table>
      </div>
      <div className="grid grid-2">
        <div className="field">
          <label htmlFor="iel">{s.element}</label>
          <select id="iel" className="input" value={el} onChange={(e) => setEl(Number(e.target.value))}>
            {elems.map((e) => <option key={e} value={e}>{c.elements[e]}</option>)}
          </select>
        </div>
        <div className="field">
          <label htmlFor="isplit">{s.split}</label>
          <input id="isplit" className="input" value={split} onChange={(e) => setSplit(e.target.value)} />
        </div>
      </div>
      <p className="small muted">{s.issueNote}</p>
      <div className="row">
        <button className="btn btn-ink btn-sm" onClick={issue} disabled={busy || !ok || b.tainted}>{s.issue}</button>
        <Link to="/maker" className="small" style={{ textDecoration: "underline" }}>{s.seeMaker}</Link>
      </div>
    </section>
  );
}
