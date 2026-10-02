import { describe, expect, it } from "vitest"

import { DICTS, LOCALES, detectLocale, interpolate } from "./index"
import en from "./en"

/* The `t` interpolator only understands the double-brace form, `{{name}}`
 * (see interpolate() in index.ts). A single-brace `{name}` is left verbatim,
 * so it would reach the page as literal text. Keep every placeholder in the
 * {{name}} form. */
describe("locale dictionaries", () => {
  for (const [code, dict] of Object.entries(DICTS)) {
    it(`${code} uses the {{name}} placeholder form only`, () => {
      const bad: string[] = []
      for (const [key, value] of Object.entries(dict)) {
        for (const run of value.match(/\{+\w+\}+/g) ?? []) {
          if (!run.startsWith("{{") || !run.endsWith("}}")) bad.push(`${key}: ${value}`)
        }
      }
      expect(bad).toEqual([])
    })
  }

  it("every non-English key also exists in English so the fallback resolves", () => {
    const missing: string[] = []
    for (const [code, dict] of Object.entries(DICTS)) {
      if (code === "en") continue
      for (const key of Object.keys(dict)) if (!(key in en)) missing.push(`${code}: ${key}`)
    }
    expect(missing).toEqual([])
  })

  /* FlappyBri is translated in full in every locale: the game, the connection
     panel and the page around them. */
  it("carries every string in every locale", () => {
    const keys = Object.keys(en)
    expect(keys.filter((key) => key.startsWith("flappy.")).length).toBeGreaterThan(50)
    expect(keys.filter((key) => key.startsWith("conn.")).length).toBeGreaterThan(10)
    for (const [code, dict] of Object.entries(DICTS)) {
      expect(keys.filter((key) => !(key in dict)), code).toEqual([])
    }
  })

  it("uses the same placeholders as English in every translation", () => {
    const names = (value: string) => [...value.matchAll(/\{\{(\w+)\}\}/g)].map((m) => m[1]).sort()
    const wrong: string[] = []
    for (const [code, dict] of Object.entries(DICTS)) {
      for (const [key, value] of Object.entries(dict)) {
        if (names(value).join() !== names(en[key] ?? "").join()) wrong.push(`${code}: ${key}`)
      }
    }
    expect(wrong).toEqual([])
  })

  it("lists every dictionary in the language switch", () => {
    expect(LOCALES.map((l) => l.code).sort()).toEqual(Object.keys(DICTS).sort())
  })
})

describe("choosing the language", () => {
  it("keeps a saved choice, then follows the browser, then falls back to English", () => {
    expect(detectLocale("it", "de-DE")).toBe("it")
    expect(detectLocale("xx", "de-DE")).toBe("de")
    expect(detectLocale(null, "it")).toBe("it")
    expect(detectLocale(null, "zh-TW")).toBe("zh-TW")
    expect(detectLocale(null, "zh-Hant-HK")).toBe("zh-TW")
    expect(detectLocale(null, "zh-SG")).toBe("zh-CN")
    expect(detectLocale(null, "id-ID")).toBe("id")
    expect(detectLocale(null, "fr-FR")).toBe("en")
    expect(detectLocale(null, "")).toBe("en")
  })

  it("fills {{name}} placeholders and leaves unknown ones visible", () => {
    expect(interpolate("Score {{score}}, best {{best}}", { score: 3, best: 9 })).toBe("Score 3, best 9")
    expect(interpolate("seed {{seed}}", {})).toBe("seed {{seed}}")
    expect(interpolate("plain")).toBe("plain")
  })
})
