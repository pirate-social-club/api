import { describe, expect, test } from "bun:test"
import {
  buildCanonicalLearningDeck,
  canonicalLearningDeckJson,
  canonicalLearningDeckPackage,
  parseLearningDeckCsv,
  validateLearningDeck,
} from "./deck-package"

const card = (overrides: Partial<Parameters<typeof buildCanonicalLearningDeck>[0]["cards"][number]> = {}) => ({
  cardId: "lcd_one",
  cardType: "basic" as const,
  prompt: "Prompt",
  answer: "Answer",
  ...overrides,
})

describe("learning deck package", () => {
  test("canonicalizes keys, newlines, and tags deterministically", async () => {
    const input = { title: "Deck\r\n", description: null, cards: [card({ prompt: "A\r\n", tags: ["z", "a"] })] }
    const first = await canonicalLearningDeckPackage(input)
    const second = await canonicalLearningDeckPackage(input)
    expect(first.json).toBe(canonicalLearningDeckJson(first.deck))
    expect(first.json).toBe(second.json)
    expect(first.contentHash).toBe(second.contentHash)
    expect(first.deck.cards[0]?.tags).toEqual(["a", "z"])
  })

  test("rejects unsafe and oversized card content", () => {
    expect(validateLearningDeck({
      title: "Deck",
      cards: [card({ prompt: "\u0000" })],
    }).map((issue) => issue.code)).toContain("text_unsafe")
    expect(validateLearningDeck({
      title: "Deck",
      cards: [card({ prompt: "x".repeat(16 * 1024 + 1) })],
    }).map((issue) => issue.code)).toContain("text_too_long")
    expect(validateLearningDeck({
      title: "Deck",
      cards: [card({ answer: "javascript:alert(1)" })],
    }).map((issue) => issue.code)).toContain("active_content_detected")
  })

  test("requires exactly one c1 cloze group", () => {
    expect(validateLearningDeck({ title: "Deck", cards: [card({ cardType: "cloze", prompt: "plain" })] })
      .map((issue) => issue.code)).toContain("cloze_group_invalid")
    expect(validateLearningDeck({ title: "Deck", cards: [card({ cardType: "cloze", prompt: "{{c1::fact}}" })] }))
      .not.toContainEqual(expect.objectContaining({ code: "cloze_group_invalid" }))
  })

  test("parses quoted CSV as text and enforces bounded rows and cells", () => {
    const parsed = parseLearningDeckCsv('prompt,answer,tags\n"a,b","x""y",tag\n')
    expect(parsed.errors).toEqual([])
    expect(parsed.headers).toEqual(["prompt", "answer", "tags"])
    expect(parsed.rows).toEqual([["a,b", 'x"y', "tag"]])
    expect(parseLearningDeckCsv(`prompt,answer\n${"x".repeat(16 * 1024 + 1)},y`).errors.map((error) => error.code))
      .toContain("cell_too_long")
  })
})
