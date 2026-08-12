import { describe, expect, test } from "bun:test"

import {
  EFP_KNOWN_HOSTED_DIVERGENCES,
  isEfpKnownHostedDivergence,
} from "./known-divergences"

describe("known hosted EFP divergences", () => {
  test("contains only exact, reviewed list-target exceptions", () => {
    expect(EFP_KNOWN_HOSTED_DIVERGENCES).toHaveLength(17)
    expect(isEfpKnownHostedDivergence(
      "44",
      "0xd178221f778a3f06a8fa98c9804ef68548639514",
    )).toBe(true)
    expect(isEfpKnownHostedDivergence(
      "45",
      "0xd178221f778a3f06a8fa98c9804ef68548639514",
    )).toBe(false)
    expect(isEfpKnownHostedDivergence(
      "44718",
      "0x0008906ca2e1d42dfb6bbcda7f9b709a0cfa8dfc",
    )).toBe(true)
  })
})
