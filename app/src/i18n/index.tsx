import { createContext, useContext, useEffect, useMemo, useState, type ReactNode } from "react";

export type Lang = "en" | "tr";
export const LANGS: Lang[] = ["en", "tr"];

/**
 * Each page keeps its strings next to its code as { en: {...}, tr: {...} }.
 * `defineStrings` makes the compiler check that both languages have the same keys.
 */
export function defineStrings<T extends Record<string, unknown>>(s: { en: T; tr: { [K in keyof T]: T[K] } }) {
  return s;
}

interface LangState {
  lang: Lang;
  setLang: (l: Lang) => void;
}

const Ctx = createContext<LangState>({ lang: "en", setLang: () => {} });

function initialLang(): Lang {
  try {
    const saved = localStorage.getItem("kutle.lang");
    if (saved === "en" || saved === "tr") return saved;
  } catch {
    /* storage blocked */
  }
  return typeof navigator !== "undefined" && navigator.language?.toLowerCase().startsWith("tr") ? "tr" : "en";
}

export function LangProvider({ children }: { children: ReactNode }) {
  const [lang, setLangState] = useState<Lang>(initialLang);
  useEffect(() => {
    document.documentElement.lang = lang;
  }, [lang]);
  const value = useMemo(
    () => ({
      lang,
      setLang: (l: Lang) => {
        setLangState(l);
        try {
          localStorage.setItem("kutle.lang", l);
        } catch {
          /* storage blocked */
        }
      },
    }),
    [lang],
  );
  return <Ctx.Provider value={value}>{children}</Ctx.Provider>;
}

export const useLang = () => useContext(Ctx);

/** Pick the strings for the current language. */
export function useStrings<T>(s: { en: T; tr: T }): T {
  const { lang } = useLang();
  return s[lang];
}
