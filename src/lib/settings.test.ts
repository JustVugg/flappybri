import { describe, expect, it } from "vitest"

import {
  DEFAULTS, MATCH_MIN, SETTINGS_KEY, SETTINGS_VERSION, SPEEDS, formatSpeed, loadSettings, matchSpeed, parseSettings, saveSettings,
} from "./settings"

const memory = (initial: Record<string, string> = {}) => {
  const items = new Map(Object.entries(initial))
  return {
    getItem: (key: string) => items.get(key) ?? null,
    setItem: (key: string, value: string) => { items.set(key, value) },
    items,
  }
}

describe("settings", () => {
  it("start from the defaults: the where question, the state in words", () => {
    expect(DEFAULTS).toEqual({
      mode: "human", form: "where", style: "words", threshold: 0.5, speed: SPEEDS.length - 1, match: true, autoRestart: true,
    })
    expect(loadSettings(memory())).toEqual(DEFAULTS)
    expect(loadSettings(undefined)).toEqual(DEFAULTS)
  })

  it("load what the previous version saved", () => {
    /* exactly what the page wrote before: no version, no style */
    const old = { mode: "model", form: "noul", threshold: 0.65, speed: 3, match: false, autoRestart: false }
    expect(loadSettings(memory({ [SETTINGS_KEY]: JSON.stringify(old) }))).toEqual({
      mode: "model", form: "where", style: "words", threshold: 0.65, speed: 3, match: false, autoRestart: false,
    })
    /* "noul" was the old default, saved for everyone; "choice" was always picked by hand */
    expect(parseSettings({ ...old, form: "choice" }).form).toBe("choice")
    expect(parseSettings({ mode: "model" })).toEqual({ ...DEFAULTS, mode: "model" })
  })

  it("keep every form and style once saved by this version", () => {
    for (const form of ["low", "where", "danger", "noul", "choice"]) {
      expect(parseSettings({ version: SETTINGS_VERSION, form }).form).toBe(form)
    }
    expect(parseSettings({ version: SETTINGS_VERSION, style: "numbers" }).style).toBe("numbers")
  })

  it("replace anything unreadable with the default", () => {
    expect(parseSettings({
      version: SETTINGS_VERSION, mode: "robot", form: "maybe", style: "pictures", threshold: 1.5,
      speed: SPEEDS.length, match: "yes", autoRestart: 1,
    })).toEqual(DEFAULTS)
    expect(parseSettings({ speed: 2.5, threshold: 0 })).toEqual(DEFAULTS)
    expect(parseSettings(null)).toEqual(DEFAULTS)
    expect(parseSettings("model")).toEqual(DEFAULTS)
    expect(loadSettings(memory({ [SETTINGS_KEY]: "{not json" }))).toEqual(DEFAULTS)
    expect(loadSettings({ getItem: () => { throw new Error("blocked") } })).toEqual(DEFAULTS)
  })

  it("save with the version, and load back the same", () => {
    const storage = memory()
    const settings = { ...DEFAULTS, mode: "model" as const, form: "where" as const, style: "numbers" as const, threshold: 0.35 }
    saveSettings(storage, settings)
    expect(JSON.parse(storage.items.get(SETTINGS_KEY)!)).toEqual({ version: 2, ...settings })
    expect(loadSettings(storage)).toEqual(settings)
    /* a version 2 "noul" is a choice, and stays */
    saveSettings(storage, { ...settings, form: "noul" })
    expect(loadSettings(storage).form).toBe("noul")
    expect(() => saveSettings({ setItem: () => { throw new Error("full") } }, settings)).not.toThrow()
  })
})

describe("matching the model's pace", () => {
  it("gives about two steps per decision, from real time down to a thousandth of it", () => {
    expect(matchSpeed(20, 2)).toBe(1)                       // fast: real time, never faster
    expect(matchSpeed(500, 2)).toBeCloseTo(2 / 30)           // two steps in half a second
    expect(matchSpeed(5000, 2)).toBeCloseTo(2 / 300)         // below the slider's 0.01x
    expect(matchSpeed(5000, 2) * 60 * 5).toBeCloseTo(2)
    expect(matchSpeed(60_000, 2)).toBe(MATCH_MIN)
    expect(MATCH_MIN).toBeLessThan(SPEEDS[0])
  })

  it("shows speeds with the decimals they need", () => {
    expect([formatSpeed(1), formatSpeed(0.75), formatSpeed(0.5), formatSpeed(0.05), formatSpeed(0.0067), formatSpeed(0.001)])
      .toEqual(["1.0", "0.75", "0.5", "0.05", "0.007", "0.001"])
  })
})
