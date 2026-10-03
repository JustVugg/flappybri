/* FlappyBri: the model at the controls.
 *
 * Every step the game can be described in a few sentences: where the
 * hummingbird is against the next opening, how it moves, what is close. The
 * pilot sends that description to POST /v1/systemone with one typed question,
 * reads the probability of the answer that means flap (by default "below", to
 * "Where is the hummingbird compared with the opening?"), and flaps when it is
 * above the threshold.
 *
 * REAL TIME, HONESTLY. One request at a time, and the game does not wait for
 * it: while the model reads, the pipes keep coming. The answer is about the
 * screen the model saw, and it is applied to the screen as it is when the
 * answer arrives, the way a slow reflex would be. How many steps late that is
 * gets measured and shown, not hidden. */

import {
  HttpError, askSystemOne, generatesImages, listModelInfo,
  type SystemOneQuestion, type SystemOneRequest, type SystemOneResponse,
} from "../api"
import { BIRD, PHYSICS, PIPES, WORLD, nextPipe, type World } from "./game"
import { LatencyWindow } from "./stats"

/* ---- what the model reads ---------------------------------------------------- */

/* Positions are relative to the hummingbird, with UP positive: a gap middle at
   +38 is 38 px above it. Speeds the same way: -4 is falling at 4 px a frame. */
export interface Observation {
  tick: number
  gapMiddle: number
  gapTop: number
  gapBottom: number
  gapHeight: number
  ahead: number       // px from the hummingbird's beak to the pipe; 0 once inside
  inGap: boolean      // between the pipe's two edges, horizontally
  exit: number        // px until its tail leaves the pipe, when inside
  speed: number
  ground: number      // negative: the ground is always below
  top: number         // the top edge, always above
}

const round = (value: number) => {
  const r = Math.round(value)
  return Object.is(r, -0) ? 0 : r
}
const round1 = (value: number) => {
  const r = Math.round(value * 10) / 10
  return Object.is(r, -0) ? 0 : r
}

export function observe(world: World): Observation {
  const pipe = nextPipe(world)
  const gapY = pipe ? pipe.gapY : WORLD.floor / 2
  const left = pipe ? pipe.x : WORLD.width
  const front = BIRD.x + BIRD.radius
  const back = BIRD.x - BIRD.radius
  const inGap = left <= front && left + PIPES.width >= back
  return {
    tick: world.tick,
    gapMiddle: round(world.y - gapY),
    gapTop: round(world.y - (gapY - PIPES.gap / 2)),
    gapBottom: round(world.y - (gapY + PIPES.gap / 2)),
    gapHeight: PIPES.gap,
    ahead: inGap ? 0 : round(Math.max(0, left - front)),
    inGap,
    exit: inGap ? round(left + PIPES.width - back) : 0,
    speed: round1(-world.vy),
    ground: round(world.y - WORLD.floor),
    top: round(world.y),
  }
}

/* What one flap does, from the same constants the physics uses: the height it
   gains before gravity wins again, and in how many frames. */
export const FLAP_RISE = Math.round(PHYSICS.flap ** 2 / (2 * PHYSICS.gravity))
export const FLAP_FRAMES = Math.round(PHYSICS.flap / PHYSICS.gravity)

/* Two ways to write the same screen. `words` (the default) says it the way a
   person would, with no numbers: where the hummingbird is against the opening,
   how it moves, what is close. `numbers` gives the distances in px and the
   speed in px per frame, for a model that reads numbers well (a language model
   through option scoring may). Each starts with its own constant rules, so an
   engine that reuses a cached prefix reads only the part that changed. */
export type Style = "words" | "numbers"
export const STYLES: readonly Style[] = ["words", "numbers"]

export const RULES =
  "FlappyBri: a hummingbird flies right through the gaps between pipes. " +
  "Touching a pipe, the ground or the top edge ends the game. " +
  `A flap sends it up about ${FLAP_RISE} px over ${FLAP_FRAMES} frames; without one it falls faster every frame.`

const updown = (value: number) => (value >= 0 ? `${value} px above` : `${-value} px below`)

