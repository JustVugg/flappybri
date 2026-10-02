/* The two routes FlappyBri talks to, on a colibri server (`coli serve`):
 *
 *   GET  /v1/models     which model the server runs (the connection test)
 *   POST /v1/systemone  one decision: a state, typed questions, probabilities
 *
 * `baseUrl` is the server's OpenAI-style prefix, http://127.0.0.1:8000/v1 by
 * default, or /v1 when the dev server forwards it (see vite.config.ts). */

export function endpoint(baseUrl: string, path: string) {
  return `${baseUrl.replace(/\/+$/, "")}/${path.replace(/^\/+/, "")}`
}

function headers(apiKey: string) {
  return {
    "Content-Type": "application/json",
    ...(apiKey ? { Authorization: `Bearer ${apiKey}` } : {}),
  }
}

interface OpenAIError {
  error?: { message?: string; param?: string | null }
}

async function responseError(response: Response) {
  const fallback = `${response.status} ${response.statusText}`.trim()
  try {
    const body = (await response.json()) as OpenAIError
    return body.error?.message || fallback
  } catch {
    return fallback
  }
}

/* An HTTP answer that is not a 2xx, with its status kept: a caller tells
   "the route does not exist" (404) from "the request was refused" by it. */
export class HttpError extends Error {
  readonly status: number
  constructor(message: string, status: number) {
    super(message)
    this.name = "HttpError"
    this.status = status
  }
}

export interface ModelInfo {
  id: string
  /* What a model does beyond chat. colibri marks an image model with
     "image_generation": it answers /v1/images/generations and refuses chat. */
  capabilities?: string[]
}

export async function listModelInfo(baseUrl: string, apiKey: string, signal?: AbortSignal): Promise<ModelInfo[]> {
  const response = await fetch(endpoint(baseUrl, "models"), { headers: headers(apiKey), signal })
  if (!response.ok) throw new HttpError(await responseError(response), response.status)
  const body = (await response.json()) as { data?: Array<{ id: string; capabilities?: unknown }> }
  return (Array.isArray(body?.data) ? body.data : [])
    .filter((item) => item && typeof item.id === "string" && item.id)
    .map(({ id, capabilities }) => Array.isArray(capabilities)
      ? { id, capabilities: capabilities.filter((item): item is string => typeof item === "string") }
      : { id })
}

export function generatesImages(model: ModelInfo | undefined) {
  return !!model?.capabilities?.includes("image_generation")
}

/* ---- decisions: POST /v1/systemone -------------------------------------------
 * The Jev-compatible decision route (colibri's docs/brio.md). `state` is what
 * the questions are about; every question is typed: `noul` answers with the
 * probability of yes, `choice` with a probability per label, `score` with the
 * expected level. The route accepts any `model` name and replies with the one
 * the server runs. Fields this client does not read (an `id`, a `provider`, a
 * `usage.cost`) may appear in the reply and are left alone. */
export type SystemOneQuestion =
  | { type: "noul"; instructions?: string; criteria?: { true?: string; false?: string } }
  | { type: "choice"; instructions?: string; criteria: Record<string, string> }
  | { type: "score"; instructions?: string; criteria: string[] }

export interface SystemOneRequest {
  model: string
  state: string
  questions: Record<string, SystemOneQuestion>
}

export type SystemOneAnswer =
  | { type: "noul"; noul: number }
  | { type: "choice"; choice: string; probabilities: Record<string, number>; confidence: number }
  | { type: "score"; score: number; legend: Record<string, string>; probabilities: Record<string, number>; confidence: number }

export interface SystemOneResponse {
  model: string
  answers: Record<string, SystemOneAnswer>
  usage?: { input_tokens: number; output_tokens: number }
}

export interface SystemOneReply {
  response: SystemOneResponse
  /* The engine's own time and the scheduler queue, from the gateway's
     x-colibri-elapsed-ms and x-colibri-queue-wait-ms headers. A browser only
     sees a header cross-origin when the server exposes it, so either can be
     null even on a server that sends it. */
  engineMs: number | null
  queueMs: number | null
}

const headerNumber = (response: Response, name: string) => {
  const raw = response.headers.get(name)
  const value = raw === null ? NaN : Number(raw)
  return Number.isFinite(value) ? value : null
}

export async function askSystemOne(
  baseUrl: string,
  apiKey: string,
  request: SystemOneRequest,
  signal?: AbortSignal,
): Promise<SystemOneReply> {
  const response = await fetch(endpoint(baseUrl, "systemone"), {
    method: "POST",
    headers: headers(apiKey),
    body: JSON.stringify(request),
    signal,
  })
  if (!response.ok) throw new HttpError(await responseError(response), response.status)
  return {
    response: (await response.json()) as SystemOneResponse,
    engineMs: headerNumber(response, "x-colibri-elapsed-ms"),
    queueMs: headerNumber(response, "x-colibri-queue-wait-ms"),
  }
}
