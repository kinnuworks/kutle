import { useEffect, useState, type ReactNode } from "react";
import { NavLink, useLocation } from "react-router-dom";
import { useLang, useStrings } from "../i18n/index.tsx";
import { common } from "../i18n/common.ts";
import { publicClient } from "../lib/chain.ts";
import { CHAIN_ID, deployment } from "../config/index.ts";
import { Icon } from "./ui.tsx";
import { AppIcon } from "./AppIcon.tsx";

const LINKS = [
  ["/", "story"],
  ["/verify", "verify"],
  ["/recycler", "recycler"],
  ["/maker", "maker"],
  ["/attacks", "attacks"],
  ["/impact", "impact"],
  ["/device", "device"],
] as const;

function ChainStatus() {
  const s = useStrings(common);
  const [state, setState] = useState<{ ok?: boolean; block?: bigint }>({});
  useEffect(() => {
    let live = true;
    const tick = () =>
      publicClient.getBlockNumber().then(
        (block) => live && setState({ ok: true, block }),
        () => live && setState({ ok: false }),
      );
    tick();
    const id = setInterval(tick, 5000);
    return () => {
      live = false;
      clearInterval(id);
    };
  }, []);
  return (
    <span className="chain-dot" data-ok={state.ok === undefined ? undefined : String(state.ok)} title={`chain ${CHAIN_ID}`}>
      <span>{state.ok === false ? s.chainDown : state.block !== undefined ? `${s.chainOk} ${CHAIN_ID} · #${state.block}` : `${s.chainOk} ${CHAIN_ID}`}</span>
    </span>
  );
}

export function Layout({ children }: { children: ReactNode }) {
  const s = useStrings(common);
  const { lang, setLang } = useLang();
  const [open, setOpen] = useState(false);
  const loc = useLocation();
  const home = loc.pathname === "/";
  useEffect(() => {
    setOpen(false);
    window.scrollTo(0, 0);
    document.getElementById("main")?.focus({ preventScroll: true });
  }, [loc.pathname]);
  return (
    <>
      <a className="skip" href="#main" onClick={(e) => { e.preventDefault(); document.getElementById("main")?.focus(); }}>{s.skip}</a>
      <header className="nav">
        <nav className="nav__bar" aria-label="Main">
          <NavLink to="/" className="nav__brand" end>
            <AppIcon />
            Kütle
          </NavLink>
          <div className="nav__links">
            {LINKS.map(([to, key]) => (
              <NavLink key={to} to={to} end={to === "/"}>
                {s.nav[key]}
              </NavLink>
            ))}
          </div>
          <div className="nav__right">
            <ChainStatus />
            <div className="segmented lang" role="group" aria-label={s.language}>
              <button aria-pressed={lang === "en"} onClick={() => setLang("en")} lang="en">EN</button>
              <button aria-pressed={lang === "tr"} onClick={() => setLang("tr")} lang="tr">TR</button>
            </div>
            <button className="btn btn-sm btn-ghost nav__menu" aria-expanded={open} aria-controls="drawer" onClick={() => setOpen((o) => !o)} aria-label={s.menu}>
              <span style={{ width: 18, height: 18 }}>{Icon.menu}</span>
            </button>
          </div>
        </nav>
      </header>
      {open && (
        <nav id="drawer" className="drawer" aria-label={s.menu}>
          {LINKS.map(([to, key]) => (
            <NavLink key={to} to={to} end={to === "/"}>
              {s.nav[key]}
            </NavLink>
          ))}
        </nav>
      )}
      <main id="main" tabIndex={-1} className={home ? "" : "shell-main container"} style={{ outline: "none" }}>
        {!deployment ? <div className="notice notice--error container" style={{ marginTop: 96 }}>{s.noDeployment}</div> : children}
        <footer className={home ? "footer" : "foot"}>
          <div className={home ? "container" : undefined} style={home ? undefined : { display: "contents" }}>
            <span className="row"><AppIcon size={20} /> {s.footer}</span>
            <span className="mono">chain {CHAIN_ID}</span>
          </div>
        </footer>
      </main>
    </>
  );
}
