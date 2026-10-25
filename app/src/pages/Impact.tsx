import { useState, type ReactNode } from "react";
import { Link } from "react-router-dom";
import { defineStrings, useLang, useStrings } from "../i18n/index.tsx";
import { common } from "../i18n/common.ts";
import { useAsync } from "../lib/hooks.ts";
import { getImpactTotals } from "../lib/data.ts";
import { num, pct } from "../lib/format.ts";
import { ErrorBox, Loading, Stat, TxHash } from "../components/ui.tsx";

import { avoidedTonnes } from "../lib/impact.ts";

const SRC = {
  fraunhofer: { label: "Fraunhofer ISI", href: "https://publica.fraunhofer.de/handle/publica/480983" },
  chalmers: { label: "Chalmers", href: "https://odr.chalmers.se/handle/20.500.12380/304462" },
  siro: { label: "ReportCubes (secondary source)", href: "https://www.thereportcubes.com/report-store/ev-battery-market-turkey" },
};

const S = defineStrings({
  en: {
    eyebrow: "Climate impact",
    title: "What a second life avoids.",
    lead: "A pack moved into stationary storage replaces a new battery that would otherwise be made. The chain books the avoided manufacturing emissions at every handoff; the calculator below scales the same factors.",
    onchain: "Booked on chain",
    onchainLead: "Running totals from PassportRegistry, summed over every repurposing so far.",
    gross: "Avoided, gross",
    alloc: "Avoided, allocated to second life",
    handoffs: "Second-life handoffs",
    perPack: "One pack",
    capacity: "Pack capacity (kWh)",
    retained: "Capacity left at retirement",
    perGwh: "Per GWh moved into second life",
    perGwhLead: "1 GWh of packs at 75% retained capacity replaces 750 MWh of new cells.",
    tr: "Türkiye scenario",
    trLead: "Pack output from Turkish plants and the share that reaches a second life. Packs made in a year reach retirement years later, so read this as the yearly effect once that output starts retiring.",
    output: "Pack output (GWh per year)",
    siroNow: "Siro today, 3 GWh",
    siro2031: "Siro 2031 target, 20 GWh",
    share: "Share of packs reaching second life",
    perYear: "per year",
    t: "t CO2e",
    to: "to",
    assumption: "ASSUMPTION",
    source: "Source",
    factors: "Factors and sources",
    f1: "Cell production emits 58 to 92 kg CO2e per kWh.",
    f2: "A second life relieves 15 to 29% of the first life's manufacturing burden under energy allocation.",
    f3: "Packs retire with about 75% of rated capacity left; the chain uses the lower bound of each pack's own graded interval instead.",
    f4: "Siro (Togg and Farasis, Gemlik) produces about 3 GWh a year today and targets 20 GWh by 2031.",
    f5: "The share of packs that reaches a second life is your assumption; set it with the slider.",
    seeHandoff: "The handoff in the story",
  },
  tr: {
    eyebrow: "İklim etkisi",
    title: "İkinci ömür neyi önler.",
    lead: "Sabit depolamaya taşınan bir paket, aksi halde üretilecek yeni bir bataryanın yerini alır. Zincir her devirde önlenen üretim emisyonlarını kaydeder; aşağıdaki hesaplayıcı aynı katsayıları ölçekler.",
    onchain: "Zincirde kayıtlı",
    onchainLead: "PassportRegistry'deki toplamlar, şimdiye kadarki tüm yeniden amaçlamalar üzerinden.",
    gross: "Önlenen, brüt",
    alloc: "Önlenen, ikinci ömre ayrılan",
    handoffs: "İkinci ömür devirleri",
    perPack: "Tek paket",
    capacity: "Paket kapasitesi (kWh)",
    retained: "Emeklilikte kalan kapasite",
    perGwh: "İkinci ömre taşınan her GWh için",
    perGwhLead: "%75 kapasitesi kalmış 1 GWh paket, 750 MWh yeni hücrenin yerini alır.",
    tr: "Türkiye senaryosu",
    trLead: "Türk tesislerinin paket üretimi ve ikinci ömre ulaşan pay. Bir yılda üretilen paketler yıllar sonra emekliye ayrılır; bu yüzden sonucu, o üretim emekliye ayrılmaya başladığında yıllık etki olarak okuyun.",
    output: "Paket üretimi (yılda GWh)",
    siroNow: "Siro bugün, 3 GWh",
    siro2031: "Siro 2031 hedefi, 20 GWh",
    share: "İkinci ömre ulaşan paket payı",
    perYear: "yılda",
    t: "t CO2e",
    to: "ila",
    assumption: "VARSAYIM",
    source: "Kaynak",
    factors: "Katsayılar ve kaynaklar",
    f1: "Hücre üretimi kWh başına 58 ila 92 kg CO2e salar.",
    f2: "Enerji paylaştırmasıyla ikinci ömür, ilk ömrün üretim yükünün %15 ila %29'unu hafifletir.",
    f3: "Paketler anma kapasitesinin yaklaşık %75'i kalmışken emekliye ayrılır; zincir bunun yerine her paketin kendi derecelendirilmiş aralığının alt sınırını kullanır.",
    f4: "Siro (Togg ve Farasis, Gemlik) bugün yılda yaklaşık 3 GWh üretiyor ve 2031'e kadar 20 GWh hedefliyor.",
    f5: "İkinci ömre ulaşan paket payı sizin varsayımınızdır; kaydırıcıyla ayarlayın.",
    seeHandoff: "Hikâyedeki devir",
  },
});