/* The numbers: a short paragraph, then the same numbers as compact JSON. */
export function describeNumbers(o: Observation): string {
  const vertical = o.gapMiddle === 0
    ? "level with the middle of the next gap"
    : `${Math.abs(o.gapMiddle)} px ${o.gapMiddle > 0 ? "below" : "above"} the middle of the next gap`
  const motion = o.speed === 0
    ? "hanging still"
    : `${o.speed < 0 ? "falling" : "rising"} at ${Math.abs(o.speed).toFixed(1)} px per frame`
  const gap = o.inGap
    ? `It is inside the gap now, which ends ${o.exit} px ahead and is ${o.gapHeight} px tall`
    : `The next gap starts ${o.ahead} px ahead and is ${o.gapHeight} px tall`
  const json = JSON.stringify({
    gap_middle: o.gapMiddle, gap_top: o.gapTop, gap_bottom: o.gapBottom, speed: o.speed,
    gap_ahead: o.ahead, in_gap: o.inGap, gap_height: o.gapHeight, ground: o.ground, top: o.top,
  })
  return [
    RULES,
    `Now: the hummingbird is ${vertical} and ${motion}. ` +
      `${gap}: its top edge is ${updown(o.gapTop)} the hummingbird and its bottom edge ${updown(o.gapBottom)} it. ` +
      `The ground is ${-o.ground} px below and the top edge ${o.top} px above.`,
    "Heights in px relative to the hummingbird and speed in px per frame, up is positive:",
    json,
  ].join("\n")
}

/* The words. One sentence of rules that never changes, then the screen in a
   few plain sentences. */
export const WORDS_RULES =
  "A small hummingbird is flying through a row of pipes. It must pass through the opening " +
  "between each pair of pipes. Hitting a pipe, the ground or the ceiling ends the game. " +
  "Flapping makes it fly up; not flapping makes it drop."

/* Where the hummingbird would be after `steps` steps without a flap: how many
   px below the middle of the opening (negative: above it). */
export function driftBelow(o: Observation, steps: number): number {
  let below = o.gapMiddle
  let fall = -o.speed
  for (let i = 0; i < steps; i++) {
    fall = Math.min(fall + PHYSICS.gravity, PHYSICS.terminal)
    below += fall
  }
  return below
}

/* Where each word starts, all from the game's own constants. Heights are the
   hummingbird's middle against the middle of the opening, speeds in px per
   frame, distances in px.

   The heights are where the hummingbird will be `ahead` steps from now, not
   where it is: an answer lands a couple of steps after the screen it was
   about ("Match the model's pace" aims at 2) and a flap acts on the step
   after, and a hummingbird falling fast in the middle of the opening is, by
   then, low in it. Read the plain way (flap when the words put it lower than
   the middle), these words fly every round to the end when answers land 1, 2
   or 3 steps late; words for where it is now lose nearly every round at 3
   (oracle.test.ts). Its motion is described as it is. */
export const WORDS = {
  /* Steps ahead the heights are measured: the answer's 2 steps, then the flap's. */
  ahead: 3,
  /* Inside the opening: the whole body fits, a radius away from either edge. */
  inside: PIPES.gap / 2 - BIRD.radius,
  /* The middle band of the opening, a third of a flap's rise either side of
     the middle; between it and an edge, low or high in the opening. A flap
     from the top of the lower part lifts it a flap's rise, still inside. */
  middle: FLAP_RISE / 3,
  /* Past this, one flap is no longer enough to get back level with the opening. */
  well: PIPES.gap / 2 - BIRD.radius + FLAP_RISE,
  /* Faster than half a flap's speed, up or down, is fast. */
  fast: PHYSICS.flap / 2,
  /* Within three frames of gravity of a standstill: the top of a hop. */
  level: PHYSICS.gravity * 3,
  /* The ground or the ceiling closer than half a flap: about to hit it. */
  hit: FLAP_RISE / 2,
  /* Closer than one flap: close. */
  close: FLAP_RISE,
  /* Pipes that arrive within one flap's time are very close; within two, coming up. */
  near: PIPES.speed * FLAP_FRAMES,
  coming: 2 * PIPES.speed * FLAP_FRAMES,
} as const

export type WordThresholds = { [K in keyof typeof WORDS]: number }

export type Position =
  | "wellBelow" | "littleBelow" | "insideLow" | "middle" | "insideHigh" | "littleAbove" | "wellAbove"
export type Motion = "fallingFast" | "falling" | "level" | "rising" | "risingFast"
export type Nearness = "hit" | "close" | null
export type Pipes = "between" | "veryClose" | "coming" | "far"

export interface Situation {
  position: Position
  motion: Motion
  ground: Nearness
  ceiling: Nearness
  pipes: Pipes
}

/* The observation sorted into words. A boundary value belongs to the calmer
   side: exactly `middle` px below the middle is still the middle. */
