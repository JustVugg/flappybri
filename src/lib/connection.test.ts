import { afterEach, describe, expect, it, vi } from "vitest"

import {
  CONNECTION_KEY, DEFAULT_BASE_URL, loadConnection, normalizeBaseUrl, sameConnection, saveConnection,
  statusText, testConnection,
} from "./connection"
import en from "../i18n/en"

afterEach(() => {
  vi.unstubAllGlobals()
  vi.useRealTimers()
})

const json = (body: unknown, init: ResponseInit = {}) =>
  new Response(JSON.stringify(body), { status: 200, headers: { "Content-Type": "application/json" }, ...init })

/* /v1/models exactly as colibri's gateway writes it: one entry, the served model. */
const models = (id = "qwen36", extra: Record<string, unknown> = {}) => json({
  object: "list",
  data: [{ id, object: "model", created: 1759400000, owned_by: "colibri", input_modalities: ["text"], ...extra }],
})

const memory = (initial: Record<string, string> = {}) => {
  const data = new Map(Object.entries(initial))
  return {
    data,
    getItem: (key: string) => data.get(key) ?? null,
    setItem: (key: string, value: string) => { data.set(key, value) },
  }
}

const throwing = {
  getItem: () => { throw new DOMException("blocked", "SecurityError") },
  setItem: () => { throw new DOMException("blocked", "SecurityError") },
}

describe("the server URL", () => {
  it("is coli serve on this machine when left empty", () => {
    expect(normalizeBaseUrl("")).toBe(DEFAULT_BASE_URL)
    expect(normalizeBaseUrl("   ")).toBe("http://127.0.0.1:8000/v1")
  })

  it("drops trailing slashes and keeps a path as typed", () => {
    expect(normalizeBaseUrl("http://127.0.0.1:8000/v1/")).toBe("http://127.0.0.1:8000/v1")
    expect(normalizeBaseUrl(" https://box.local/colibri/v1// ")).toBe("https://box.local/colibri/v1")
  })

  it("reads a bare host or host:port as colibri's /v1 on it, over http when no scheme is given", () => {
    expect(normalizeBaseUrl("http://127.0.0.1:8000")).toBe("http://127.0.0.1:8000/v1")
    expect(normalizeBaseUrl("http://127.0.0.1:8000/")).toBe("http://127.0.0.1:8000/v1")
    expect(normalizeBaseUrl("localhost:8000")).toBe("http://localhost:8000/v1")
    expect(normalizeBaseUrl("192.168.1.20:8000/v1")).toBe("http://192.168.1.20:8000/v1")
    expect(normalizeBaseUrl("https://gpu.example.org")).toBe("https://gpu.example.org/v1")
  })

  it("keeps a path on the page's own origin, for the dev proxy", () => {
    expect(normalizeBaseUrl("/v1")).toBe("/v1")
    expect(normalizeBaseUrl("/v1/")).toBe("/v1")
    expect(normalizeBaseUrl("/")).toBe("/v1")
  })

  it("compares two connections as the game would use them", () => {
    expect(sameConnection({ baseUrl: "localhost:8000", apiKey: "k " }, { baseUrl: "http://localhost:8000/v1", apiKey: "k" })).toBe(true)
    expect(sameConnection({ baseUrl: "localhost:8000", apiKey: "" }, { baseUrl: "localhost:8001", apiKey: "" })).toBe(false)
    expect(sameConnection({ baseUrl: "/v1", apiKey: "a" }, { baseUrl: "/v1", apiKey: "b" })).toBe(false)
  })
})

