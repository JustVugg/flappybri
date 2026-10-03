import { describe, expect, it } from "vitest"

import { PIPES } from "./game"
import { ORACLE, oracleFlap, playRound, sampleScreens } from "./oracle"
import { WORDS, situation, type Observation, type WordThresholds } from "./pilot"

const SEEDS = Array.from({ length: 12 }, (_, i) => 101 + i * 37)
const STEPS = 3000

/* How many of the rounds on SEEDS a rule flies to the end, its answers
   landing `late` steps after the screen they were about. */
const survivors = (decide: (o: Observation) => boolean, late: number) =>
  SEEDS.filter((seed) => playRound(seed, { decide, late, maxSteps: STEPS }).steps === STEPS).length

const obs = (gapMiddle: number, speed: number): Observation => ({
  tick: 0, gapMiddle, gapTop: gapMiddle + 75, gapBottom: gapMiddle - 75, gapHeight: PIPES.gap, ahead: 100, inGap: false,
  exit: 0, speed, ground: -200, top: 300,
})

describe("the oracle", () => {
  it("flaps when, a few steps on and without a flap, the hummingbird would be in the lower third or below", () => {
    expect(ORACLE).toEqual({ line: PIPES.gap / 6, ahead: 4 })
    expect(oracleFlap(obs(80, 0))).toBe(true)          // below the opening
    expect(oracleFlap(obs(-30, 0))).toBe(false)        // upper part, still
    expect(oracleFlap(obs(5, -6))).toBe(true)          // middle, falling fast: in the lower third soon
    expect(oracleFlap(obs(40, 6.6))).toBe(false)       // lower third, just flapped: rising out of it
  })

  it("flies every round to the end when answers land 2 or 3 steps late, and most at 4", () => {
    for (const late of [2, 3]) expect(survivors(oracleFlap, late), `late ${late}`).toBe(SEEDS.length)
    expect(survivors(oracleFlap, 4)).toBeGreaterThanOrEqual(SEEDS.length - 2)
  })

  it("is not the position alone: that rule flies at 2 steps late and falls at 3", () => {
    const byPosition = (o: Observation) => o.gapMiddle > ORACLE.line
    expect(survivors(byPosition, 2)).toBe(SEEDS.length)
    expect(survivors(byPosition, 3)).toBeLessThanOrEqual(1)
  })

  it("records a sample per question, labelled by the oracle", () => {
    const round = playRound(7, { late: 2, maxSteps: 300 })
    expect(round.decisions).toBe(100)
    expect(round.samples).toHaveLength(100)
    expect(round.samples.map((s) => s.tick).slice(0, 3)).toEqual([0, 3, 6])
    for (const s of round.samples) expect(s.oracle).toBe(oracleFlap(s.observation))
    /* the same seed and options give the same round */
    expect(playRound(7, { late: 2, maxSteps: 300, noise: 0.2 })).toEqual(playRound(7, { late: 2, maxSteps: 300, noise: 0.2 }))
  })
})

describe("the screens the agreement is measured on", () => {
  it("are balanced between flap and glide, spaced out, and the same for the same seed", () => {
    const screens = sampleScreens(200, 1)
    expect(screens).toHaveLength(200)
    expect(screens.filter((s) => s.oracle)).toHaveLength(100)
    expect(sampleScreens(200, 1)).toEqual(screens)
    /* kept screens of one round are 15 steps apart */
    const first = screens.filter((s) => s.seed === screens[0].seed && s.oracle === screens[0].oracle)
    for (let i = 1; i < first.length; i++) expect((first[i].tick - first[i - 1].tick) % 15).toBe(0)
    expect(new Set(screens.map((s) => s.seed)).size).toBeGreaterThan(10)
  })
})

describe("the words can be flown on", () => {
  /* Read the plain way: flap when the words put the hummingbird lower than
     the middle of the opening, whatever else they say. */
  const LOW = new Set(["insideLow", "littleBelow", "wellBelow"])
  const reader = (w: WordThresholds) => (o: Observation) => LOW.has(situation(o, w).position)

  it("flies every round to the end when answers land 1, 2 or 3 steps late", () => {
    for (const late of [1, 2, 3]) expect(survivors(reader(WORDS), late), `late ${late}`).toBe(SEEDS.length)
  })

  it("would not, at 3 steps late, if the words said where the hummingbird is now", () => {
    expect(survivors(reader({ ...WORDS, ahead: 0 }), 3)).toBeLessThanOrEqual(2)
  })
})
