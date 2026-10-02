import { useEffect, useId, useState, type FormEvent } from "react"
import { ChevronDown, LoaderCircle, PlugZap } from "lucide-react"

import { useLocale } from "./i18n"
import { DEFAULT_BASE_URL, sameConnection, statusText, type Connection, type ConnectionStatus } from "./lib/connection"

/* Where the colibri server is, and whether it answers. The fields are a draft:
 * the game keeps playing against the connection it has until "Test
 * connection" (or Enter) applies the new one, so typing an address never
 * interrupts a round. After a test that works the panel folds to one line. */
export function ConnectionPanel({ applied, status, onTest }: {
  applied: Connection
  status: ConnectionStatus
  onTest: (connection: Connection) => void
}) {
  const { t } = useLocale()
  const [draft, setDraft] = useState<Connection>(applied)
  const [open, setOpen] = useState(true)
  const fields = useId()

  /* The applied values are the normalized ones: show what will be called. */
  useEffect(() => { setDraft(applied) }, [applied])
  useEffect(() => {
    if (status.state === "ok") setOpen(false)
    else if (status.state === "error") setOpen(true)
  }, [status])

  const testing = status.state === "testing"
  const edited = !sameConnection(draft, applied)
  const line = edited && !testing ? { key: "conn.edited", vars: {} } : statusText(status, applied.baseUrl)

  const submit = (event: FormEvent) => {
    event.preventDefault()
    if (!testing) onTest(draft)
  }

  return (
    <form className="fb-card conn" data-state={edited && !testing ? "edited" : status.state} onSubmit={submit} noValidate>
      <div className="conn-head">
        <span className="conn-dot" aria-hidden="true" />
        <span className="fb-label">{t("conn.title")}</span>
        <button type="button" className="conn-fold" aria-expanded={open} aria-controls={fields}
                aria-label={t(open ? "conn.hide" : "conn.show")} title={t(open ? "conn.hide" : "conn.show")}
                onClick={() => setOpen(!open)}>
          {!open ? <code>{applied.baseUrl}</code> : null}
          <ChevronDown />
        </button>
      </div>
      <p className="conn-status" role="status" aria-live="polite">{t(line.key, line.vars)}</p>
      <div className="conn-fields" id={fields} hidden={!open}>
        <label className="conn-field">
          <span className="fb-label">{t("conn.url")}</span>
          <input type="text" inputMode="url" autoComplete="off" autoCapitalize="off" spellCheck={false}
                 placeholder={DEFAULT_BASE_URL} value={draft.baseUrl}
                 onChange={(event) => setDraft({ ...draft, baseUrl: event.target.value })} />
        </label>
        <div className="conn-row">
          <label className="conn-field">
            <span className="fb-label">{t("conn.key")}</span>
            <input type="password" autoComplete="off" spellCheck={false} placeholder={t("conn.keyPlaceholder")}
                   value={draft.apiKey} onChange={(event) => setDraft({ ...draft, apiKey: event.target.value })} />
          </label>
          <button type="submit" className="fb-primary conn-test" disabled={testing}>
            {testing ? <LoaderCircle className="fb-spin" /> : <PlugZap />}
            {t(testing ? "conn.testing" : "conn.test")}
          </button>
        </div>
        <p className="fb-help">{t("conn.help")}</p>
      </div>
    </form>
  )
}
