import { describe, expect, it } from "bun:test"
import { readFileSync, readdirSync, statSync } from "node:fs"
import { join } from "node:path"
import { DEFAULT_OPENROUTER_MODEL } from "./openrouter-client"

const LIB_ROOT = join(import.meta.dir)
const OPENROUTER_CLIENT = join(LIB_ROOT, "openrouter-client.ts")
// The assistant policy exposes a CATALOGUE of models a community may pick between.
// Those ids are product surface, not a fallback, so they are allowed to be literals.
const MODEL_CATALOGUE = join(LIB_ROOT, "communities", "assistant-policy", "service.ts")

function sourceFiles(dir: string): string[] {
  return readdirSync(dir).flatMap((entry) => {
    const full = join(dir, entry)
    if (statSync(full).isDirectory()) {
      return sourceFiles(full)
    }
    return full.endsWith(".ts") && !full.endsWith(".test.ts") ? [full] : []
  })
}

describe("DEFAULT_OPENROUTER_MODEL", () => {
  it("is not a dated preview alias", () => {
    // Dated preview aliases are retired upstream without notice. OpenRouter
    // answers a retired id with http_404 "No endpoints found", which is not
    // transient but still burns all eight community-job retry attempts before
    // the job dies permanently.
    expect(DEFAULT_OPENROUTER_MODEL).not.toMatch(/-preview(-|$)|\d{4}-\d{2}(-\d{2})?$/)
  })

  it("is the single source of the model fallback across every provider", () => {
    // Four providers previously carried their own copy of the literal and drifted
    // apart; only one of them was updated when the preview alias was retired.
    const offenders = sourceFiles(LIB_ROOT)
      .filter((file) => file !== OPENROUTER_CLIENT && file !== MODEL_CATALOGUE)
      .filter((file) => /["']google\/gemini|["']openai\/|["']anthropic\//.test(readFileSync(file, "utf8")))

    expect(offenders.map((file) => file.slice(LIB_ROOT.length + 1))).toEqual([])
  })
})
