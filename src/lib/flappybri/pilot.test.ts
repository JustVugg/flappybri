import { afterEach, describe, expect, it, vi } from "vitest"

import { BIRD, PHYSICS, PIPES, createWorld, step, type World } from "./game"
import {
  DEFAULT_FORM, FLAP_ANSWER, FLAP_FRAMES, FLAP_RISE, FORMS, Pilot, QUESTION_ID, RULES, WORDS, WORDS_RULES,
  asksSituation, buildQuestions, buildRequest, classify, describeNumbers, describeState, describeWords,
  driftBelow, findModel, flapProbability, observe, readAnswer, shouldFlap, situation,
  type Form, type Observation, type PilotFailure, type WordThresholds,
} from "./pilot"
import { HttpError, type SystemOneResponse } from "../api"

afterEach(() => vi.unstubAllGlobals())

/* Replies in the exact shape c/openai_server.py's systemone() writes: `model`,
   `answers` keyed by question id, `usage` with input/output tokens. The extra
   fields a newer gateway adds (`id`, `provider`, `usage.cost`) are included on
   purpose: the client must read through them. */
const noulReply = (p: number, id = QUESTION_ID[DEFAULT_FORM]): SystemOneResponse & Record<string, unknown> => ({
  id: "so_123", provider: "colibri", model: "qwen36",
  answers: { [id]: { type: "noul", noul: p } },
  usage: { input_tokens: 182, output_tokens: 2, cost: 0 } as SystemOneResponse["usage"],
})
const choiceReply = (p: number): SystemOneResponse => ({
  model: "qwen36",
  answers: {
    move: {
      type: "choice", choice: p > 0.5 ? "flap" : "glide",
      probabilities: { flap: p, glide: 1 - p }, confidence: Math.abs(2 * p - 1),
    },
  },
  usage: { input_tokens: 230, output_tokens: 3 },
})

const json = (body: unknown, init: ResponseInit = {}) =>
  new Response(JSON.stringify(body), { status: 200, headers: { "Content-Type": "application/json" }, ...init })

/* A fetch whose answer the test releases when it wants: the model "thinking". */
function deferredFetch() {
  const calls: Array<{ url: string; body: Record<string, unknown>; release: (r: Response) => void; fail: (e: unknown) => void }> = []
  const fetchMock = vi.fn((url: string, init: RequestInit) => new Promise<Response>((resolve, reject) => {
    calls.push({ url, body: JSON.parse(String(init.body)), release: resolve, fail: reject })
    init.signal?.addEventListener("abort", () => reject(new DOMException("aborted", "AbortError")))
  }))
  vi.stubGlobal("fetch", fetchMock)
  return { fetchMock, calls }
}

const playing = (seed = 42): World => {
  const world = createWorld(seed)
  world.phase = "playing"
  return world
}

const clock = () => {
  let t = 1000
  return { now: () => t, advance: (ms: number) => { t += ms } }
}

