import { useCallback, useEffect, useRef, useState } from "react"
import { Globe, Moon, Sun } from "lucide-react"

import { ConnectionPanel } from "./ConnectionPanel"
import FlappyBri from "./FlappyBri"
import { Brand } from "./components/Brand"
import { useLocale } from "./i18n"
import {
  loadConnection, saveConnection, testConnection, type Connection, type ConnectionStatus,
} from "./lib/connection"

const storage = () => {
  try { return window.localStorage } catch { return undefined }
}

type Theme = "light" | "dark"
const THEME_KEY = "flappybri.theme"

/* The theme index.html picked before the first paint, the system's until the
   viewer chooses one, and the viewer's choice after that. */
function useTheme() {
  const saved = (() => {
    try { const value = storage()?.getItem(THEME_KEY); return value === "light" || value === "dark" ? value : null } catch { return null }
  })()
  const [theme, setTheme] = useState<Theme>(() =>
    saved ?? (document.documentElement.getAttribute("data-theme") === "light" ? "light" : "dark"))
  const chosen = useRef(saved !== null)

  useEffect(() => { document.documentElement.setAttribute("data-theme", theme) }, [theme])
  useEffect(() => {
    const media = window.matchMedia?.("(prefers-color-scheme: light)")
    const follow = () => { if (!chosen.current && media) setTheme(media.matches ? "light" : "dark") }
    media?.addEventListener?.("change", follow)
    return () => media?.removeEventListener?.("change", follow)
  }, [])

  const toggle = () => {
    const next: Theme = theme === "dark" ? "light" : "dark"
    chosen.current = true
    try { storage()?.setItem(THEME_KEY, next) } catch { /* blocked storage */ }
    setTheme(next)
  }
  return { theme, toggle }
}

export default function App() {
  const { t, locale, setLocale, locales } = useLocale()
  const { theme, toggle } = useTheme()
  const [connection, setConnection] = useState<Connection>(() => loadConnection(storage()))
  const [status, setStatus] = useState<ConnectionStatus>({ state: "idle" })
  const pending = useRef<AbortController | null>(null)

  /* Apply, remember and test: one action, so what the game calls is always
     what the panel last tested. */
  const test = useCallback(async (next: Connection) => {
    const saved = saveConnection(storage(), next)
    setConnection(saved)
    pending.current?.abort()
    const controller = new AbortController()
    pending.current = controller
    setStatus({ state: "testing" })
    const result = await testConnection(saved, { signal: controller.signal })
    if (!result || pending.current !== controller) return
    pending.current = null
    setStatus(result)
  }, [])

  /* The remembered server is tested once on opening, so the panel says at
     once whether the model can play. */
  const opened = useRef(false)
  useEffect(() => {
    if (opened.current) return
    opened.current = true
    void test(connection)
  }, [connection, test])

  const ok = status.state === "ok" ? status : null

  return (
    <div className="app">
      <header className="app-head">
        <div className="app-brand">
          <Brand className="app-mark" />
          <h1>FlappyBri</h1>
        </div>
        <div className="app-tools">
          <label className="app-lang" title={t("app.language")}>
            <Globe aria-hidden="true" />
            <span className="sr-only">{t("app.language")}</span>
            <select value={locale} onChange={(event) => setLocale(event.target.value)}>
              {locales.map((item) => <option key={item.code} value={item.code}>{item.label}</option>)}
            </select>
          </label>
          <button type="button" className="app-icon" onClick={toggle}
                  aria-label={t(theme === "dark" ? "app.toLight" : "app.toDark")}
                  title={t(theme === "dark" ? "app.toLight" : "app.toDark")}>
            {theme === "dark" ? <Sun /> : <Moon />}
          </button>
        </div>
      </header>
      <p className="app-intro">{t("flappy.intro")}</p>

      <main>
        <FlappyBri baseUrl={connection.baseUrl} apiKey={connection.apiKey} model={ok?.model ?? ""} connected={!!ok}
                   connection={<ConnectionPanel applied={connection} status={status} onTest={(next) => void test(next)} />} />
      </main>

      <footer className="app-foot">
        <span>{t("app.footer")}</span>
        <a href="https://github.com/JustVugg/colibri" target="_blank" rel="noreferrer">{t("app.colibri")}</a>
        <span>Apache-2.0</span>
      </footer>
    </div>
  )
}
