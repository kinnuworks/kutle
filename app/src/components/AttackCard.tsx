import { useState } from "react";
import { defineStrings, useLang, useStrings } from "../i18n/index.tsx";
import { common } from "../i18n/common.ts";
import { runAttack } from "../lib/attacks.ts";
import { errorMessage, rootCause } from "../lib/errors.ts";
import type { FailedTx } from "../lib/tx.ts";
import { num } from "../lib/format.ts";
import { DecodedErrorView, Pill, TxHash } from "./ui.tsx";

export const ATTACK_TEXT = defineStrings({
  en: {
    overCeiling: ["Recover more than physics allows", "A balanced assay claiming 100% recovery of every element, signed by both the recycler and the accredited lab.", "Recovery is capped per element (99% for cobalt) of what was processed, whoever signs."],
    overClaim: ["Claim more metal than the batteries held", "An assay that reports 1.5 kg more cobalt than the closed passports put into the batch.", "Input is fixed by passports that cannot be reopened, so recovered + loss + unprocessed cannot balance."],
    replayAssay: ["Replay a settled assay", "The exact calldata of the assay that was already settled for batch 1, sent again.", "Each assay carries a nonce equal to the batch's assay count, so it can be used once."],
    unaccreditedLab: ["Assay signed by an unaccredited lab", "A plausible assay co-signed by a lab key the ledger has no accreditation record for.", "Only labs registered through governance with an accreditation reference can co-sign."],
    doubleSpend: ["Spend a note twice", "The proof and nullifiers of the cobalt spend that already backed a new battery, sent again.", "Each note has one nullifier; the pool refuses a nullifier it has seen, before checking the proof."],
    wrongPassport: ["Use a proof for another passport", "A valid proof made for passport A, submitted to back passport B.", "The passport id is a public input of the proof, so the verifier rejects it for any other passport."],
    replayBatch: ["Replay a reading batch", "The latest anchored batch from the demo device, relayed a second time.", "Batches carry a per-device sequence number inside the signed digest."],
    ecdsaOnly: ["Sign readings with the ECDSA key only", "A fresh batch with a valid ECDSA signature and 2,420 random bytes in place of the ML-DSA-44 signature.", "Both signatures are required; a stolen ECDSA key alone signs nothing."],
    revokedKey: ["Sign with a revoked device key", "A correctly signed batch from a device whose key was reported stolen and revoked.", "A revoked key version can never sign again; only a rotation restores the device."],
    degenerateKey: ["Register a degenerate ML-DSA key", "An ML-DSA-44 public key whose t1 part is all zeros, which anyone can forge signatures for.", "The registry counts large t1 coefficients and refuses keys below the floor."],
    foreignGrade: ["Grade a battery with another battery's readings", "A glowing health grade for one passport that cites the demo device's reading batch.", "A grade must cite a batch anchored by the graded passport's own device."],
    badModel: ["Register a model that loses to its baseline", "A model with 4.00% held-out error against a 3.20% baseline, pushed through the council and the timelock.", "The registry refuses any model whose error is not below its baseline."],
  } as Record<string, [string, string, string]>,
  tr: {
    overCeiling: ["Fiziğin izin verdiğinden fazlasını geri kazan", "Her elementin %100 geri kazanıldığını söyleyen dengeli bir analiz, hem geri dönüşümcü hem de akredite laboratuvar imzalı.", "Geri kazanım, işlenen miktarın element başına bir tavanıyla sınırlı (kobalt için %99), kim imzalarsa imzalasın."],
    overClaim: ["Bataryalarda olandan fazla metal talep et", "Kapatılan pasaportların partiye koyduğundan 1,5 kg fazla kobalt bildiren bir analiz.", "Girdi yeniden açılamayan pasaportlarla sabit, bu yüzden geri kazanılan + kayıp + işlenmemiş dengelenemez."],
    replayAssay: ["Kapanmış bir analizi tekrar gönder", "Parti 1 için zaten işlenmiş analizin aynı çağrı verisi, yeniden gönderildi.", "Her analiz partinin analiz sayısına eşit bir nonce taşır, bu yüzden bir kez kullanılabilir."],
    unaccreditedLab: ["Akredite olmayan laboratuvarın imzaladığı analiz", "Defterde akreditasyon kaydı olmayan bir laboratuvar anahtarının ortak imzaladığı makul bir analiz.", "Yalnızca yönetişim yoluyla akreditasyon referansıyla kaydedilen laboratuvarlar ortak imza atabilir."],
    doubleSpend: ["Bir notu iki kez harca", "Yeni bir bataryayı zaten desteklemiş kobalt harcamasının ispatı ve nullifier'ları, yeniden gönderildi.", "Her notun bir nullifier'ı vardır; havuz gördüğü bir nullifier'ı ispatı kontrol etmeden reddeder."],
    wrongPassport: ["Başka bir pasaportun ispatını kullan", "A pasaportu için üretilmiş geçerli bir ispat, B pasaportunu desteklemek için gönderildi.", "Pasaport numarası ispatın açık girdisidir, doğrulayıcı başka her pasaport için reddeder."],
    replayBatch: ["Bir okuma grubunu tekrar gönder", "Demo cihazından son sabitlenen grup, ikinci kez iletildi.", "Gruplar, imzalı özetin içinde cihaz başına bir sıra numarası taşır."],
    ecdsaOnly: ["Okumaları yalnızca ECDSA anahtarıyla imzala", "Geçerli ECDSA imzası olan ve ML-DSA-44 imzası yerine 2.420 rastgele bayt taşıyan yeni bir grup.", "İki imza da gerekir; çalınmış bir ECDSA anahtarı tek başına hiçbir şey imzalayamaz."],
    revokedKey: ["İptal edilmiş cihaz anahtarıyla imzala", "Anahtarı çalındığı bildirilip iptal edilmiş bir cihazdan doğru imzalanmış bir grup.", "İptal edilen anahtar sürümü bir daha imzalayamaz; cihazı yalnızca anahtar yenileme geri getirir."],
    degenerateKey: ["Bozuk bir ML-DSA anahtarı kaydet", "t1 kısmı tamamen sıfır olan, herkesin imza sahteleyebileceği bir ML-DSA-44 açık anahtarı.", "Kayıt büyük t1 katsayılarını sayar ve eşiğin altındaki anahtarları reddeder."],
    foreignGrade: ["Bir bataryayı başka bataryanın okumalarıyla derecelendir", "Bir pasaport için demo cihazının okuma grubuna atıf yapan parlak bir sağlık derecesi.", "Derece, derecelendirilen pasaportun kendi cihazının sabitlediği bir gruba atıf yapmalıdır."],
    badModel: ["Temel modele yenilen bir modeli kaydet", "Ayrılmış veride %4,00 hatası olan, %3,20 temel modele karşı, kurul ve zaman kilidinden geçirilen bir model.", "Kayıt, hatası temel modelin altında olmayan her modeli reddeder."],
  } as Record<string, [string, string, string]>,
});

