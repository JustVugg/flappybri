/* How often does a model's answer agree with the oracle?
 *
 *   npm run agreement -- --server gliner=http://127.0.0.1:8017/v1
 *   npm run agreement -- --server a=http://127.0.0.1:8017/v1 --server b=http://127.0.0.1:8018/v1 \
 *       --forms where,low,danger --style words --states 300 --play 10
 *
 * Screens come from real rounds played with the game's own physics and code
 * (src/lib/flappybri): the oracle flies, sometimes with a decision flipped, so
 * the screens include the ones a model that errs ends up in. Each screen is
 * labelled by the oracle (src/lib/flappybri/oracle.ts), described exactly as
 * the page describes it, and sent to every server with one question, exactly
 * as the page sends it. The answer becomes flap or glide the way the page
 * turns it (p of the answer that means flap, above --threshold).
 *
 * --play N also lets each model fly N seeded rounds on its own, headless,
 * with its answers landing --late steps after the screen they were about (2 is
 * what "Match the model's pace" aims for), and prints the scores.
 *
 * The models colibri serves are deterministic, so answers are cached by the
 * exact request (--cache, a JSON file): a second run asks only what is new.
 * Latency is measured on the requests actually sent. */

import { readFileSync, writeFileSync } from "node:fs"

import { askSystemOne } from "../src/lib/api"
import { createWorld, step } from "../src/lib/flappybri/game"
import {
  FORMS, buildQuestions, describeState, observe, readAnswer, shouldFlap,
  type Form, type Observation, type Style,
} from "../src/lib/flappybri/pilot"
import { oracleFlap, playRound, type Sample } from "../src/lib/flappybri/oracle"
import type { SystemOneQuestion, SystemOneResponse } from "../src/lib/api"

interface Args {
  servers: Array<{ name: string; url: string; key: string }>
  forms: Form[]
  style: Style
  states: number
  seed: number
  threshold: number
  play: number
  late: number
  cache: string
  json: string
}

function parseArgs(argv: string[]): Args {
  const args: Args = {
    servers: [], forms: ["low", "where", "danger"], style: "words", states: 300, seed: 1,
    threshold: 0.5, play: 0, late: 2, cache: "agreement-cache.json", json: "",
  }
  for (let i = 0; i < argv.length; i++) {
    const flag = argv[i]
    const value = () => {
      const next = argv[++i]
      if (next === undefined) throw new Error(`${flag} needs a value`)
      return next
    }
    if (flag === "--server") {
      const raw = value()
      const at = raw.indexOf("=")
      const name = at > 0 ? raw.slice(0, at) : raw
      const url = at > 0 ? raw.slice(at + 1) : raw
      args.servers.push({ name, url, key: process.env.COLI_API_KEY || "" })
    } else if (flag === "--forms") {
      args.forms = value().split(",").map((f) => f.trim()) as Form[]
      for (const form of args.forms) if (!FORMS.includes(form)) throw new Error(`unknown form ${form}`)
    } else if (flag === "--style") {
      args.style = value() as Style
      if (args.style !== "words" && args.style !== "numbers") throw new Error("--style is words or numbers")
    } else if (flag === "--states") args.states = Number(value())
    else if (flag === "--seed") args.seed = Number(value())
    else if (flag === "--threshold") args.threshold = Number(value())
    else if (flag === "--play") args.play = Number(value())
    else if (flag === "--late") args.late = Number(value())
    else if (flag === "--cache") args.cache = value()
    else if (flag === "--json") args.json = value()
    else if (flag === "--help" || flag === "-h") {
      console.log("usage: agreement --server NAME=URL [--server ...] [--forms where,low,danger,noul,choice] " +
        "[--style words|numbers] [--states 300] [--seed 1] [--threshold 0.5] [--play 0] [--late 2] " +
        "[--cache agreement-cache.json] [--json out.json]")
      process.exit(0)
    } else throw new Error(`unknown argument ${flag}`)
  }
  if (!args.servers.length) throw new Error("give at least one --server NAME=URL")
  return args
}