describe("the state the model reads", () => {
  it("places the gap, the edges and the ground relative to the hummingbird, up positive", () => {
    const world = playing()
    world.pipes = [{ id: 1, x: BIRD.x + BIRD.radius + 120, gapY: 200, scored: false }]
    world.y = 238          // 38 px lower on screen than the gap's middle
    world.vy = 4           // falling
    const o = observe(world)
    expect(o).toMatchObject({
      gapMiddle: 38, gapTop: 38 + PIPES.gap / 2, gapBottom: 38 - PIPES.gap / 2,
      ahead: 120, inGap: false, speed: -4, gapHeight: PIPES.gap, ground: 238 - 540, top: 238,
    })
    const text = describeState(o, "numbers")
    expect(text).toBe(describeNumbers(o))
    expect(text.startsWith(RULES)).toBe(true)
    expect(text).toContain("the hummingbird is 38 px below the middle of the next gap and falling at 4.0 px per frame")
    expect(text).toContain("The next gap starts 120 px ahead and is 150 px tall")
    expect(text).toContain("its top edge is 113 px above the hummingbird and its bottom edge 37 px below it")
    expect(text).toContain("The ground is 302 px below and the top edge 238 px above.")
    const data = JSON.parse(text.split("\n").pop()!)
    expect(data).toEqual({
      gap_middle: 38, gap_top: 113, gap_bottom: -37, speed: -4, gap_ahead: 120,
      in_gap: false, gap_height: 150, ground: -302, top: 238,
    })
  })

  it("says when the hummingbird is inside the gap, rising, or level", () => {
    const world = playing()
    world.pipes = [{ id: 1, x: BIRD.x - 20, gapY: 300, scored: false }]
    world.y = 300
    world.vy = -2.04
    const o = observe(world)
    expect(o.inGap).toBe(true)
    expect(o.ahead).toBe(0)
    expect(o.exit).toBe(PIPES.width - 20 + BIRD.radius)
    const text = describeNumbers(o)
    expect(text).toContain("level with the middle of the next gap and rising at 2.0 px per frame")
    expect(text).toContain(`It is inside the gap now, which ends ${o.exit} px ahead`)
    world.vy = 0
    expect(describeNumbers(observe(world))).toContain("hanging still")
  })

  it("never writes a negative zero", () => {
    const world = playing()
    world.pipes = [{ id: 1, x: 300, gapY: 250.2, scored: false }]
    world.y = 250
    world.vy = 0.01
    const o = observe(world)
    expect(Object.is(o.gapMiddle, -0)).toBe(false)
    expect(Object.is(o.speed, -0)).toBe(false)
  })

  it("is a pure function of the world", () => {
    const world = playing()
    for (let i = 0; i < 30; i++) step(world, i % 9 === 0)
    const before = structuredClone(world)
    expect(describeState(observe(world))).toBe(describeState(observe(world)))
    expect(describeState(observe(world), "numbers")).toBe(describeState(observe(world), "numbers"))
    expect(world).toEqual(before)
  })
})

/* An observation with only what a test sets; everything else calm: in the
   middle of an opening far ahead, level, far from the ground and the ceiling. */
const obs = (over: Partial<Observation> = {}): Observation => ({
  tick: 0, gapMiddle: 0, gapTop: 75, gapBottom: -75, gapHeight: PIPES.gap, ahead: 200, inGap: false, exit: 0,
  speed: 0, ground: -270, top: 270, ...over,
})
/* The thresholds with no looking ahead, so a height in a test is the height
   the words describe. */
const NOW: WordThresholds = { ...WORDS, ahead: 0 }