export function situation(o: Observation, w: WordThresholds = WORDS): Situation {
  const below = driftBelow(o, w.ahead)   // > 0: the hummingbird will be under the middle
  const moved = below - o.gapMiddle      // px it will have dropped by then
  const position: Position =
    below > w.well ? "wellBelow"
      : below > w.inside ? "littleBelow"
      : below > w.middle ? "insideLow"
      : below >= -w.middle ? "middle"
      : below >= -w.inside ? "insideHigh"
      : below >= -w.well ? "littleAbove"
      : "wellAbove"
  const s = o.speed                  // > 0: rising
  const motion: Motion =
    s < -w.fast ? "fallingFast"
      : s < -w.level ? "falling"
      : s <= w.level ? "level"
      : s <= w.fast ? "rising"
      : "risingFast"
  const near = (gap: number): Nearness => (gap < w.hit ? "hit" : gap < w.close ? "close" : null)
  const pipes: Pipes = o.inGap ? "between"
    : o.ahead <= w.near ? "veryClose"
    : o.ahead <= w.coming ? "coming"
    : "far"
  return {
    position, motion,
    ground: near(-(o.ground + moved) - BIRD.radius),
    ceiling: near(o.top + moved - BIRD.radius),
    pipes,
  }
}

const POSITION_WORDS: Record<Position, string> = {
  wellBelow: "well below the opening",
  littleBelow: "a little below the opening",
  insideLow: "low in the opening, near its bottom edge",
  middle: "right in the middle of the opening",
  insideHigh: "high in the opening, near its top edge",
  littleAbove: "a little above the opening",
  wellAbove: "well above the opening",
}
const MOTION_WORDS: Record<Motion, string> = {
  fallingFast: "falling fast",
  falling: "falling",
  level: "gliding level",
  rising: "rising",
  risingFast: "rising fast",
}
const PIPES_WORDS: Record<Pipes, string> = {
  between: "It is passing between the pipes now.",
  veryClose: "The next pipes are very close.",
  coming: "The next pipes are coming up.",
  far: "The next pipes are still far.",
}

export function describeWords(o: Observation, w: WordThresholds = WORDS): string {
  const it = situation(o, w)
  const ground = it.ground === "hit" ? " It is about to hit the ground." : it.ground === "close" ? " The ground is close." : ""
  const ceiling = it.ceiling === "hit" ? " It is about to hit the ceiling." : it.ceiling === "close" ? " The ceiling is close." : ""
  return `${WORDS_RULES}\nThe hummingbird is ${MOTION_WORDS[it.motion]} and is ${POSITION_WORDS[it.position]}.` +
    `${ground}${ceiling} ${PIPES_WORDS[it.pipes]}`
}

export function describeState(o: Observation, style: Style = "words"): string {
  return style === "numbers" ? describeNumbers(o) : describeWords(o)
}

/* ---- the question -------------------------------------------------------------- */

/* Five questions. The first three ask about the situation, not the move, and
   the game turns the answer into the move: a model that cannot tell when to
   flap can still tell where the hummingbird is. The last two ask for the move
   itself.

     where   choice  below / above / inside                  below means flap (the default)
     low     noul    "Is the hummingbird too low?"           yes means flap
     danger  choice  ground / ceiling / none                 ground means flap
     noul    noul    "Should the hummingbird flap its wings now?"
     choice  choice  flap / glide

   `noul` and `choice` keep their old names so saved settings still load. */
export type Form = "low" | "where" | "danger" | "noul" | "choice"
export const FORMS: readonly Form[] = ["where", "low", "danger", "noul", "choice"]
export const DEFAULT_FORM: Form = "where"

export const QUESTION_ID: Record<Form, string> = {
  low: "low", where: "where", danger: "danger", noul: "flap", choice: "move",
}

/* The answer that means flap: for a noul the probability of yes, for a choice
   the probability of this label. */
export const FLAP_ANSWER: Record<Form, string> = {
  low: "yes", where: "below", danger: "ground", noul: "yes", choice: "flap",
}

/* The questions that describe the situation rather than choose the move. */
export const asksSituation = (form: Form) => form === "low" || form === "where" || form === "danger"

const FLAP_MEANS = `beat the wings once: it rises about ${FLAP_RISE} px over the next ${FLAP_FRAMES} frames`
const GLIDE_MEANS = "do nothing: it keeps falling, a little faster every frame"