/* ---- the screens ---------------------------------------------------------------- */

/* Rounds on seeds seed, seed+1, ...: flown by the oracle as it is, and with
   one decision in ten, five and three flipped, so the screens also include
   the ones a model that errs ends up in. Every fifth question is kept, so two
   kept screens are 15 steps apart and not near copies of each other. The set
   is balanced: as many screens where the oracle flaps as where it glides, or
   an answer that always glides would look right most of the time. */
export function sampleScreens(count: number, seed: number): Sample[] {
  const half = Math.ceil(count / 2)
  const flaps: Sample[] = []
  const glides: Sample[] = []
  const noises = [0, 0.1, 0.2, 0.3]
  for (let round = 0; flaps.length < half || glides.length < half; round++) {
    const { samples } = playRound(seed + round, { noise: noises[round % noises.length], maxSteps: 1500 })
    for (let i = round % 5; i < samples.length; i += 5) {
      const bucket = samples[i].oracle ? flaps : glides
      if (bucket.length < half) bucket.push(samples[i])
    }
  }
  return [...flaps, ...glides]
}

/* ---- asking, with a cache ----------------------------------------------------- */

export type Cache = Record<string, { response: SystemOneResponse; ms: number }>

export class Asker {
  cache: Cache
  sent = 0
  times: Record<string, number[]> = {}
  tokens: Record<string, number[]> = {}
  constructor(private readonly path: string) {
    try { this.cache = JSON.parse(readFileSync(path, "utf8")) as Cache } catch { this.cache = {} }
  }
  save() { writeFileSync(this.path, JSON.stringify(this.cache)) }

  async ask(server: Args["servers"][number], state: string, form: Form,
    questions: Record<string, SystemOneQuestion> = buildQuestions(form)): Promise<SystemOneResponse> {
    const key = `${server.url}\n${state}\n${JSON.stringify(questions)}`
    const hit = this.cache[key]
    if (hit) return hit.response
    const started = performance.now()
    const reply = await askSystemOne(server.url, server.key, { model: server.name, state, questions })
    const ms = performance.now() - started
    this.cache[key] = { response: reply.response, ms }
    this.sent += 1
    ;(this.times[server.name] ??= []).push(ms)
    if (reply.response.usage) (this.tokens[server.name] ??= []).push(reply.response.usage.input_tokens)
    if (this.sent % 50 === 0) this.save()
    return reply.response
  }
}

/* ---- scoring ------------------------------------------------------------------- */

export interface Tally { n: number; right: number; flaps: number; flapsRight: number; glides: number; glidesRight: number }
export const tally = (): Tally => ({ n: 0, right: 0, flaps: 0, flapsRight: 0, glides: 0, glidesRight: 0 })
export function count(t: Tally, oracle: boolean, flap: boolean) {
  t.n += 1
  if (oracle === flap) t.right += 1
  if (oracle) { t.flaps += 1; if (flap) t.flapsRight += 1 } else { t.glides += 1; if (!flap) t.glidesRight += 1 }
}
export const pct = (a: number, b: number) => (b ? `${((100 * a) / b).toFixed(1)}%` : "-")
export const median = (values: number[]) => {
  if (!values.length) return NaN
  const sorted = [...values].sort((a, b) => a - b)
  return sorted[Math.floor(sorted.length / 2)]
}

/* One headless round flown by a model: ask about the screen, run `late` steps
   without the answer, apply it on the next step, ask again. */
async function flyRound(asker: Asker, server: Args["servers"][number], seed: number, form: Form, args: Args) {
  const world = createWorld(seed)
  world.phase = "playing"
  const agree = tally()
  while (world.phase === "playing" && world.tick < 20000) {
    const o: Observation = observe(world)
    const { p } = readAnswer(await asker.ask(server, describeState(o, args.style), form), form)
    const flap = shouldFlap(p, args.threshold)
    count(agree, oracleFlap(o), flap)
    for (let i = 0; i < args.late && world.phase === "playing"; i++) step(world, false)
    if (world.phase === "playing") step(world, flap)
  }
  return { score: world.score, steps: world.tick, cause: world.cause, agree }
}

