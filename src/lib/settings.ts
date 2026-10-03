/* The page's settings, as the browser remembers them (localStorage).
 *
 * Version 2 added the question forms that ask about the situation and the
 * style of the state (words or numbers). A version 1 object has no `version`
 * and no `style`. Its `form` is "noul" or "choice": "choice" was always picked
 * by hand and is kept; "noul" was the default, and the page saved it for
 * everyone who opened it, chosen or not, so it moves to the new default
 * question. Everything else carries over as it was. */

import { STEPS_PER_SECOND } from "./flappybri/game"
import { DEFAULT_FORM, FORMS, STYLES, type Form, type Style } from "./flappybri/pilot"

export type Mode = "human" | "model"

/* Game speed stops, from a hundredth of real time to real time. A model that
   needs a second per answer still plays at 0.01x: the pipes wait for it. */
export const SPEEDS = [0.01, 0.02, 0.05, 0.1, 0.2, 0.3, 0.5, 0.75, 1] as const

/* "Match the model's pace" goes slower than the slider: on a busy CPU a model
   can need several seconds per answer, and at 0.01x five seconds are already
   three steps, more than the words are made for. Down to a thousandth of real
   time, a model that answers in 16 s still gets about two steps per decision. */
export const MATCH_MIN = 0.001

/* The speed at which about `steps` steps pass while the model decides. */
export function matchSpeed(latencyMs: number, steps: number): number {
  return Math.min(1, Math.max(MATCH_MIN, (steps * 1000) / (latencyMs * STEPS_PER_SECOND)))
}

/* A speed as the panel shows it: two decimals, three below a hundredth. */
export function formatSpeed(speed: number): string {
  if (speed >= 0.1) return speed.toFixed(2).replace(/0$/, "")
  return speed >= 0.01 ? speed.toFixed(2) : speed.toFixed(3)
}

export const SETTINGS_KEY = "flappybri.settings"
export const SETTINGS_VERSION = 2

export interface Settings {
  mode: Mode
  form: Form
  style: Style
  threshold: number
  speed: number         // index into SPEEDS
  match: boolean        // follow the model's pace instead of the slider
  autoRestart: boolean
}

export const DEFAULTS: Settings = {
  mode: "human", form: DEFAULT_FORM, style: "words", threshold: 0.5, speed: SPEEDS.length - 1,
  match: true, autoRestart: true,
}

export function parseSettings(value: unknown): Settings {
  const raw = (value && typeof value === "object" ? value : {}) as Partial<Record<keyof Settings | "version", unknown>>
  const legacy = raw.version === undefined
  const form: Form = legacy
    ? (raw.form === "choice" ? "choice" : DEFAULT_FORM)
    : (FORMS.includes(raw.form as Form) ? raw.form as Form : DEFAULT_FORM)
  const speed = raw.speed
  return {
    mode: raw.mode === "model" ? "model" : "human",
    form,
    style: STYLES.includes(raw.style as Style) ? raw.style as Style : DEFAULTS.style,
    threshold: typeof raw.threshold === "number" && raw.threshold > 0 && raw.threshold < 1 ? raw.threshold : DEFAULTS.threshold,
    speed: typeof speed === "number" && Number.isInteger(speed) && speed >= 0 && speed < SPEEDS.length ? speed : DEFAULTS.speed,
    match: typeof raw.match === "boolean" ? raw.match : DEFAULTS.match,
    autoRestart: typeof raw.autoRestart === "boolean" ? raw.autoRestart : DEFAULTS.autoRestart,
  }
}

export function loadSettings(storage: Pick<Storage, "getItem"> | undefined): Settings {
  try {
    return parseSettings(JSON.parse(storage?.getItem(SETTINGS_KEY) || "{}"))
  } catch {
    return { ...DEFAULTS }
  }
}

export function saveSettings(storage: Pick<Storage, "setItem"> | undefined, settings: Settings) {
  try {
    storage?.setItem(SETTINGS_KEY, JSON.stringify({ version: SETTINGS_VERSION, ...settings }))
  } catch { /* private mode, blocked storage */ }
}