const QUESTIONS: Record<Form, SystemOneQuestion> = {
  low: { type: "noul", instructions: "Is the hummingbird too low?" },
  where: {
    type: "choice",
    instructions: "Where is the hummingbird compared with the opening?",
    /* "below" covers the low part of the opening too: that is where a flap
       is due, and with only "lower than the opening" both native decision
       models answered "inside" there. */
    criteria: {
      below: "low: near the bottom edge of the opening or lower, or near the ground",
      above: "high: near the top edge of the opening or higher, or near the ceiling",
      inside: "right in the middle of the opening",
    },
  },
  danger: {
    type: "choice",
    instructions: "What is the danger right now?",
    criteria: {
      ground: "it may hit the ground or the bottom pipe",
      ceiling: "it may hit the ceiling or the top pipe",
      none: "it is safe",
    },
  },
  noul: { type: "noul", instructions: "Should the hummingbird flap its wings now?" },
  choice: {
    type: "choice",
    instructions: "What should the hummingbird do now?",
    criteria: { flap: FLAP_MEANS, glide: GLIDE_MEANS },
  },
}

export function buildQuestions(form: Form): Record<string, SystemOneQuestion> {
  return { [QUESTION_ID[form]]: structuredClone(QUESTIONS[form]) }
}

export function buildRequest(world: World, form: Form, model: string, style: Style = "words"): SystemOneRequest {
  return { model, state: describeState(observe(world), style), questions: buildQuestions(form) }
}

export class AnswerError extends Error {}

/* What the model said: the probability that means flap, and its own answer in
   its own words (yes or no, or the label it picked), for the panel. */
export interface ModelAnswer {
  p: number
  said: string
}

const isProbability = (p: unknown): p is number => typeof p === "number" && Number.isFinite(p) && p >= 0 && p <= 1

export function readAnswer(response: SystemOneResponse, form: Form): ModelAnswer {
  const id = QUESTION_ID[form]
  const answer = response?.answers?.[id]
  const want = FLAP_ANSWER[form]
  const noul = QUESTIONS[form].type === "noul"
  if (noul && answer?.type === "noul" && isProbability(answer.noul)) {
    return { p: answer.noul, said: answer.noul > 0.5 ? "yes" : "no" }
  }
  if (!noul && answer?.type === "choice" && answer.probabilities && isProbability(answer.probabilities[want])) {
    const probabilities = answer.probabilities
    const said = typeof answer.choice === "string" && answer.choice in probabilities
      ? answer.choice
      : Object.keys(probabilities).reduce((a, b) => (probabilities[b] > probabilities[a] ? b : a))
    return { p: probabilities[want], said }
  }
  throw new AnswerError(`The reply has no probability for "${id}"${noul ? "" : ` (${want})`}.`)
}

/* p(flap) out of the reply: the probability of the answer that means flap. */
export const flapProbability = (response: SystemOneResponse, form: Form): number => readAnswer(response, form).p

/* Strictly above: at exactly the threshold the model is not saying flap. */
export const shouldFlap = (p: number, threshold: number) => p > threshold

/* ---- failures ------------------------------------------------------------------ */

export type FailureKind = "unreachable" | "noModel" | "imageModel" | "route" | "http" | "answer"

export interface PilotFailure {
  kind: FailureKind
  message: string
  status?: number
  model?: string
}

export function classify(cause: unknown): PilotFailure {
  if (cause instanceof HttpError) {
    return cause.status === 404
      ? { kind: "route", status: 404, message: cause.message }
      : { kind: "http", status: cause.status, message: cause.message }
  }
  if (cause instanceof AnswerError || cause instanceof SyntaxError) {
    return { kind: "answer", message: cause.message }
  }
  return { kind: "unreachable", message: cause instanceof Error ? cause.message : String(cause) }
}

/* Before the model plays: is there a server, and a model on it that can decide?
   /v1/models answers both. The model the connection test found is kept when
   the server still lists it; otherwise the one the server runs. */
export async function findModel(baseUrl: string, apiKey: string, preferred: string, signal?: AbortSignal):
  Promise<{ model: string } | { failure: PilotFailure }> {
  let models
  try {
    models = await listModelInfo(baseUrl, apiKey, signal)
  } catch (cause) {
    if (cause instanceof TypeError) return { failure: { kind: "unreachable", message: cause.message } }
    return { failure: { kind: "http", message: cause instanceof Error ? cause.message : String(cause) } }
  }
  if (!models.length) return { failure: { kind: "noModel", message: "The server lists no model." } }
  const chosen = models.find((item) => item.id === preferred) || models[0]
  if (generatesImages(chosen)) {
    return { failure: { kind: "imageModel", model: chosen.id, message: `${chosen.id} generates images.` } }
  }
  return { model: chosen.id }
}