describe("remembering the connection", () => {
  it("starts from the default address and no key", () => {
    expect(loadConnection(memory())).toEqual({ baseUrl: DEFAULT_BASE_URL, apiKey: "" })
    expect(loadConnection(undefined)).toEqual({ baseUrl: DEFAULT_BASE_URL, apiKey: "" })
  })

  it("saves the address normalized and the key trimmed, and reads them back", () => {
    const storage = memory()
    const saved = saveConnection(storage, { baseUrl: "localhost:8000/", apiKey: " sk-local " })
    expect(saved).toEqual({ baseUrl: "http://localhost:8000/v1", apiKey: "sk-local" })
    expect(JSON.parse(storage.data.get(CONNECTION_KEY)!)).toEqual(saved)
    expect(loadConnection(storage)).toEqual(saved)
  })

  it("ignores what it cannot read: broken JSON, wrong types, a blank address", () => {
    expect(loadConnection(memory({ [CONNECTION_KEY]: "{not json" }))).toEqual({ baseUrl: DEFAULT_BASE_URL, apiKey: "" })
    expect(loadConnection(memory({ [CONNECTION_KEY]: JSON.stringify({ baseUrl: 8000, apiKey: ["x"] }) })))
      .toEqual({ baseUrl: DEFAULT_BASE_URL, apiKey: "" })
    expect(loadConnection(memory({ [CONNECTION_KEY]: JSON.stringify({ baseUrl: "  ", apiKey: "k" }) })))
      .toEqual({ baseUrl: DEFAULT_BASE_URL, apiKey: "k" })
    expect(loadConnection(memory({ [CONNECTION_KEY]: "null" }))).toEqual({ baseUrl: DEFAULT_BASE_URL, apiKey: "" })
  })

  it("never throws when storage is blocked", () => {
    expect(loadConnection(throwing)).toEqual({ baseUrl: DEFAULT_BASE_URL, apiKey: "" })
    expect(() => saveConnection(throwing, { baseUrl: "/v1", apiKey: "" })).not.toThrow()
    expect(saveConnection(throwing, { baseUrl: "/v1/", apiKey: "" })).toEqual({ baseUrl: "/v1", apiKey: "" })
  })
})

