import { useState } from "react";
import { defineStrings, useStrings } from "../i18n/index.tsx";
import { ATTACKS } from "../lib/attacks.ts";
import { AttackCard } from "../components/AttackCard.tsx";
import { DemoKeysTag } from "../components/ui.tsx";
import { useAsync } from "../lib/hooks.ts";
import { getDemo } from "../lib/data.ts";
import { demoKey } from "../config/index.ts";

const GROUPS: Record<string, string[]> = {
  ledger: ["overCeiling", "overClaim", "replayAssay", "unaccreditedLab"],
  notes: ["doubleSpend", "wrongPassport"],
  readings: ["replayBatch", "ecdsaOnly", "revokedKey", "foreignGrade"],
  governance: ["degenerateKey", "badModel"],
};

const S = defineStrings({
  en: {
    eyebrow: "Attack console",
    title: "Try to cheat. Every attempt is a real transaction.",
    lead: "Each card builds an attack, simulates it to read the revert reason, then sends it anyway with a fixed gas limit so it is mined as a failed transaction. Errors are decoded with the contracts' own ABIs.",
    filter: "Show",
    all: "All",
    groups: { ledger: "Recycling ledger", notes: "Recycled-metal notes", readings: "Readings and grades", governance: "Keys and models" } as Record<string, string>,
    noDemo: "The attack console needs the seeded demo state and demo keys (scripts/dev-chain.mjs).",
  },
  tr: {
    eyebrow: "Saldırı konsolu",
    title: "Hile yapmayı deneyin. Her deneme gerçek bir işlemdir.",
    lead: "Her kart bir saldırı kurar, geri alma nedenini okumak için onu simüle eder, sonra sabit bir gas sınırıyla yine de gönderir; işlem başarısız olarak bloğa girer. Hatalar sözleşmelerin kendi ABI'leriyle çözülür.",
    filter: "Göster",
    all: "Tümü",
    groups: { ledger: "Geri dönüşüm defteri", notes: "Geri dönüştürülmüş metal notları", readings: "Okumalar ve dereceler", governance: "Anahtarlar ve modeller" } as Record<string, string>,
    noDemo: "Saldırı konsolu tohumlanmış demo durumuna ve demo anahtarlarına ihtiyaç duyar (scripts/dev-chain.mjs).",
  },
});

export default function Attacks() {
  const s = useStrings(S);
  const [group, setGroup] = useState<string>("all");
  const demo = useAsync(getDemo, []);
  const ready = Boolean(demo.data) && Boolean(demoKey("relayer"));
  const shown = ATTACKS.filter((a) => group === "all" || GROUPS[group].includes(a.id));
  return (
    <div className="stack-lg console">
      <header className="page-head">
        <span className="eyebrow"><span className="dot" />{s.eyebrow}</span>
        <h1>{s.title}</h1>
        <p className="lead">{s.lead}</p>
        <div style={{ marginTop: 14 }}><DemoKeysTag /></div>
      </header>
      {!demo.loading && !ready && <div className="notice notice--warn">{s.noDemo}</div>}
      <div className="chips" role="group" aria-label={s.filter}>
        <button className="chip" aria-pressed={group === "all"} onClick={() => setGroup("all")}>{s.all}</button>
        {Object.keys(GROUPS).map((g) => (
          <button key={g} className="chip" aria-pressed={group === g} onClick={() => setGroup(g)}>{s.groups[g]}</button>
        ))}
      </div>
      <div className="grid-auto">
        {shown.map((a) => <AttackCard key={a.id} id={a.id} expected={a.expected} accept={a.accept} disabled={!ready} />)}
      </div>
    </div>
  );
}
