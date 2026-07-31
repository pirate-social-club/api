import { describe, expect, test } from "bun:test"
import { gradeSayItBack } from "../../../src/lib/posts/post-study-recall-grading"

// Calibration caveat: the phonetic budget `max(2, min(floor(0.15 * length), 4))`
// is pinned from both sides with a one-phoneme margin — "love"/"loved" is
// accepted at distance 2 (length 5, budget 2) while "i love you"/"i hate you"
// is rejected at distance 3 (length 6, budget 2). A single trailing consonant
// costs 2.0 in phonemeDistance, so the floor-2 budget deliberately lets tense
// errors on short lines ("close"/"closed", "love"/"loved") grade correct. That
// is a leniency trade, not an oversight; the cap-4 budget keeps long lines from
// absorbing semantic inversions (always/never costs 4 after plural-stemming
// "always" -> "alway", so the reject below needs length <= 26 for budget 3).

describe("gradeSayItBack phonetic acceptance", () => {
  // Measured with karaoke-runtime phoneticStreamSimilarity:
  //   shoo-be-doo/shooby doo:  d=0  len=6  budget=2 (word fragmentation)
  //   what I said/what I say:  d=2  len=20 budget=3
  //   close/closed:            d=2  len=12 budget=2
  //   love/loved:              d=2  len=5  budget=2
  const acceptRows = [
    { reference: "Shoo-be-doo", transcript: "shooby doo" },
    { reference: "But you are all I love, what I said", transcript: "But you are all I love, what I say" },
    { reference: "hold me close", transcript: "hold me closed" },
    { reference: "love", transcript: "loved" },
  ]

  for (const { reference, transcript } of acceptRows) {
    test(`accepts phonetic near-miss ${JSON.stringify(transcript)} as hard with no feedback`, () => {
      const grade = gradeSayItBack({ attemptNumber: 1, reference, sourceLanguage: "en", transcript })
      expect(grade.correct).toBe(true)
      expect(grade.rating).toBe("hard")
      expect(grade.feedback).toBeUndefined()
    })
  }

  test("phonetic acceptance rates hard even on later attempts", () => {
    const grade = gradeSayItBack({ attemptNumber: 3, reference: "love", sourceLanguage: "en", transcript: "loved" })
    expect(grade.correct).toBe(true)
    expect(grade.rating).toBe("hard")
    expect(grade.feedback).toBeUndefined()
  })
})

describe("gradeSayItBack phonetic rejection", () => {
  // Measured with karaoke-runtime phoneticStreamSimilarity:
  //   i love you/i hate you: d=3  len=6  budget=2 (semantic swap)
  //   always/never swap:     d=4  len=24 budget=3 (semantic inversion)
  //   unrelated transcript:  d=18 len=19 budget=2
  test("rejects a semantic swap on a short line", () => {
    const grade = gradeSayItBack({ attemptNumber: 1, reference: "i love you", sourceLanguage: "en", transcript: "i hate you" })
    expect(grade.correct).toBe(false)
    expect(grade.rating).toBe("again")
    expect(grade.feedback).toEqual({
      matched: ["i", "you"],
      missing: ["love"],
      extra: ["hate"],
    })
  })

  test("rejects an always/never inversion on a long line", () => {
    const grade = gradeSayItBack({
      attemptNumber: 1,
      reference: "I will always hold you close through the night",
      sourceLanguage: "en",
      transcript: "I will never hold you close through the night",
    })
    expect(grade.correct).toBe(false)
    expect(grade.rating).toBe("again")
    expect(grade.feedback?.missing).toEqual(["alway"])
    expect(grade.feedback?.extra).toEqual(["never"])
  })

  test("rejects a clearly unrelated transcript", () => {
    const grade = gradeSayItBack({
      attemptNumber: 1,
      reference: "Shoo-be-doo",
      sourceLanguage: "en",
      transcript: "the quick brown fox jumps over",
    })
    expect(grade.correct).toBe(false)
    expect(grade.rating).toBe("again")
    expect(grade.feedback?.missing).toEqual(["shoo", "be", "doo"])
    expect(grade.feedback?.extra?.length).toBeGreaterThan(0)
  })

  test("never applies phonetics for non-English source languages", () => {
    // The same close/closed pair that passes phonetically for English must
    // stay incorrect when the source language gate excludes phonetics.
    const grade = gradeSayItBack({ attemptNumber: 1, reference: "hold me close", sourceLanguage: "es", transcript: "hold me closed" })
    expect(grade.correct).toBe(false)
    expect(grade.rating).toBe("again")
    expect(grade.feedback).toEqual({
      matched: ["hold", "me"],
      missing: ["close"],
      extra: ["closed"],
    })
  })
})

