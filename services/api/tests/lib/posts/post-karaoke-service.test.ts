import { describe, expect, test } from "bun:test"

import { buildSongKaraokeLines } from "../../../src/lib/posts/post-karaoke-service"

describe("buildSongKaraokeLines", () => {
  test("classifies whole-line parentheticals as timed ad-libs", () => {
    const source = [
      "(Hoo-ooh)",
      "(Ha)",
      "(Ooh) (ooh)",
      "[Chorus]",
      "I'm in town girl for just one night",
      "body down (tonight)",
      "  (Oh baby)  ",
      "(a) and (b)",
      "()",
    ]
    const lines = buildSongKaraokeLines({
      lyrics: source.join("\n"),
      timedLyrics: {
        segments: source.map((text, index) => ({
          end_ms: (index + 1) * 1_000,
          start_ms: index * 1_000,
          text,
        })),
      },
    })

    expect(lines.map((line) => [line.text, line.kind])).toEqual([
      ["(Hoo-ooh)", "adlib"],
      ["(Ha)", "adlib"],
      ["(Ooh) (ooh)", "adlib"],
      ["[Chorus]", "section"],
      ["I'm in town girl for just one night", "lyric"],
      ["body down (tonight)", "lyric"],
      ["(Oh baby)", "adlib"],
      ["(a) and (b)", "lyric"],
      ["()", "adlib"],
    ])
    expect(lines[0]?.words).toEqual([{
      end_ms: 1_000,
      start_ms: 0,
      text: "(Hoo-ooh)",
    }])
  })

  test("groups token-stream alignment output using submitted lyric line breaks", () => {
    const lines = buildSongKaraokeLines({
      lyrics: [
        "[Intro]",
        "",
        "[Verse 1]",
        "In a house on a hill",
        "Old guitar",
      ].join("\n"),
      timedLyrics: {
        segments: [
          { text: "[Intro]", start_ms: 100, end_ms: 10_340 },
          { text: "\n", start_ms: 10_340, end_ms: 10_410 },
          { text: "[Verse 1]", start_ms: 10_420, end_ms: 20_820 },
          { text: "\n", start_ms: 20_820, end_ms: 20_920 },
          { text: "In", start_ms: 20_920, end_ms: 21_220 },
          { text: " ", start_ms: 21_220, end_ms: 21_260 },
          { text: "a", start_ms: 21_260, end_ms: 21_300 },
          { text: " ", start_ms: 21_300, end_ms: 21_360 },
          { text: "house", start_ms: 21_360, end_ms: 21_660 },
          { text: " ", start_ms: 21_660, end_ms: 21_720 },
          { text: "on", start_ms: 21_720, end_ms: 21_860 },
          { text: " ", start_ms: 21_860, end_ms: 21_920 },
          { text: "a", start_ms: 21_920, end_ms: 22_020 },
          { text: " ", start_ms: 22_020, end_ms: 22_080 },
          { text: "hill", start_ms: 22_080, end_ms: 22_420 },
          { text: "\n", start_ms: 22_420, end_ms: 22_480 },
          { text: "Old", start_ms: 42_240, end_ms: 42_900 },
          { text: " ", start_ms: 42_900, end_ms: 42_960 },
          { text: "guitar", start_ms: 42_960, end_ms: 44_180 },
        ],
      },
    })

    expect(lines.map((line) => ({
      kind: line.kind,
      text: line.text,
      words: line.words.map((word) => word.text),
    }))).toEqual([
      { kind: "section", text: "[Intro]", words: [] },
      { kind: "section", text: "[Verse 1]", words: [] },
      { kind: "lyric", text: "In a house on a hill", words: ["In", "a", "house", "on", "a", "hill"] },
      { kind: "lyric", text: "Old guitar", words: ["Old", "guitar"] },
    ])
    expect(lines[2]?.start_ms).toBe(20_920)
    expect(lines[2]?.end_ms).toBe(22_420)
    expect(lines[2]?.index).toBe(2)
  })

  test("keeps line-shaped timed lyrics as karaoke lines", () => {
    const lines = buildSongKaraokeLines({
      lyrics: "Line one\nLine two",
      timedLyrics: {
        segments: [
          { text: "Line one", start_ms: 0, end_ms: 1_800 },
          { text: "Line two", start_ms: 1_800, end_ms: 3_600 },
        ],
      },
    })

    expect(lines.map((line) => ({
      kind: line.kind,
      text: line.text,
      words: line.words.map((word) => word.text),
    }))).toEqual([
      { kind: "lyric", text: "Line one", words: ["Line one"] },
      { kind: "lyric", text: "Line two", words: ["Line two"] },
    ])
  })
})
