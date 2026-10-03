/* FlappyBri: a yardstick for the model, not used by the page.
 *
 * To say how often a model's answer is right, the screens need a right answer.
 * The oracle is a plain rule that plays the game well: flap when, ORACLE.ahead
 * steps from now and without a flap, the hummingbird would be in the lower
 * third of the opening or below it; glide otherwise. The ground needs no rule
 * of its own: every opening keeps PIPES.margin px above the ground, so a
 * hummingbird about to hit the ground is already below the opening.
 *
 * Why it looks ahead: an answer lands a few steps after the screen it was
 * about. A rule on the position alone (flap in the lower third or below) flies
 * every round to the end when answers land 2 steps late and loses nearly all
 * of them at 3; looking 4 steps ahead flies them all at 2 and 3 steps late and
 * most of them at 4 (oracle.test.ts).
 *
 * The screens themselves come from real rounds, played with the game's own
 * physics at the pace the page gives a model: each answer lands a few steps
 * after the screen it was about, and the next question goes out on the step
 * after that. */

import { PIPES, createWorld, nextRandom, step, type World } from "./game"
import { driftBelow, observe, type Observation } from "./pilot"

export const ORACLE = {
  /* The line: the top of the opening's lower third, below its middle. */
  line: PIPES.gap / 6,
  /* How many steps ahead it looks. */
  ahead: 4,
} as const

export const oracleFlap = (o: Observation) => driftBelow(o, ORACLE.ahead) > ORACLE.line

export interface Sample {
  seed: number
  tick: number
  observation: Observation
  oracle: boolean
}

export interface PlayOptions {
  /* Steps the world runs on before an answer lands (the page's "steps late"). */
  late?: number
  /* What decides: the oracle unless told otherwise. */
  decide?: (o: Observation) => boolean
  /* The chance that a decision is flipped, so the rounds also visit the
     screens a model that errs ends up in. */
  noise?: number
  /* A round ends at the first crash, or here. */
  maxSteps?: number
  /* Seeds the noise, apart from the world's own seed. */
  noiseSeed?: number
}

export interface Round {
  seed: number
  score: number
  steps: number
  decisions: number
  samples: Sample[]
}

/* One round, a question at a time: ask about the screen at tick t, run `late`
   steps without the answer, apply it on the next step, ask again. */
export function playRound(seed: number, options: PlayOptions = {}): Round {
  const { late = 2, decide = oracleFlap, noise = 0, maxSteps = 6000 } = options
  const world: World = createWorld(seed)
  world.phase = "playing"
  const dice = createWorld(options.noiseSeed ?? seed ^ 0x5bd1e995)
  const samples: Sample[] = []
  let decisions = 0
  while (world.phase === "playing" && world.tick < maxSteps) {
    const observation = observe(world)
    let flap = decide(observation)
    if (noise > 0 && nextRandom(dice) < noise) flap = !flap
    samples.push({ seed, tick: world.tick, observation, oracle: oracleFlap(observation) })
    decisions += 1
    for (let i = 0; i < late && world.phase === "playing"; i++) step(world, false)
    if (world.phase === "playing") step(world, flap)
  }
  return { seed, score: world.score, steps: world.tick, decisions, samples }
}