describe("gradeSayItBack exact matches", () => {
  test("exact match keeps good rating on the first attempt and reports no feedback", () => {
    const grade = gradeSayItBack({
      attemptNumber: 1,
      reference: "I was lost in the midnight waves",
      sourceLanguage: "en",
      transcript: "I was lost in the midnight waves",
    })
    expect(grade.correct).toBe(true)
    expect(grade.rating).toBe("good")
    expect(grade.feedback).toBeUndefined()
  })

  test("plural stemming is exact at the token layer and never reaches phonetics", () => {
    const grade = gradeSayItBack({ attemptNumber: 1, reference: "fire", sourceLanguage: "en", transcript: "fires" })
    expect(grade.correct).toBe(true)
    expect(grade.rating).toBe("good")
    expect(grade.feedback).toBeUndefined()
  })
})

describe("gradeSayItBack apostrophe-less contractions", () => {
  const contractionRows = [
    { reference: "i do not know", transcript: "i dont know" },
    { reference: "i can not swim", transcript: "i cant swim" },
    { reference: "i will not go", transcript: "i wont go" },
    { reference: "it is not fair", transcript: "it isnt fair" },
    { reference: "they are not here", transcript: "they arent here" },
    { reference: "she does not mind", transcript: "she doesnt mind" },
    { reference: "he did not call", transcript: "he didnt call" },
    { reference: "we could not stay", transcript: "we couldnt stay" },
    { reference: "you should not run", transcript: "you shouldnt run" },
    { reference: "i would not lie", transcript: "i wouldnt lie" },
    { reference: "i am ready", transcript: "im ready" },
    { reference: "i have seen it", transcript: "ive seen it" },
    { reference: "i will wait", transcript: "ill wait" },
    { reference: "i would go", transcript: "id go" },
    { reference: "do not stop", transcript: "Dont stop" },
  ]

  for (const { reference, transcript } of contractionRows) {
    test(`expands ${JSON.stringify(transcript)} to an exact match`, () => {
      const grade = gradeSayItBack({ attemptNumber: 1, reference, sourceLanguage: "en", transcript })
      expect(grade.correct).toBe(true)
      expect(grade.rating).toBe("good")
      expect(grade.feedback).toBeUndefined()
    })
  }

  test("apostrophe forms still expand alongside apostrophe-less forms", () => {
    const grade = gradeSayItBack({ attemptNumber: 1, reference: "i can not swim", sourceLanguage: "en", transcript: "I can't swim" })
    expect(grade.correct).toBe(true)
    expect(grade.rating).toBe("good")
    expect(grade.feedback).toBeUndefined()
  })

  test("unexpanded apostrophe n't forms are caught by the phonetic path instead", () => {
    // expandEnglishContractions only special-cases can't/won't with an
    // apostrophe; "don't" survives the token layer (token "dont") but the
    // phonetic stream still matches "do not".
    const grade = gradeSayItBack({ attemptNumber: 1, reference: "i do not know", sourceLanguage: "en", transcript: "I don't know" })
    expect(grade.correct).toBe(true)
    expect(grade.rating).toBe("hard")
    expect(grade.feedback).toBeUndefined()
  })
})
