/* The connection panel: where the colibri server is, the optional API key,
 * and the one test that says whether the game can play against it.
 *
 * The test is GET /models, the same route the game asks before it flies: it
 * proves the address, the key and the browser's cross-origin rules at once,
 * and names the model the server runs. Everything here is plain functions, so
 * the panel's logic is tested without a browser. */

import { HttpError, generatesImages, listModelInfo } from "./api"

export const DEFAULT_BASE_URL = "http://127.0.0.1:8000/v1"
export const CONNECTION_KEY = "flappybri.connection"
export const TEST_TIMEOUT_MS = 8000

export interface Connection {
  baseUrl: string
  apiKey: string
}

export const DEFAULT_CONNECTION: Connection = { baseUrl: DEFAULT_BASE_URL, apiKey: "" }

/* What a person types, made into the address the game calls:
 * - empty is the default, coli serve on this machine;
 * - no scheme means http, as for a local server;
 * - a bare host or host:port means colibri's /v1 on it;
 * - a path that starts with / is the page's own origin (the dev proxy);
 * - trailing slashes go, anything else is kept as typed. */
export function normalizeBaseUrl(input: string): string {
  let url = input.trim()
  if (!url) return DEFAULT_BASE_URL
  if (url.startsWith("/")) {
    url = url.replace(/\/+$/, "")
    return url || "/v1"
  }
  if (!/^[a-z][a-z0-9+.-]*:\/\//i.test(url)) url = `http://${url}`
  url = url.replace(/\/+$/, "")
  try {
    const parsed = new URL(url)
    if (parsed.pathname === "/" && !parsed.search && !parsed.hash) url = `${url}/v1`
  } catch { /* kept as typed: the test will say it cannot be reached */ }
  return url
}

export function sameConnection(a: Connection, b: Connection) {
  return normalizeBaseUrl(a.baseUrl) === normalizeBaseUrl(b.baseUrl) && a.apiKey.trim() === b.apiKey.trim()
}

/* Remembered per browser. Storage can be missing, full, or throw on every
   call (a private window, blocked site data): then the defaults, and no error. */
export function loadConnection(storage: Pick<Storage, "getItem"> | undefined): Connection {
  try {
    const raw = JSON.parse(storage?.getItem(CONNECTION_KEY) || "{}") as Partial<Record<keyof Connection, unknown>>
    return {
      baseUrl: typeof raw.baseUrl === "string" && raw.baseUrl.trim() ? normalizeBaseUrl(raw.baseUrl) : DEFAULT_BASE_URL,
      apiKey: typeof raw.apiKey === "string" ? raw.apiKey.trim() : "",
    }
  } catch {
    return { ...DEFAULT_CONNECTION }
  }
}

export function saveConnection(storage: Pick<Storage, "setItem"> | undefined, connection: Connection) {
  const value: Connection = { baseUrl: normalizeBaseUrl(connection.baseUrl), apiKey: connection.apiKey.trim() }
  try { storage?.setItem(CONNECTION_KEY, JSON.stringify(value)) } catch { /* private mode, blocked storage */ }
  return value
}

/* ---- the test ------------------------------------------------------------------ */

export type ConnectionFailure =
  | "unreachable" | "timeout" | "auth" | "notFound" | "notJson" | "noModel" | "imageModel" | "http"

export type ConnectionStatus =
  | { state: "idle" }
  | { state: "testing" }
  | { state: "ok"; model: string; models: string[]; ms: number }
  | { state: "error"; kind: ConnectionFailure; message: string; status?: number; model?: string }

export interface TestOptions {
  signal?: AbortSignal
  timeoutMs?: number
  now?: () => number
}

/* GET /models with the key. Resolves to what the panel shows; null when the
   caller aborted it (a newer test replaced this one). A fetch that fails
   without an answer is "unreachable": the browser does not say whether the
   server is down or its cross-origin rules refused this page, and neither can
   the panel. */
export async function testConnection(connection: Connection, options: TestOptions = {}): Promise<ConnectionStatus | null> {
  const { signal, timeoutMs = TEST_TIMEOUT_MS, now = () => performance.now() } = options
  if (signal?.aborted) return null
  const controller = new AbortController()
  let timedOut = false
  const timer = setTimeout(() => { timedOut = true; controller.abort() }, timeoutMs)
  const forward = () => controller.abort()
  signal?.addEventListener("abort", forward)
  const started = now()
  try {
    const models = await listModelInfo(normalizeBaseUrl(connection.baseUrl), connection.apiKey.trim(), controller.signal)
    const ms = Math.round(now() - started)
    if (!models.length) return { state: "error", kind: "noModel", message: "The server lists no model." }
    const first = models[0]
    if (generatesImages(first)) {
      return { state: "error", kind: "imageModel", model: first.id, message: `${first.id} generates images.` }
    }
    return { state: "ok", model: first.id, models: models.map((model) => model.id), ms }
  } catch (cause) {
    if (signal?.aborted && !timedOut) return null
    if (timedOut) return { state: "error", kind: "timeout", message: `No answer within ${timeoutMs} ms.` }
    return { state: "error", ...failure(cause) }
  } finally {
    clearTimeout(timer)
    signal?.removeEventListener("abort", forward)
  }
}

function failure(cause: unknown): { kind: ConnectionFailure; message: string; status?: number } {
  const message = cause instanceof Error ? cause.message : String(cause)
  if (cause instanceof HttpError) {
    if (cause.status === 401) return { kind: "auth", status: 401, message }
    if (cause.status === 404) return { kind: "notFound", status: 404, message }
    return { kind: "http", status: cause.status, message }
  }
  if (cause instanceof SyntaxError) return { kind: "notJson", message }
  return { kind: "unreachable", message }
}

/* The sentence the panel shows for a status: an i18n key and its values. */
export function statusText(status: ConnectionStatus, baseUrl: string, timeoutMs = TEST_TIMEOUT_MS):
  { key: string; vars: Record<string, string | number> } {
  const url = normalizeBaseUrl(baseUrl)
  switch (status.state) {
    case "idle": return { key: "conn.idle", vars: {} }
    case "testing": return { key: "conn.testing", vars: {} }
    case "ok": return { key: "conn.ok", vars: { model: status.model, ms: status.ms } }
    case "error": return {
      key: `conn.err.${status.kind}`,
      vars: { url, model: status.model ?? "", status: status.status ?? "", message: status.message, s: Math.round(timeoutMs / 1000) },
    }
  }
}