describe("the state in words", () => {
  it("takes every threshold from the game's constants", () => {
    expect(FLAP_RISE).toBe(60)
    expect(FLAP_FRAMES).toBe(18)
    expect(WORDS).toEqual({
      ahead: 2,
      inside: PIPES.gap / 2 - BIRD.radius,                  // 63
      middle: PIPES.gap / 10,                               // 15
      well: PIPES.gap / 2 - BIRD.radius + FLAP_RISE,        // 123
      fast: PHYSICS.flap / 2,                               // 3.3
      level: PHYSICS.gravity * 3,                           // 1.08
      hit: FLAP_RISE / 2,                                   // 30
      close: FLAP_RISE,                                     // 60
      near: PIPES.speed * FLAP_FRAMES,                      // 43.2
      coming: 2 * PIPES.speed * FLAP_FRAMES,                // 86.4
    })
  })

  it("starts with the same rules sentence every time, then one line about the screen", () => {
    const states = [obs(), obs({ gapMiddle: 200, speed: -9 }), obs({ gapMiddle: -150, speed: 6.6, inGap: true, ahead: 0 })]
    for (const o of states) {
      const text = describeWords(o)
      expect(text.startsWith(`${WORDS_RULES}\n`)).toBe(true)
      expect(text.split("\n")).toHaveLength(2)
      expect(text).not.toMatch(/\d/)
      expect(text).not.toMatch(/\bpx\b/)
    }
    expect(WORDS_RULES).toBe(
      "A small hummingbird is flying through a row of pipes. It must pass through the opening " +
      "between each pair of pipes. Hitting a pipe, the ground or the ceiling ends the game. " +
      "Flapping makes it fly up; not flapping makes it drop.")
    expect(describeState(obs())).toBe(describeWords(obs()))
  })

  it("places the hummingbird against the opening, the calmer word at each boundary", () => {
    const at = (gapMiddle: number) => situation(obs({ gapMiddle }), NOW).position
    const { middle, inside, well } = NOW
    expect([at(well + 1), at(well), at(inside + 1), at(inside), at(middle + 1), at(middle)])
      .toEqual(["wellBelow", "littleBelow", "littleBelow", "insideLow", "insideLow", "middle"])
    expect([at(0), at(-middle), at(-middle - 1), at(-inside), at(-inside - 1), at(-well), at(-well - 1)])
      .toEqual(["middle", "middle", "insideHigh", "insideHigh", "littleAbove", "littleAbove", "wellAbove"])
  })

  it("names the motion, the calmer word at each boundary", () => {
    const at = (speed: number) => situation(obs({ speed }), NOW).motion
    const { fast, level } = NOW
    expect([at(-fast - 0.01), at(-fast), at(-level - 0.01), at(-level), at(0), at(level), at(level + 0.01), at(fast), at(fast + 0.01)])
      .toEqual(["fallingFast", "falling", "falling", "level", "level", "level", "rising", "rising", "risingFast"])
  })

  it("says when the ground or the ceiling is close or about to be hit", () => {
    /* the gap between the hummingbird's edge and the ground or the ceiling */
    const ground = (gap: number) => situation(obs({ ground: -(gap + BIRD.radius) }), NOW).ground
    const ceiling = (gap: number) => situation(obs({ top: gap + BIRD.radius }), NOW).ceiling
    for (const near of [ground, ceiling]) {
      expect([near(NOW.hit - 1), near(NOW.hit), near(NOW.close - 1), near(NOW.close)]).toEqual(["hit", "close", "close", null])
    }
    expect(describeWords(obs({ gapMiddle: 200, ground: -(10 + BIRD.radius) }), NOW)).toContain(" It is about to hit the ground.")
    expect(describeWords(obs({ gapMiddle: 200, ground: -(40 + BIRD.radius) }), NOW)).toContain(" The ground is close.")
    expect(describeWords(obs({ gapMiddle: -200, top: 10 + BIRD.radius }), NOW)).toContain(" It is about to hit the ceiling.")
    expect(describeWords(obs({ gapMiddle: -200, top: 40 + BIRD.radius }), NOW)).toContain(" The ceiling is close.")
    expect(describeWords(obs(), NOW).split("\n")[1]).not.toMatch(/ground|ceiling|hit/)
  })

  it("says how far the next pipes are, or that it is passing between them", () => {
    const at = (ahead: number, inGap = false) => situation(obs({ ahead, inGap }), NOW).pipes
    expect([at(0, true), at(0), at(NOW.near), at(NOW.near + 1), at(NOW.coming), at(NOW.coming + 1)])
      .toEqual(["between", "veryClose", "veryClose", "coming", "coming", "far"])
  })

  it("reads as one plain sentence", () => {
    expect(describeWords(obs({ gapMiddle: 90, speed: -5, ahead: 30, ground: -(40 + BIRD.radius) }), NOW)).toBe(
      `${WORDS_RULES}\nThe hummingbird is falling fast and is a little below the opening. ` +
      "The ground is close. The next pipes are very close.")
    expect(describeWords(obs({ gapMiddle: 0, inGap: true, ahead: 0 }), NOW)).toBe(
      `${WORDS_RULES}\nThe hummingbird is gliding level and is right in the middle of the opening. ` +
      "It is passing between the pipes now.")
  })

  it("describes the heights where the hummingbird will be when the answer lands", () => {
    /* falling fast in the middle: two steps later it is near the bottom edge */
    const o = obs({ gapMiddle: 5, speed: -7 })
    expect(driftBelow(o, 2)).toBeCloseTo(5 + (7 + 0.36) + (7 + 0.72))
    expect(situation(o, NOW).position).toBe("middle")
    expect(situation(o).position).toBe("insideLow")
    expect(situation(o).motion).toBe("fallingFast")
    /* the fall stops at the terminal speed */
    expect(driftBelow(obs({ speed: -PHYSICS.terminal }), 3)).toBeCloseTo(3 * PHYSICS.terminal)
    /* the ground and the ceiling move with it */
    expect(situation(obs({ gapMiddle: 200, speed: -8, ground: -(45 + BIRD.radius) })).ground).toBe("hit")
    expect(situation(obs({ gapMiddle: 200, speed: -8, ground: -(45 + BIRD.radius) }), NOW).ground).toBe("close")
  })
})