async function main() {
  const args = parseArgs(process.argv.slice(2))
  const asker = new Asker(args.cache)
  const screens = sampleScreens(args.states, args.seed)
  const flapShare = screens.filter((s) => s.oracle).length
  console.log(`${screens.length} screens from seeded rounds (seed ${args.seed}+), oracle says flap on ${flapShare} ` +
    `(${pct(flapShare, screens.length)}); style ${args.style}; flap when p > ${args.threshold}`)
  const texts = new Set(screens.map((s) => describeState(s.observation, args.style)))
  console.log(`${texts.size} distinct descriptions`)

  const results: Record<string, Record<string, unknown>> = {}
  try {
    /* The servers are asked side by side, each one question at a time. */
    await Promise.all(args.servers.map(async (server) => {
      for (const form of args.forms) {
        const t = tally()
        for (const screen of screens) {
          const { p } = readAnswer(await asker.ask(server, describeState(screen.observation, args.style), form), form)
          count(t, screen.oracle, shouldFlap(p, args.threshold))
        }
        ;(results[server.name] ??= {})[form] = { agreement: t }
      }
    }))

    console.log("\nagreement with the oracle (flap right = of the screens where the oracle flaps)")
    console.log("server     form     n     agree    flap right  glide right")
    for (const server of args.servers) {
      for (const form of args.forms) {
        const t = (results[server.name][form] as { agreement: Tally }).agreement
        console.log(`${server.name.padEnd(10)} ${form.padEnd(7)} ${String(t.n).padStart(4)}  ${pct(t.right, t.n).padStart(6)}` +
          `   ${pct(t.flapsRight, t.flaps).padStart(6)}      ${pct(t.glidesRight, t.glides).padStart(6)}`)
      }
    }

    if (args.play > 0) {
      console.log(`\n${args.play} rounds each, flown headless, answers landing ${args.late} steps late`)
      await Promise.all(args.servers.map(async (server) => {
        for (const form of args.forms) {
          const scores: number[] = []
          const causes: Record<string, number> = {}
          const agree = tally()
          for (let r = 0; r < args.play; r++) {
            const round = await flyRound(asker, server, 1_000_000 + args.seed + r, form, args)
            scores.push(round.score)
            causes[round.cause ?? "none"] = (causes[round.cause ?? "none"] ?? 0) + 1
            for (const key of Object.keys(agree) as Array<keyof Tally>) agree[key] += round.agree[key]
          }
          ;(results[server.name][form] as Record<string, unknown>).play = { scores, causes, agreement: agree }
        }
      }))
      console.log("server     form     median  mean   best  scores                       agree in flight")
      for (const server of args.servers) {
        for (const form of args.forms) {
          const play = (results[server.name][form] as { play: { scores: number[]; agreement: Tally } }).play
          const mean = play.scores.reduce((a, b) => a + b, 0) / play.scores.length
          console.log(`${server.name.padEnd(10)} ${form.padEnd(7)} ${String(median(play.scores)).padStart(6)}  ` +
            `${mean.toFixed(1).padStart(5)}  ${String(Math.max(...play.scores)).padStart(4)}  ` +
            `${play.scores.join(" ").padEnd(28)} ${pct(play.agreement.right, play.agreement.n)}`)
        }
      }
    }

    console.log(`\n${asker.sent} requests sent (the rest from the cache)`)
    for (const server of args.servers) {
      const times = asker.times[server.name] ?? []
      const tokens = asker.tokens[server.name] ?? []
      if (times.length) {
        console.log(`${server.name}: ${times.length} requests, median ${median(times).toFixed(0)} ms, ` +
          `median ${median(tokens)} input tokens`)
      }
    }
  } finally {
    asker.save()
  }
  if (args.json) writeFileSync(args.json, JSON.stringify({ args, results }, null, 2))
}

main().catch((error) => {
  console.error(error instanceof Error ? error.message : error)
  process.exit(1)
})
