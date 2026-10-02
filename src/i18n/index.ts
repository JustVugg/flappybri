import { createContext, createElement, useCallback, useContext, useEffect, useMemo, useState, type ReactNode } from "react"

import de from "./de"
import en from "./en"
import id from "./id"
import it from "./it"
import zhCN from "./zh-CN"
import zhTW from "./zh-TW"

export const LOCALES = [
  { code: "en", label: "English" },
  { code: "it", label: "Italiano" },
  { code: "de", label: "Deutsch" },
  { code: "id", label: "Bahasa Indonesia" },
  { code: "zh-CN", label: "简体中文" },
  { code: "zh-TW", label: "繁體中文" },
] as const

export const DICTS: Record<string, Record<string, string>> = {
  "en": en,
  "it": it,
  "de": de,
  "id": id,
  "zh-CN": zhCN,
  "zh-TW": zhTW,
}

const STORAGE_KEY = "flappybri.locale"

/* The saved choice, else the browser's language, else English. */
export function detectLocale(saved: string | null, language: string): string {
  if (saved && DICTS[saved]) return saved
  if (DICTS[language]) return language
  const prefix = language.split("-")[0]
  if (prefix === "zh") return language.includes("TW") || language.includes("HK") || language.includes("Hant") ? "zh-TW" : "zh-CN"
  for (const { code } of LOCALES) if (code.split("-")[0] === prefix) return code
  return "en"
}

function initialLocale(): string {
  let saved: string | null = null
  try { saved = localStorage.getItem(STORAGE_KEY) } catch { /* blocked storage */ }
  return detectLocale(saved, typeof navigator === "undefined" ? "" : navigator.language || "")
}

export function interpolate(template: string, vars?: Record<string, string | number>): string {
  if (!vars) return template
  return template.replace(/\{\{(\w+)\}\}/g, (_, key) => String(vars[key] ?? `{{${key}}}`))
}

export type Translate = (key: string, vars?: Record<string, string | number>) => string

interface LocaleContext {
  locale: string
  setLocale: (code: string) => void
  t: Translate
  locales: typeof LOCALES
}

const Ctx = createContext<LocaleContext>({
  locale: "en",
  setLocale: () => {},
  t: (key) => key,
  locales: LOCALES,
})

export function LocaleProvider({ children }: { children: ReactNode }) {
  const [locale, setLocaleState] = useState(initialLocale)

  const setLocale = useCallback((code: string) => {
    if (!DICTS[code]) return
    setLocaleState(code)
    try { localStorage.setItem(STORAGE_KEY, code) } catch { /* blocked storage */ }
  }, [])

  useEffect(() => { document.documentElement.lang = locale }, [locale])

  const t = useCallback<Translate>((key, vars) => {
    const dict = DICTS[locale] || en
    return interpolate(dict[key] ?? en[key] ?? key, vars)
  }, [locale])

  const value = useMemo(() => ({ locale, setLocale, t, locales: LOCALES }), [locale, setLocale, t])
  return createElement(Ctx.Provider, { value }, children)
}

export function useLocale() {
  return useContext(Ctx)
}