const UI = defineStrings({
  en: { send: "Send the transaction", sending: "Sending", expected: "Expected", got: "Contract said", why: "Why it fails", refused: "refused as expected", wrong: "different error", unexpected: "The call did not revert. This is a bug.", mined: "Mined and reverted", gas: "gas used", block: "block" },
  tr: { send: "İşlemi gönder", sending: "Gönderiliyor", expected: "Beklenen", got: "Sözleşmenin yanıtı", why: "Neden başarısız olur", refused: "beklendiği gibi reddedildi", wrong: "farklı hata", unexpected: "Çağrı geri alınmadı. Bu bir hatadır.", mined: "Bloğa girdi ve geri alındı", gas: "kullanılan gas", block: "blok" },
});

export function AttackCard({ id, expected, accept = [], disabled, compact }: { id: string; expected: string; accept?: string[]; disabled?: boolean; compact?: boolean }) {
  const t = useStrings(ATTACK_TEXT)[id];
  const u = useStrings(UI);
  const c = useStrings(common);
  const { lang } = useLang();
  const [st, setSt] = useState<{ busy?: boolean; res?: FailedTx; err?: string }>({});
  const go = async () => {
    setSt({ busy: true });
    try {
      setSt({ res: await runAttack(id) });
    } catch (e) {
      setSt({ err: errorMessage(e) });
    }
  };
  const root = st.res?.decoded ? rootCause(st.res.decoded) : null;
  const match = !!root && (root.name === expected || accept.includes(root.name));
  return (
    <article className="card attack" aria-labelledby={`atk-${id}`}>
      <div className="row-between" style={{ alignItems: "flex-start" }}>
        <h3 id={`atk-${id}`}>{t[0]}</h3>
      </div>
      <p className="small muted">{t[1]}</p>
      {!compact && <p className="small">{t[2]}</p>}
      <div className="small">{u.expected}: <code className="mono">{[expected, ...accept].join(" / ")}</code></div>
      <div className="attack__result stack-sm" aria-live="polite">
        <button className="btn btn-ink btn-sm" onClick={go} disabled={disabled || st.busy}>
          {st.busy ? <><span className="spinner" aria-hidden="true" style={{ borderTopColor: "var(--bg)" }} /> {u.sending}</> : u.send}
        </button>
        {st.err && <div className="notice notice--error">{st.err}</div>}
        {st.res?.unexpectedSuccess && <div className="notice notice--error">{u.unexpected}</div>}
        {st.res && !st.res.unexpectedSuccess && (
          <div className="stack-sm" style={{ padding: 12, borderRadius: 12, background: match ? "var(--pass-wash)" : "var(--warn-wash)" }}>
            <div className="row">
              <Pill kind={match ? "pass" : "warn"}>{match ? u.refused : u.wrong}</Pill>
              {st.res.status === "reverted" && <span className="small">{u.mined}</span>}
            </div>
            <div className="small">{u.got}:</div>
            {st.res.decoded ? <DecodedErrorView e={st.res.decoded} /> : <code className="mono small">{c.error}</code>}
            {st.res.hash && (
              <div className="row small">
                <TxHash hash={st.res.hash} />
                <span className="muted">{num(st.res.gasUsed ?? 0n, lang)} {u.gas} · {u.block} {String(st.res.blockNumber)}</span>
              </div>
            )}
          </div>
        )}
      </div>
    </article>
  );
}