function Src({ k }: { k: keyof typeof SRC }) {
  const s = useStrings(S);
  return <a className="small" style={{ textDecoration: "underline" }} href={SRC[k].href} target="_blank" rel="noreferrer">{s.source}: {SRC[k].label}</a>;
}
function Assume({ children }: { children?: ReactNode }) {
  const s = useStrings(S);
  return <span className="tag-demo">{s.assumption}{children}</span>;
}

function Range({ min, max, step, value, onChange, id }: { min: number; max: number; step: number; value: number; onChange: (v: number) => void; id: string }) {
  return (
    <input id={id} className="range" type="range" min={min} max={max} step={step} value={value}
      style={{ ["--val" as string]: `${((value - min) / (max - min)) * 100}%` }}
      onChange={(e) => onChange(Number(e.target.value))} />
  );
}

export default function Impact() {
  const s = useStrings(S);
  const c = useStrings(common);
  const { lang } = useLang();
  const q = useAsync(getImpactTotals, []);
  const [kwh, setKwh] = useState(60);
  const [ret, setRet] = useState(75);
  const [gwh, setGwh] = useState(3);
  const [share, setShare] = useState(30);
  const pack = avoidedTonnes(kwh, ret / 100);
  const gw = avoidedTonnes(1_000_000, 0.75);
  const tr = avoidedTonnes(gwh * 1_000_000 * (share / 100), ret / 100);
  const T = (x: number, d = 0) => num(x, lang, d);

  return (
    <div className="stack-lg console">
      <header className="page-head">
        <span className="eyebrow">{s.eyebrow}</span>
        <h1>{s.title}</h1>
        <p className="lead">{s.lead}</p>
      </header>

      <section className="card stack-md">
        <div>
          <h2>{s.onchain}</h2>
          <p className="small muted">{s.onchainLead}</p>
        </div>
        {q.loading && !q.data ? <Loading /> : q.error != null ? <ErrorBox error={q.error} onRetry={q.reload} /> : q.data && (
          <>
            <div className="grid-4">
              <Stat label={s.gross} value={`${T(Number(q.data.lo) / 1e6, 2)} ${s.to} ${T(Number(q.data.hi) / 1e6, 2)}`} sub={s.t} />
              <Stat label={s.alloc} value={`${T(Number(q.data.aLo) / 1e6, 2)} ${s.to} ${T(Number(q.data.aHi) / 1e6, 2)}`} sub={s.t} />
              <Stat label={s.handoffs} value={T(q.data.repurposed.length)} />
              <Stat label="avoidedGramsLow" value={T(Number(q.data.lo))} sub="g CO2e" />
            </div>
            {q.data.repurposed.map((r) => (
              <div key={r.transactionHash} className="row small">
                <Link to={`/p/${r.args.parentId}`} style={{ textDecoration: "underline" }}>#{String(r.args.parentId)}</Link> →
                <Link to={`/p/${r.args.childId}`} style={{ textDecoration: "underline" }}>#{String(r.args.childId)}</Link>
                <span className="muted">{T(r.args.retainedWh! / 1000, 1)} kWh</span>
                <TxHash hash={r.transactionHash} />
              </div>
            ))}
          </>
        )}
      </section>

      <div className="grid grid-2" style={{ alignItems: "start" }}>
        <section className="card stack-md">
          <h2>{s.perPack}</h2>
          <div className="field">
            <label htmlFor="kwh">{s.capacity}: <strong>{T(kwh)}</strong></label>
            <Range id="kwh" min={10} max={120} step={1} value={kwh} onChange={setKwh} />
          </div>
          <div className="field">
            <label htmlFor="ret">{s.retained}: <strong>{ret}%</strong> <Assume /></label>
            <Range id="ret" min={60} max={90} step={1} value={ret} onChange={setRet} />
          </div>
          <div className="grid grid-2">
            <Stat label={s.gross} value={`${T(pack.lo, 1)} ${s.to} ${T(pack.hi, 1)}`} sub={s.t} />
            <Stat label={s.alloc} value={`${T(pack.aLo, 2)} ${s.to} ${T(pack.aHi, 2)}`} sub={s.t} />
          </div>
          <div className="row"><Src k="fraunhofer" /><Src k="chalmers" /></div>
        </section>

        <section className="card stack-md">
          <h2>{s.perGwh}</h2>
          <p className="small muted">{s.perGwhLead} <Assume /></p>
          <div className="grid grid-2">
            <Stat label={s.gross} value={`${T(Math.round(gw.lo / 500) * 500)} ${s.to} ${T(Math.round(gw.hi / 500) * 500)}`} sub={s.t} />
            <Stat label={s.alloc} value={`${T(Math.round(gw.aLo / 500) * 500)} ${s.to} ${T(Math.round(gw.aHi / 500) * 500)}`} sub={s.t} />
          </div>
          <div className="row"><Src k="fraunhofer" /><Src k="chalmers" /></div>
        </section>
      </div>

      <section className="card stack-md">
        <div>
          <h2>{s.tr}</h2>
          <p className="small muted">{s.trLead}</p>
        </div>
        <div className="grid grid-2">
          <div className="stack-md">
            <div className="field">
              <label htmlFor="gwh">{s.output}: <strong>{T(gwh)} GWh</strong></label>
              <Range id="gwh" min={0} max={25} step={0.5} value={gwh} onChange={setGwh} />
              <div className="chips">
                <button className="chip" aria-pressed={gwh === 3} onClick={() => setGwh(3)}>{s.siroNow}</button>
                <button className="chip" aria-pressed={gwh === 20} onClick={() => setGwh(20)}>{s.siro2031}</button>
              </div>
              <Src k="siro" />
            </div>
            <div className="field">
              <label htmlFor="share">{s.share}: <strong>{share}%</strong> <Assume /></label>
              <Range id="share" min={0} max={100} step={1} value={share} onChange={setShare} />
            </div>
          </div>
          <div className="stack-sm">
            <Stat label={`${s.gross}, ${s.perYear}`} value={`${T(tr.lo)} ${s.to} ${T(tr.hi)}`} sub={s.t} />
            <Stat label={`${s.alloc}, ${s.perYear}`} value={`${T(tr.aLo)} ${s.to} ${T(tr.aHi)}`} sub={`${s.t} · ${pct(ret * 100, lang, 0)} ${s.retained.toLowerCase()}`} />
          </div>
        </div>
      </section>

      <section className="card stack-sm">
        <h2>{s.factors}</h2>
        <ul className="stack-sm" style={{ paddingLeft: 18, margin: 0 }}>
          <li>{s.f1} <Src k="fraunhofer" /></li>
          <li>{s.f2} <Src k="chalmers" /></li>
          <li>{s.f3} <Assume /></li>
          <li>{s.f4} <Src k="siro" /></li>
          <li>{s.f5} <Assume /></li>
        </ul>
        <p className="small muted"><Link to="/" style={{ textDecoration: "underline" }}>{s.seeHandoff}</Link> · {c.footer}</p>
      </section>
    </div>
  );
}