const choiceAnswer = (probabilities: Record<string, number>, choice?: string) => ({
  type: "choice" as const, choice: choice ?? Object.keys(probabilities)[0], probabilities, confidence: 0.5,
})
const replyFor = (form: Form, answer: SystemOneResponse["answers"][string]): SystemOneResponse =>
  ({ model: "m", answers: { [QUESTION_ID[form]]: answer } })

describe("the question", () => {
  it("asks about the situation by default: is the hummingbird too low?", () => {
    expect(DEFAULT_FORM).toBe("low")
    expect(FORMS).toEqual(["low", "where", "danger", "noul", "choice"])
    expect(buildQuestions("low")).toEqual({ low: { type: "noul", instructions: "Is the hummingbird too low?" } })
    const request = buildRequest(playing(), DEFAULT_FORM, "qwen36")
    expect(request.model).toBe("qwen36")
    expect(request.state.startsWith(WORDS_RULES)).toBe(true)
    expect(Object.keys(request.questions)).toEqual(["low"])
    expect(buildRequest(playing(), "noul", "m", "numbers").state.startsWith(RULES)).toBe(true)
  })

  it("has three situation questions and two move questions, each with the answer that means flap", () => {
    expect(FORMS.filter(asksSituation)).toEqual(["low", "where", "danger"])
    expect(FLAP_ANSWER).toEqual({ low: "yes", where: "below", danger: "ground", noul: "yes", choice: "flap" })
    expect(buildQuestions("where")).toEqual({
      where: {
        type: "choice", instructions: "Where is the hummingbird compared with the opening?",
        criteria: {
          below: "lower than the opening, or near the ground",
          above: "higher than the opening, or near the ceiling",
          inside: "level with the opening",
        },
      },
    })
    expect(buildQuestions("danger")).toEqual({
      danger: {
        type: "choice", instructions: "What is the danger right now?",
        criteria: {
          ground: "it may hit the ground or the bottom pipe",
          ceiling: "it may hit the ceiling or the top pipe",
          none: "it is safe",
        },
      },
    })
    expect(buildQuestions("noul")).toEqual({ flap: { type: "noul", instructions: "Should the hummingbird flap its wings now?" } })
    expect(Object.keys((buildQuestions("choice").move as { criteria: Record<string, string> }).criteria)).toEqual(["flap", "glide"])
    /* each form's question goes out under its own id, and a caller cannot change the shared one */
    for (const form of FORMS) expect(Object.keys(buildQuestions(form))).toEqual([QUESTION_ID[form]])
    ;(buildQuestions("where").where as { instructions: string }).instructions = "changed"
    expect(buildQuestions("where").where.instructions).toBe("Where is the hummingbird compared with the opening?")
  })

  it("turns each answer into the probability that means flap, and keeps what the model said", () => {
    expect(readAnswer(replyFor("low", { type: "noul", noul: 0.8 }), "low")).toEqual({ p: 0.8, said: "yes" })
    expect(readAnswer(replyFor("low", { type: "noul", noul: 0.5 }), "low")).toEqual({ p: 0.5, said: "no" })
    expect(readAnswer(replyFor("noul", { type: "noul", noul: 0.3 }), "noul")).toEqual({ p: 0.3, said: "no" })
    expect(readAnswer(replyFor("where", choiceAnswer({ below: 0.2, above: 0.1, inside: 0.7 }, "inside")), "where"))
      .toEqual({ p: 0.2, said: "inside" })
    expect(readAnswer(replyFor("danger", choiceAnswer({ ground: 0.6, ceiling: 0.1, none: 0.3 }, "ground")), "danger"))
      .toEqual({ p: 0.6, said: "ground" })
    /* a reply without a usable `choice` still says which label won */
    expect(readAnswer(replyFor("where", { type: "choice", probabilities: { below: 0.1, above: 0.6, inside: 0.3 } } as never), "where").said)
      .toBe("above")
    expect(flapProbability(replyFor("choice", choiceAnswer({ flap: 0.2, glide: 0.8 })), "choice")).toBe(0.2)
  })

  it("refuses a reply that does not carry the probability it needs", () => {
    expect(() => readAnswer(replyFor("where", choiceAnswer({ above: 0.5, inside: 0.5 })), "where")).toThrow(/where.*below/)
    expect(() => readAnswer(replyFor("low", choiceAnswer({ below: 0.5, above: 0.5 })), "low")).toThrow(/low/)
    expect(() => readAnswer(replyFor("danger", { type: "noul", noul: 0.4 }), "danger")).toThrow(/danger/)
    expect(() => flapProbability({ model: "m", answers: { flap: { type: "noul", noul: Number.NaN } } }, "noul")).toThrow()
    expect(() => flapProbability({ model: "m", answers: { flap: { type: "noul", noul: 1.2 } } }, "noul")).toThrow()
    expect(() => flapProbability({ model: "m", answers: {} } as SystemOneResponse, "choice")).toThrow(/move/)
  })

  it("flaps strictly above the threshold", () => {
    expect(shouldFlap(0.51, 0.5)).toBe(true)
    expect(shouldFlap(0.5, 0.5)).toBe(false)
    expect(shouldFlap(0.49, 0.5)).toBe(false)
    expect(shouldFlap(0.8, 0.85)).toBe(false)
  })
})