/* ---- the pilot ----------------------------------------------------------------- */

export interface Decision {
  flap: boolean
  /* The probability of the answer that means flap. */
  p: number
  /* The model's own answer: yes or no, or the label it picked. */
  said: string
  form: Form
  threshold: number
  latencyMs: number
  engineMs: number | null
  askedTick: number
  /* Steps the world moved on between the screen the model read and the step
     the answer was applied to. Known when it is applied. */
  stepsLate: number
  model: string
}

export interface PilotOptions {
  baseUrl: string
  apiKey: string
  model: string
  form?: Form
  style?: Style
  threshold?: number
  window?: number
  now?: () => number
  /* An answer has arrived (not yet applied): what pacing should react to. */
  onAnswer?: (decision: Decision) => void
  /* An answer has been applied to the step about to run. */
  onApply?: (decision: Decision) => void
  onFailure?: (failure: PilotFailure) => void
}

export class Pilot {
  baseUrl: string
  apiKey: string
  model: string
  form: Form
  style: Style
  threshold: number
  readonly latency: LatencyWindow
  failure: PilotFailure | null = null
  last: Decision | null = null
  lastState = ""
  private readonly now: () => number
  private readonly onAnswer?: (decision: Decision) => void
  private readonly onApply?: (decision: Decision) => void
  private readonly onFailure?: (failure: PilotFailure) => void
  private controller: AbortController | null = null
  private arrived: Decision | null = null
  private askedTick = -1
  private generation = 0

  constructor(options: PilotOptions) {
    this.baseUrl = options.baseUrl
    this.apiKey = options.apiKey
    this.model = options.model
    this.form = options.form ?? DEFAULT_FORM
    this.style = options.style ?? "words"
    this.threshold = options.threshold ?? 0.5
    this.latency = new LatencyWindow(options.window ?? 100)
    this.now = options.now ?? (() => performance.now())
    this.onAnswer = options.onAnswer
    this.onApply = options.onApply
    this.onFailure = options.onFailure
  }

  /* A request is on the wire. */
  get busy() {
    return this.controller !== null
  }

  /* Ask about the world as it is, unless a question is already out, an answer
     is waiting to be applied, the world has not moved since the last question,
     or the pilot has failed. Returns the request, so a caller (a test) can wait
     for it; the game itself never does. */
  poll(world: World): Promise<void> | null {
    if (this.failure || this.controller || this.arrived) return null
    if (world.phase !== "playing" || world.tick === this.askedTick) return null
    return this.ask(world)
  }

  /* Called once per step, before the step: the answer that arrived since the
     last one, if any, now applied to the current world. */
  take(world: World): Decision | null {
    const decision = this.arrived
    if (!decision) return null
    this.arrived = null
    decision.stepsLate = world.tick - decision.askedTick
    this.last = decision
    this.onApply?.(decision)
    return decision
  }

  /* Drop the question in flight and any answer not yet applied: a pause, a new
     round. The latencies stay, they describe the model, not the round. */
  stop() {
    this.generation += 1
    this.controller?.abort()
    this.controller = null
    this.arrived = null
    this.askedTick = -1
    this.latency.breakRun()
  }

  /* Start over after a failure, for a new attempt. */
  reset() {
    this.stop()
    this.failure = null
  }

  private async ask(world: World) {
    const generation = this.generation
    const controller = new AbortController()
    this.controller = controller
    const form = this.form
    const request = buildRequest(world, form, this.model, this.style)
    const askedTick = world.tick
    this.askedTick = askedTick
    this.lastState = request.state
    const started = this.now()
    try {
      const reply = await askSystemOne(this.baseUrl, this.apiKey, request, controller.signal)
      if (generation !== this.generation) return
      const { p, said } = readAnswer(reply.response, form)
      const at = this.now()
      const latencyMs = at - started
      this.latency.push(latencyMs, at)
      this.arrived = {
        flap: shouldFlap(p, this.threshold), p, said, form, threshold: this.threshold, latencyMs,
        engineMs: reply.engineMs, askedTick, stepsLate: 0,
        model: typeof reply.response.model === "string" && reply.response.model ? reply.response.model : this.model,
      }
      this.onAnswer?.(this.arrived)
    } catch (cause) {
      if (generation !== this.generation || controller.signal.aborted) return
      this.failure = classify(cause)
      this.onFailure?.(this.failure)
    } finally {
      if (this.controller === controller) this.controller = null
    }
  }
}
