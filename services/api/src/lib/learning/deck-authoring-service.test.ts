import { describe, expect, test } from "bun:test"
import {
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
})