describe("the pilot", () => {
  it("posts the request to /v1/systemone with the key, and flaps above the threshold", async () => {
    const fetchMock = vi.fn(async () => json(noulReply(0.62), { headers: { "x-colibri-elapsed-ms": "37" } }))
    vi.stubGlobal("fetch", fetchMock)
    const world = playing()
    const pilot = new Pilot({ baseUrl: "http://127.0.0.1:8000/v1/", apiKey: "secret", model: "qwen36" })
    await pilot.poll(world)
    const [url, init] = fetchMock.mock.calls[0] as unknown as [string, RequestInit]
    expect(url).toBe("http://127.0.0.1:8000/v1/systemone")
    expect(init.method).toBe("POST")
    expect(init.headers).toMatchObject({ Authorization: "Bearer secret", "Content-Type": "application/json" })
    const body = JSON.parse(String(init.body))
    expect(body).toEqual({ model: "qwen36", state: describeWords(observe(world)), questions: buildQuestions("low") })
    const decision = pilot.take(world)!
    expect(decision).toMatchObject({ flap: true, p: 0.62, said: "yes", form: "low", threshold: 0.5, engineMs: 37, model: "qwen36" })

    /* the same answer under a higher threshold is a glide */
    pilot.threshold = 0.7
    step(world, false)
    await pilot.poll(world)
    expect(pilot.take(world)).toMatchObject({ flap: false, p: 0.62, threshold: 0.7 })
  })

  it("reads the choice form's probability of flap", async () => {
    vi.stubGlobal("fetch", vi.fn(async () => json(choiceReply(0.81))))
    const world = playing()
    const pilot = new Pilot({ baseUrl: "http://x/v1", apiKey: "", model: "m", form: "choice", threshold: 0.6 })
    await pilot.poll(world)
    expect(pilot.take(world)).toMatchObject({ flap: true, p: 0.81, said: "flap", form: "choice" })
  })

  it("flaps on below when it asks where the hummingbird is, and sends numbers when told to", async () => {
    const fetchMock = vi.fn(async () => json(replyFor("where", choiceAnswer({ below: 0.7, above: 0.1, inside: 0.2 }, "below"))))
    vi.stubGlobal("fetch", fetchMock)
    const world = playing()
    const pilot = new Pilot({ baseUrl: "http://x/v1", apiKey: "", model: "m", form: "where", style: "numbers" })
    await pilot.poll(world)
    const body = JSON.parse(String((fetchMock.mock.calls[0] as unknown as [string, RequestInit])[1].body))
    expect(body.state).toBe(describeNumbers(observe(world)))
    expect(body.questions).toEqual(buildQuestions("where"))
    expect(pilot.take(world)).toMatchObject({ flap: true, p: 0.7, said: "below", form: "where" })
    /* an answer that says inside, with p(below) under the threshold, glides */
    fetchMock.mockImplementation(async () => json(replyFor("where", choiceAnswer({ below: 0.3, above: 0.1, inside: 0.6 }, "inside"))))
    step(world, false)
    await pilot.poll(world)
    expect(pilot.take(world)).toMatchObject({ flap: false, p: 0.3, said: "inside" })
  })

  it("keeps one request in flight while the game runs on", async () => {
    const { fetchMock, calls } = deferredFetch()
    const world = playing()
    const pilot = new Pilot({ baseUrl: "http://x/v1", apiKey: "", model: "m" })
    const pending = pilot.poll(world)
    expect(pending).not.toBeNull()
    expect(pilot.busy).toBe(true)
    for (let i = 0; i < 8; i++) {
      step(world, pilot.take(world)?.flap ?? false)
      expect(pilot.poll(world)).toBeNull()
    }
    expect(fetchMock).toHaveBeenCalledTimes(1)
    expect(world.tick).toBe(8)

    calls[0].release(json(noulReply(0.1)))
    await pending
    expect(pilot.busy).toBe(false)
    /* an answer waiting to be applied also holds the next question back */
    expect(pilot.poll(world)).toBeNull()
    step(world, pilot.take(world)!.flap)
    expect(pilot.poll(world)).not.toBeNull()
    expect(fetchMock).toHaveBeenCalledTimes(2)
  })

  it("does not ask twice about the same step", async () => {
    vi.stubGlobal("fetch", vi.fn(async () => json(noulReply(0.3))))
    const world = playing()
    const pilot = new Pilot({ baseUrl: "http://x/v1", apiKey: "", model: "m" })
    await pilot.poll(world)
    pilot.take(world)
    expect(pilot.poll(world)).toBeNull()
    step(world, false)
    expect(pilot.poll(world)).not.toBeNull()
  })

  it("applies a late answer to the current step, and says how late it was", async () => {
    const { calls } = deferredFetch()
    const time = clock()
    const applied: number[] = []
    const answered: number[] = []
    const world = playing()
    const pilot = new Pilot({
      baseUrl: "http://x/v1", apiKey: "", model: "m", now: time.now,
      onAnswer: (d) => answered.push(d.latencyMs), onApply: (d) => applied.push(d.stepsLate),
    })
    const asked = pilot.poll(world)!
    const seen = calls[0].body.state

    /* the model thinks for 5 steps; the world does not wait */
    for (let i = 0; i < 5; i++) step(world, pilot.take(world)?.flap ?? false)
    expect(world.flaps).toBe(0)
    time.advance(83)
    calls[0].release(json(noulReply(0.9)))
    await asked
    /* known on arrival, before any step applies it: pacing can react at once */
    expect(answered).toEqual([83])
    expect(applied).toEqual([])

    const decision = pilot.take(world)!
    expect(decision.flap).toBe(true)
    expect(decision.askedTick).toBe(0)
    expect(decision.stepsLate).toBe(5)
    expect(decision.latencyMs).toBe(83)
    step(world, decision.flap)
    /* the flap lands on step 6, the current one, not back on step 1 */
    expect(world.lastFlapTick).toBe(6)
    expect(applied).toEqual([5])
    expect(pilot.last).toBe(decision)
    expect(pilot.lastState).toBe(seen)
    /* applied once */
    expect(pilot.take(world)).toBeNull()
  })

  it("drops an answer that arrives after the round was stopped", async () => {
    const { calls } = deferredFetch()
    const world = playing()
    const pilot = new Pilot({ baseUrl: "http://x/v1", apiKey: "", model: "m" })
    const asked = pilot.poll(world)!
    pilot.stop()
    expect(pilot.busy).toBe(false)
    calls[0].release(json(noulReply(0.99)))
    await asked
    expect(pilot.take(world)).toBeNull()
    expect(pilot.failure).toBeNull()
  })

  it("measures latency and the decision rate", async () => {
    const time = clock()
    vi.stubGlobal("fetch", vi.fn(async () => { time.advance(40); return json(noulReply(0.4)) }))
    const world = playing()
    const pilot = new Pilot({ baseUrl: "http://x/v1", apiKey: "", model: "m", now: time.now })
    for (let i = 0; i < 5; i++) {
      await pilot.poll(world)
      step(world, pilot.take(world)!.flap)
      time.advance(10)
    }
    expect(pilot.latency.summary()).toEqual({ last: 40, avg: 40, p95: 40, count: 5 })
    expect(pilot.latency.rate()).toBe(20)    // one answer every 50 ms
  })

  it("falls back when the server cannot be reached, and stops asking", async () => {
    const fetchMock = vi.fn(async () => { throw new TypeError("Failed to fetch") })
    vi.stubGlobal("fetch", fetchMock)
    const failures: PilotFailure[] = []
    const world = playing()
    const pilot = new Pilot({ baseUrl: "http://x/v1", apiKey: "", model: "m", onFailure: (f) => failures.push(f) })
    await pilot.poll(world)
    expect(failures).toEqual([{ kind: "unreachable", message: "Failed to fetch" }])
    expect(pilot.failure?.kind).toBe("unreachable")
    step(world, false)
    expect(pilot.poll(world)).toBeNull()
    expect(fetchMock).toHaveBeenCalledTimes(1)
    pilot.reset()
    expect(pilot.poll(world)).not.toBeNull()
  })

  it("tells a missing route, a refusal and an unreadable answer apart", async () => {
    const cases: Array<[Response, PilotFailure["kind"]]> = [
      [json({ error: { message: "Not found." } }, { status: 404 }), "route"],
      [json({ error: { message: "`state` is required" } }, { status: 422 }), "http"],
      [json({ model: "m", answers: {} }), "answer"],
    ]
    for (const [response, kind] of cases) {
      vi.stubGlobal("fetch", vi.fn(async () => response))
      const pilot = new Pilot({ baseUrl: "http://x/v1", apiKey: "", model: "m" })
      await pilot.poll(playing())
      expect(pilot.failure?.kind).toBe(kind)
    }
    expect(classify(new HttpError("Invalid API key.", 401))).toEqual({ kind: "http", status: 401, message: "Invalid API key." })
  })
})