describe("testing the connection", () => {
  it("asks GET /models with the key and names the model the server runs", async () => {
    const fetchMock = vi.fn(async () => models("qwen36"))
    vi.stubGlobal("fetch", fetchMock)
    let t = 100
    const status = await testConnection({ baseUrl: "http://127.0.0.1:8000/v1/", apiKey: " sk-1 " }, { now: () => (t += 12) })
    expect(status).toEqual({ state: "ok", model: "qwen36", models: ["qwen36"], ms: 12 })
    const [url, init] = fetchMock.mock.calls[0] as unknown as [string, RequestInit]
    expect(url).toBe("http://127.0.0.1:8000/v1/models")
    expect((init.headers as Record<string, string>).Authorization).toBe("Bearer sk-1")
  })

  it("sends no Authorization header without a key, and goes through the page's origin for /v1", async () => {
    const fetchMock = vi.fn(async () => models())
    vi.stubGlobal("fetch", fetchMock)
    await testConnection({ baseUrl: "/v1", apiKey: "" })
    const [url, init] = fetchMock.mock.calls[0] as unknown as [string, RequestInit]
    expect(url).toBe("/v1/models")
    expect(init.headers as Record<string, string>).not.toHaveProperty("Authorization")
  })

  it("says the server cannot be reached when the fetch itself fails", async () => {
    vi.stubGlobal("fetch", vi.fn(async () => { throw new TypeError("Failed to fetch") }))
    expect(await testConnection({ baseUrl: "http://127.0.0.1:9/v1", apiKey: "" }))
      .toEqual({ state: "error", kind: "unreachable", message: "Failed to fetch" })
  })

  it("tells a missing or wrong key from a wrong address and from other refusals", async () => {
    const reply = (status: number, message: string) =>
      vi.fn(async () => json({ error: { message, type: "authentication_error" } }, { status }))
    vi.stubGlobal("fetch", reply(401, "Invalid or missing API key."))
    expect(await testConnection({ baseUrl: "/v1", apiKey: "" }))
      .toMatchObject({ state: "error", kind: "auth", status: 401, message: "Invalid or missing API key." })
    vi.stubGlobal("fetch", reply(404, "Not found."))
    expect(await testConnection({ baseUrl: "http://x/api", apiKey: "" }))
      .toMatchObject({ state: "error", kind: "notFound", status: 404 })
    vi.stubGlobal("fetch", reply(403, "Host header 'box' not allowed."))
    expect(await testConnection({ baseUrl: "http://box:8000/v1", apiKey: "" }))
      .toMatchObject({ state: "error", kind: "http", status: 403, message: "Host header 'box' not allowed." })
  })

  it("says so when the address answers with something that is not a model list", async () => {
    vi.stubGlobal("fetch", vi.fn(async () => new Response("<!doctype html><title>hi</title>", { status: 200 })))
    expect(await testConnection({ baseUrl: "http://localhost:5173", apiKey: "" }))
      .toMatchObject({ state: "error", kind: "notJson" })
    vi.stubGlobal("fetch", vi.fn(async () => json({ object: "list", data: [] })))
    expect(await testConnection({ baseUrl: "/v1", apiKey: "" })).toMatchObject({ state: "error", kind: "noModel" })
  })

  it("refuses an image model, which cannot answer /v1/systemone", async () => {
    vi.stubGlobal("fetch", vi.fn(async () => models("qwen-image-2.1-colibri", { capabilities: ["image_generation"] })))
    expect(await testConnection({ baseUrl: "/v1", apiKey: "" }))
      .toMatchObject({ state: "error", kind: "imageModel", model: "qwen-image-2.1-colibri" })
  })

  it("gives up after the timeout instead of waiting forever", async () => {
    vi.useFakeTimers()
    vi.stubGlobal("fetch", vi.fn((_url: string, init: RequestInit) => new Promise<Response>((_, reject) => {
      init.signal?.addEventListener("abort", () => reject(new DOMException("aborted", "AbortError")))
    })))
    const pending = testConnection({ baseUrl: "http://10.255.255.1/v1", apiKey: "" }, { timeoutMs: 3000 })
    await vi.advanceTimersByTimeAsync(3000)
    expect(await pending).toMatchObject({ state: "error", kind: "timeout" })
  })

  it("resolves to null when a newer test cancels it", async () => {
    vi.stubGlobal("fetch", vi.fn((_url: string, init: RequestInit) => new Promise<Response>((_, reject) => {
      init.signal?.addEventListener("abort", () => reject(new DOMException("aborted", "AbortError")))
    })))
    const controller = new AbortController()
    const pending = testConnection({ baseUrl: "/v1", apiKey: "" }, { signal: controller.signal })
    controller.abort()
    expect(await pending).toBeNull()
    const early = new AbortController()
    early.abort()
    expect(await testConnection({ baseUrl: "/v1", apiKey: "" }, { signal: early.signal })).toBeNull()
  })
})

describe("what the panel says", () => {
  it("has a sentence for every status, with its values filled", () => {
    const url = "http://127.0.0.1:8000/v1"
    const kinds = ["unreachable", "timeout", "auth", "notFound", "notJson", "noModel", "imageModel", "http"] as const
    for (const kind of kinds) {
      const { key } = statusText({ state: "error", kind, message: "m" }, url)
      expect(en[key], key).toBeTruthy()
    }
    expect(statusText({ state: "idle" }, url).key).toBe("conn.idle")
    expect(statusText({ state: "testing" }, url).key).toBe("conn.testing")
    expect(statusText({ state: "ok", model: "qwen36", models: ["qwen36"], ms: 14 }, url))
      .toEqual({ key: "conn.ok", vars: { model: "qwen36", ms: 14 } })
    expect(statusText({ state: "error", kind: "http", status: 403, message: "Host header not allowed." }, "localhost:8000"))
      .toMatchObject({ key: "conn.err.http", vars: { url: "http://localhost:8000/v1", status: 403, message: "Host header not allowed." } })
    expect(statusText({ state: "error", kind: "timeout", message: "" }, url, 8000).vars.s).toBe(8)
  })
})
