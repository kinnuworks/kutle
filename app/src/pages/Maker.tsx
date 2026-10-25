import { useEffect, useMemo, useState } from "react";
import { Link } from "react-router-dom";
import { defineStrings, useLang, useStrings } from "../i18n/index.tsx";
import { common } from "../i18n/common.ts";
import { useAsync } from "../lib/hooks.ts";
import { dep, getDemo, getPassport, getRecycledShares, passportCount } from "../lib/data.ts";
import { loadWallet, rememberChange, type WalletNote } from "../lib/wallet.ts";
import { bindingOf, buildSpend, nextSaltIndex, noteSalt, ownerCommit } from "../lib/zk/notes.ts";
import { proveSpend, warmUpProver, type CompiledCircuit, type ProofResult } from "../lib/zk/prover.ts";

// bb.js thread workers do not start under every dev server, so one thread is the default.
const THREADS = Number(import.meta.env.VITE_BB_THREADS ?? 1);
import { notePoolAbi } from "../abi/index.ts";
import { sendAndWait } from "../lib/tx.ts";
import { errorMessage } from "../lib/errors.ts";
import { parseEventLogs, type Hex } from "viem";
import { CHAIN_ID, demoSecret } from "../config/index.ts";
import { roleAddress } from "../lib/chain.ts";
import { ELEMENT_SYMBOLS, MIN_SHARE_2031_BPS, MIN_SHARE_2036_BPS, grams, num, pct } from "../lib/format.ts";
import { DemoKeysTag, ErrorBox, Loading, Pill, ShareBar, Stat, TxHash } from "../components/ui.tsx";

const S = defineStrings({
  en: {
    eyebrow: "Maker console",
    title: "Back a new battery with recycled metal.",
    lead: "Pick recycled-metal notes the demo maker owns, prove in this browser that they are unspent and worth the declared grams, and spend them into a passport.",
    private: "The chain learns the passport, the element, the declared grams and one nullifier per note; which recycler and which lot the metal came from stay private.",
    wallet: "Notes in the wallet",
    walletLead: "Found on chain from the demo owner secret. Change notes are remembered by this browser.",
    element: "Element",
    amount: "Grams",
    leaf: "Leaf",
    state: "State",
    spent: "spent",
    unspent: "unspent",
    change: "change",
    pick: "Pick",
    none: "No notes for this secret yet. Issue some from the recycler console.",
    passport: "Passport to back",
    declared: "Grams to declare",
    changeBack: "Change back to the wallet",
    sameElement: "Pick notes of one element, at most four.",
    prove: "Prove and spend",
    stages: { witness: "Executing the circuit", prove: "Proving with UltraHonk", verify: "Checking the proof locally", submit: "Submitting NotePool.spend" } as Record<string, string>,
    witness: "Witness",
    proving: "Proving",
    verifyLocal: "Local check",
    proofSize: "Proof size",
    thread: "thread",
    threads: "threads",
    done: "Spent. The recycled share below is read again from the chain.",
    before: "before",
    after: "now",
    share: "Recycled share",
    noSecret: "No demo owner secret configured (VITE_DEMO_MAKER_SECRET).",
    notOperator: "The demo maker does not operate this passport, or it is not an active original passport.",
    meets: "meets",
    misses: "misses",
    verifyLink: "Verify this passport",
  },
  tr: {
    eyebrow: "Üretici konsolu",
    title: "Yeni bir bataryayı geri dönüştürülmüş metalle destekleyin.",
    lead: "Demo üreticinin sahip olduğu geri dönüştürülmüş metal notlarını seçin, harcanmamış olduklarını ve beyan edilen gramlar kadar değer taşıdıklarını bu tarayıcıda ispatlayın ve onları bir pasaporta harcayın.",
    private: "Zincir pasaportu, elementi, beyan edilen gramı ve her not için bir nullifier öğrenir; metalin hangi geri dönüşümcüden ve hangi partiden geldiği gizli kalır.",
    wallet: "Cüzdandaki notlar",
    walletLead: "Demo sahip sırrından zincirde bulundu. Para üstü notlarını bu tarayıcı hatırlar.",
    element: "Element",
    amount: "Gram",
    leaf: "Yaprak",
    state: "Durum",
    spent: "harcandı",
    unspent: "harcanmadı",
    change: "para üstü",
    pick: "Seç",
    none: "Bu sır için henüz not yok. Geri dönüşümcü konsolundan not verin.",
    passport: "Desteklenecek pasaport",
    declared: "Beyan edilecek gram",
    changeBack: "Cüzdana dönecek para üstü",
    sameElement: "Tek bir elementten en fazla dört not seçin.",
    prove: "İspatla ve harca",
    stages: { witness: "Devre çalıştırılıyor", prove: "UltraHonk ile ispatlanıyor", verify: "İspat yerelde kontrol ediliyor", submit: "NotePool.spend gönderiliyor" } as Record<string, string>,
    witness: "Tanık",
    proving: "İspat",
    verifyLocal: "Yerel kontrol",
    proofSize: "İspat boyutu",
    thread: "iş parçacığı",
    threads: "iş parçacığı",
    done: "Harcandı. Aşağıdaki geri dönüştürülmüş pay zincirden yeniden okunur.",
    before: "önce",
    after: "şimdi",
    share: "Geri dönüştürülmüş pay",
    noSecret: "Demo sahip sırrı ayarlanmamış (VITE_DEMO_MAKER_SECRET).",
    notOperator: "Demo üretici bu pasaportu işletmiyor ya da pasaport aktif bir asıl pasaport değil.",
    meets: "karşılıyor",
    misses: "karşılamıyor",
    verifyLink: "Bu pasaportu doğrula",
  },
});