describe("finding the model", () => {
  it("keeps the tested model when the server lists it, else takes the served one", async () => {
    vi.stubGlobal("fetch", vi.fn(async () => json({ object: "list", data: [{ id: "qwen36", object: "model" }] })))
    expect(await findModel("http://x/v1", "", "glm-5.2-colibri")).toEqual({ model: "qwen36" })
    expect(await findModel("http://x/v1", "", "qwen36")).toEqual({ model: "qwen36" })
  })

  it("falls back when nothing answers, nothing is loaded, or the model only draws", async () => {
    vi.stubGlobal("fetch", vi.fn(async () => { throw new TypeError("Failed to fetch") }))
    expect(await findModel("http://x/v1", "", "m")).toMatchObject({ failure: { kind: "unreachable" } })
    vi.stubGlobal("fetch", vi.fn(async () => json({ object: "list", data: [] })))
    expect(await findModel("http://x/v1", "", "m")).toMatchObject({ failure: { kind: "noModel" } })
    vi.stubGlobal("fetch", vi.fn(async () => json({ data: [{ id: "qwen-image", capabilities: ["image_generation"] }] })))
    expect(await findModel("http://x/v1", "", "m")).toMatchObject({ failure: { kind: "imageModel", model: "qwen-image" } })
    vi.stubGlobal("fetch", vi.fn(async () => json({ error: { message: "Invalid API key." } }, { status: 401 })))
    expect(await findModel("http://x/v1", "", "m")).toMatchObject({ failure: { kind: "http", message: "Invalid API key." } })
  })
})
