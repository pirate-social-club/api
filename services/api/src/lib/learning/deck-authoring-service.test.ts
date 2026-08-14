import { describe, expect, test } from "bun:test"
import {
  boundedLearningDeckCsvPreview,
  commitLearningDeckCsv,
  previewLearningDeckCsv,
} from "./deck-authoring-service"

describe("learning deck authoring helpers", () => {
  test("previews CSV without evaluating cell contents", () => {
    const result = previewLearningDeckCsv("prompt,answer\n=SUM(A1:A2),42\n")
    expect(result.errors).toEqual([])
    expect(result.rows[0]).toEqual(["=SUM(A1:A2)", "42"])
  })

  test("exports the CSV commit mapping contract", () => {
    expect(typeof commitLearningDeckCsv).toBe("function")
  })

  test("bounds durable CSV preview state without changing parser counts", () => {
    const result = boundedLearningDeckCsvPreview(previewLearningDeckCsv([
      "prompt,answer",
      ...Array.from({ length: 25 }, (_, index) => `Question ${index},Answer ${index}`),
    ].join("\n")))
    expect(result.rows).toHaveLength(20)
    expect(result.row_count).toBe(25)
    expect(result.error_count).toBe(0)
  })
})
