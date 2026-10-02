import { afterEach, describe, expect, it, vi } from "vitest"

import { HttpError, askSystemOne, endpoint, generatesImages, listModelInfo, type SystemOneRequest } from "./api"

afterEach(() => vi.unstubAllGlobals())

describe("model capabilities", () => {
  it("reads capabilities from /v1/models and recognises an image model", async () => {
    vi.stubGlobal("fetch", vi.fn().mockResolvedValue(new Response(JSON.stringify({ data: [
      { id: "qwen-image-2.1-colibri", object: "model", capabilities: ["image_generation", 7] },
      { id: "glm-5.2-colibri", object: "model" },
    ] }))))
    const models = await listModelInfo("http://x/v1", "")
    expect(models).toEqual([
      { id: "qwen-image-2.1-colibri", capabilities: ["image_generation"] },
      { id: "glm-5.2-colibri" },
    ])
    expect(models.map(generatesImages)).toEqual([true, false])
  })

  it("keeps the status of a refusal", async () => {
    vi.stubGlobal("fetch", vi.fn().mockResolvedValue(new Response(
      JSON.stringify({ error: { message: "Invalid or missing API key." } }), { status: 401 })))
    const error = await listModelInfo("http://x/v1", "bad").catch((cause) => cause)
    expect(error).toBeInstanceOf(HttpError)
    expect(error).toMatchObject({ status: 401, message: "Invalid or missing API key." })
  })
})

describe("POST /v1/systemone", () => {
  const request: SystemOneRequest = {
    model: "qwen36", state: "the state",
    questions: { flap: { type: "noul", instructions: "Should the hummingbird flap its wings now?" } },
  }

  it("posts the request as JSON with the key and reads the engine's timing headers", async () => {
    const fetchMock = vi.fn(async () => new Response(
      JSON.stringify({ model: "qwen36", answers: { flap: { type: "noul", noul: 0.71 } }, usage: { input_tokens: 190, output_tokens: 2 } }),
      { status: 200, headers: { "x-colibri-elapsed-ms": "37", "x-colibri-queue-wait-ms": "0" } }))
    vi.stubGlobal("fetch", fetchMock)
    const reply = await askSystemOne("http://127.0.0.1:8000/v1/", "sk-1", request)
    const [url, init] = fetchMock.mock.calls[0] as unknown as [string, RequestInit]
    expect(url).toBe("http://127.0.0.1:8000/v1/systemone")
    expect(init.method).toBe("POST")
    expect(init.headers).toEqual({ "Content-Type": "application/json", Authorization: "Bearer sk-1" })
    expect(JSON.parse(String(init.body))).toEqual(request)
    expect(reply).toEqual({
      response: { model: "qwen36", answers: { flap: { type: "noul", noul: 0.71 } }, usage: { input_tokens: 190, output_tokens: 2 } },
      engineMs: 37, queueMs: 0,
    })
  })

  it("leaves the timings null when the browser cannot see the headers", async () => {
    vi.stubGlobal("fetch", vi.fn(async () => new Response(JSON.stringify({ model: "m", answers: {} }))))
    expect(await askSystemOne("/v1", "", request)).toMatchObject({ engineMs: null, queueMs: null })
  })

  it("throws an HttpError with the server's own message and status", async () => {
    vi.stubGlobal("fetch", vi.fn(async () => new Response(
      JSON.stringify({ error: { message: "`state` is required: the content the questions are about.", param: "state" } }),
      { status: 422 })))
    const error = await askSystemOne("/v1", "", request).catch((cause) => cause)
    expect(error).toBeInstanceOf(HttpError)
    expect(error).toMatchObject({ status: 422, message: "`state` is required: the content the questions are about." })
    vi.stubGlobal("fetch", vi.fn(async () => new Response("gateway down", { status: 502, statusText: "Bad Gateway" })))
    expect(await askSystemOne("/v1", "", request).catch((cause) => cause)).toMatchObject({ status: 502, message: "502 Bad Gateway" })
  })

  it("joins the base URL and the route with exactly one slash", () => {
    expect(endpoint("http://h/v1", "systemone")).toBe("http://h/v1/systemone")
    expect(endpoint("http://h/v1//", "/models")).toBe("http://h/v1/models")
    expect(endpoint("/v1", "models")).toBe("/v1/models")
  })
})