let circuitCache: Promise<CompiledCircuit> | undefined;
const loadCircuit = () => (circuitCache ??= fetch("./circuits/shielded_spend.json").then((r) => r.json()));

async function eligiblePassports() {
  const me = roleAddress("manufacturer")?.toLowerCase();
  const n = Number(await passportCount());
  const out: { id: bigint; label: string }[] = [];
  for (let i = 1; i <= n; i++) {
    const { passport } = await getPassport(BigInt(i));
    if (passport.operator.toLowerCase() === me && passport.status === 1 && passport.parentId === 0n && !passport.recycledLocked && passport.composition.some((g) => g > 0n)) {
      out.push({ id: BigInt(i), label: `#${i}` });
    }
  }
  return out;
}

export default function Maker() {
  const s = useStrings(S);
  const c = useStrings(common);
  const { lang } = useLang();
  const secret = demoSecret("MAKER");
  const wallet = useAsync(() => (secret ? loadWallet(secret) : Promise.resolve(null)), []);
  const targets = useAsync(eligiblePassports, []);
  const demo = useAsync(getDemo, []);
  const [picked, setPicked] = useState<number[]>([]);
  const [pid, setPid] = useState<string>("");
  const [declared, setDeclared] = useState<string>("");
  const [run, setRun] = useState<{ stage?: string; proof?: ProofResult; hash?: Hex; err?: string; threads?: number }>({});
  const [before, setBefore] = useState<Awaited<ReturnType<typeof getRecycledShares>>>();

  useEffect(() => {
    warmUpProver(globalThis.crossOriginIsolated ? THREADS : 1);
  }, []);
  useEffect(() => {
    if (!pid && demo.data) setPid(String(demo.data.passports.newBattery));
  }, [demo.data, pid]);
  const shares = useAsync(() => (pid ? Promise.all([getRecycledShares(BigInt(pid)), getPassport(BigInt(pid))]) : Promise.resolve(null)), [pid, run.hash]);

  const notes = wallet.data?.notes ?? [];
  const sel = notes.filter((n) => picked.includes(n.leafIndex));
  const element = sel[0]?.element;
  const total = sel.reduce((a, n) => a + n.grams, 0n);
  const declaredG = /^\d+$/.test(declared) ? BigInt(declared) : total;
  const changeG = total - declaredG;
  const valid = sel.length > 0 && sel.length <= 4 && sel.every((n) => n.element === element && !n.spent) && declaredG > 0n && changeG >= 0n && !!pid;

  const toggle = (n: WalletNote) => {
    setRun({});
    setPicked((p) => (p.includes(n.leafIndex) ? p.filter((x) => x !== n.leafIndex) : sel.length && sel[0].element !== n.element ? [n.leafIndex] : [...p, n.leafIndex].slice(-4)));
  };
  useEffect(() => setDeclared(total > 0n ? total.toString() : ""), [total]);

  const isTarget = useMemo(() => targets.data?.some((t) => String(t.id) === pid), [targets.data, pid]);

  const go = async () => {
    if (!wallet.data || !secret || element === undefined) return;
    setRun({ stage: "witness" });
    try {
      setBefore(shares.data?.[0]);
      const tree = wallet.data.tree;
      const changeSalt = nextSaltIndex(notes, [demo.data?.notes.makerSaltsUsed ?? 0].flatMap((m) => Array.from({ length: m }, (_, i) => i)));
      const built = buildSpend({
        tree, element, passportId: BigInt(pid), declaredGrams: declaredG, ownerSecret: secret,
        notes: sel.map((n) => ({ salt: n.salt, grams: n.grams, leafIndex: n.leafIndex })),
        changeGrams: changeG, changeOwnerCommit: changeG > 0n ? ownerCommit(secret, noteSalt(secret, changeSalt)) : 0n,
        binding: bindingOf(CHAIN_ID, dep().notePool),
      });
      const threads = globalThis.crossOriginIsolated ? THREADS : 1;
      const circuit = await loadCircuit();
      const proof = await proveSpend(circuit, built.inputs, { threads, keepAlive: true, onStage: (st) => setRun((r) => ({ ...r, stage: st, threads })) });
      setRun((r) => ({ ...r, proof, stage: "submit" }));
      const { hash, receipt } = await sendAndWait("manufacturer", {
        address: dep().notePool, abi: notePoolAbi, functionName: "spend",
        args: [BigInt(pid), element, declaredG, built.root, built.nullifiers, built.changeLeaf, proof.proof],
      });
      if (changeG > 0n) {
        const ev = parseEventLogs({ abi: notePoolAbi, logs: receipt.logs }).find((l) => l.eventName === "ChangeNote");
        if (ev && ev.eventName === "ChangeNote") rememberChange({ element, grams: changeG, saltIndex: changeSalt, leafIndex: Number(ev.args.leafIndex) });
      }
      setRun((r) => ({ ...r, hash, stage: undefined }));
      setPicked([]);
      wallet.reload();
    } catch (e) {
      setRun((r) => ({ ...r, err: errorMessage(e), stage: undefined }));
    }
  };

  return (
    <div className="stack-lg console">
      <header className="page-head">
        <span className="eyebrow"><span className="dot" />{s.eyebrow}</span>
        <h1>{s.title}</h1>
        <p className="lead">{s.lead}</p>
        <p className="notice" style={{ marginTop: 14 }}>{s.private}</p>
        <div style={{ marginTop: 12 }}><DemoKeysTag /></div>
      </header>
      {!secret && <div className="notice notice--warn">{s.noSecret}</div>}

      <div className="grid grid-2" style={{ alignItems: "start" }}>
        <section className="card stack-md">
          <div>
            <h2>{s.wallet}</h2>
            <p className="small muted">{s.walletLead}</p>
          </div>
          {wallet.loading && !wallet.data ? <Loading /> : wallet.error != null ? <ErrorBox error={wallet.error} onRetry={wallet.reload} /> : notes.length === 0 ? <p className="muted">{s.none}</p> : (
            <div className="table-wrap">
              <table className="table">
                <thead><tr><th>{s.pick}</th><th>{s.element}</th><th className="num">{s.amount}</th><th className="num">{s.leaf}</th><th>{s.state}</th></tr></thead>
                <tbody>
                  {notes.map((n) => (
                    <tr key={n.leafIndex} aria-selected={picked.includes(n.leafIndex)}>
                      <td><input type="checkbox" aria-label={`${s.pick} ${ELEMENT_SYMBOLS[n.element]} ${n.grams} g`} disabled={n.spent} checked={picked.includes(n.leafIndex)} onChange={() => toggle(n)} /></td>
                      <td><span style={{ display: "inline-block", width: 8, height: 8, borderRadius: 4, marginRight: 6, background: `var(--el-${ELEMENT_SYMBOLS[n.element].toLowerCase()})` }} />{c.elements[n.element]}</td>
                      <td className="num">{grams(n.grams, lang)}</td>
                      <td className="num">{n.leafIndex}</td>
                      <td>{n.spent ? <Pill>{s.spent}</Pill> : <Pill kind="pass">{s.unspent}</Pill>} {n.change && <Pill>{s.change}</Pill>}</td>
                    </tr>
                  ))}
                </tbody>
              </table>
            </div>
          )}
          <p className="small muted">{s.sameElement}</p>
        </section>

        <section className="card stack-md">
          <div className="grid grid-2">
            <div className="field">
              <label htmlFor="mk-pid">{s.passport}</label>
              <select id="mk-pid" className="input" value={pid} onChange={(e) => { setPid(e.target.value); setRun({}); }}>
                {(targets.data ?? []).map((t) => <option key={String(t.id)} value={String(t.id)}>{c.passport} {t.label}</option>)}
                {pid && !isTarget && <option value={pid}>{c.passport} #{pid}</option>}
              </select>
            </div>
            <div className="field">
              <label htmlFor="mk-g">{s.declared}</label>
              <input id="mk-g" className="input" inputMode="numeric" value={declared} onChange={(e) => setDeclared(e.target.value.replace(/\D/g, ""))} disabled={!sel.length} />
            </div>
          </div>
          <div className="small muted">{s.changeBack}: <strong>{grams(changeG > 0n ? changeG : 0n, lang)}</strong></div>
          {targets.data && pid && !isTarget && <div className="notice notice--warn">{s.notOperator}</div>}
          <div className="row">
            <button className="btn btn-candy" onClick={go} disabled={!valid || !!run.stage || !secret}>{s.prove}</button>
            {run.stage && <span className="row small muted" aria-live="polite"><span className="spinner" aria-hidden="true" />{s.stages[run.stage]}</span>}
          </div>
          {run.proof && (
            <div className="grid grid-2">
              <Stat label={s.proving} value={`${num(run.proof.timings.proveMs, lang)} ms`} sub={`${run.threads ?? 1} ${(run.threads ?? 1) === 1 ? s.thread : s.threads}`} />
              <Stat label={s.witness} value={`${num(run.proof.timings.witnessMs, lang)} ms`} sub={`${s.verifyLocal} ${num(run.proof.timings.verifyMs, lang)} ms`} />
              <Stat label={s.proofSize} value={`${num((run.proof.proof.length - 2) / 2, lang)} B`} sub="UltraHonk, keccak transcript" />
            </div>
          )}
          {run.hash && <div className="notice notice--ok row">{s.done} <TxHash hash={run.hash} /></div>}
          {run.err && <div className="notice notice--error" role="alert">{run.err}</div>}

          {shares.data && (
            <div className="stack-sm">
              <h3>{s.share} · {c.passport} #{pid}</h3>
              {shares.data[0].filter((x) => shares.data![1].passport.composition[x.element] > 0n).map((x) => {
                const b = before?.find((y) => y.element === x.element);
                return (
                  <div key={x.element} className="stack-sm">
                    <div className="row-between small">
                      <span><strong>{c.elements[x.element]}</strong> {b && b.shareBps !== x.shareBps ? `· ${s.before} ${pct(b.shareBps, lang)} → ${s.after}` : ""} <strong>{pct(x.shareBps, lang)}</strong></span>
                      <span className="row">
                        <Pill kind={x.meets2031 ? "pass" : "fail"}>2031 {x.meets2031 ? s.meets : s.misses}</Pill>
                        <Pill kind={x.meets2036 ? "pass" : "warn"}>2036 {x.meets2036 ? s.meets : s.misses}</Pill>
                      </span>
                    </div>
                    <ShareBar element={x.element} shareBps={x.shareBps} min31={MIN_SHARE_2031_BPS[x.element]} min36={MIN_SHARE_2036_BPS[x.element]} label={`${c.elements[x.element]} ${pct(x.shareBps, lang)}`} />
                  </div>
                );
              })}
              <Link className="small" style={{ textDecoration: "underline" }} to={`/verify/${pid}`}>{s.verifyLink}</Link>
            </div>
          )}
        </section>
      </div>
    </div>
  );
}
