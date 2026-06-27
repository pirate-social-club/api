import { describe, expect, test } from "bun:test"
import {
  LINK_DESCRIPTION_MAX_LENGTH,
  LINK_PUBLISHER_MAX_LENGTH,
  LINK_TITLE_MAX_LENGTH,
  clampLinkText,
  decodeHtmlEntities,
  normalizeLinkDescription,
  normalizeLinkMetadataText,
  normalizeLinkPublisher,
  normalizeLinkTitle,
} from "./link-text"

describe("decodeHtmlEntities", () => {
  test("decodes decimal numeric references", () => {
    expect(decodeHtmlEntities("Israel&#8217;s Ben &#038; Jerry&#8230;")).toBe(
      "Israel’s Ben & Jerry…",
    )
  })

  test("decodes hex numeric references (either case)", () => {
    expect(decodeHtmlEntities("caf&#xe9; &#X2014; bar")).toBe("café — bar")
  })

  test("decodes the full named-reference set (not just a curated subset)", () => {
    // These are exactly the references a hand-rolled map tends to miss:
    // a long-tail symbol, a Latin-1 name, and a multi-codepoint reference.
    expect(decodeHtmlEntities("&rarr; &micro; &NotEqualTilde;")).toBe("→ µ ≂̸")
    expect(decodeHtmlEntities("A &amp; B &hellip; &copy;")).toBe("A & B … ©")
    expect(decodeHtmlEntities("&Eacute;cole vs &eacute;cole")).toBe("École vs école")
  })

  test("leaves genuinely unknown references untouched", () => {
    expect(decodeHtmlEntities("&florp; &xyzzy;")).toBe("&florp; &xyzzy;")
  })

  test("maps invalid / out-of-range numeric references to U+FFFD per the HTML spec", () => {
    expect(decodeHtmlEntities("&#x110000;")).toBe("�")
    expect(decodeHtmlEntities("&#xD800;")).toBe("�")
    expect(decodeHtmlEntities("&#0;")).toBe("�")
  })

  test("is single-pass and NOT idempotent for nested references (decode exactly once)", () => {
    // "&amp;lt;" is intended to display the literal text "&lt;": one decode
    // pass yields that, a second pass would wrongly collapse it to "<".
    const once = decodeHtmlEntities("Ben &amp;lt; Jerry")
    expect(once).toBe("Ben &lt; Jerry")
    expect(decodeHtmlEntities(once)).toBe("Ben < Jerry")
  })
})

describe("clampLinkText", () => {
  test("collapses whitespace, trims, and caps length", () => {
    expect(clampLinkText("  a\n  b\t c  ", 100)).toBe("a b c")
    expect(clampLinkText("x".repeat(50), 10)).toHaveLength(10)
  })

  test("returns null for nullish / empty input", () => {
    expect(clampLinkText(null, 100)).toBeNull()
    expect(clampLinkText(undefined, 100)).toBeNull()
    expect(clampLinkText("   ", 100)).toBeNull()
  })

  test("is idempotent (no decoding) — safe as a persistence backstop", () => {
    // A literal entity must survive clamping unchanged; clamp must not decode.
    const value = clampLinkText("Ben &lt; Jerry", 100)
    expect(value).toBe("Ben &lt; Jerry")
    expect(clampLinkText(value, 100)).toBe("Ben &lt; Jerry")
  })
})

describe("normalize link fields", () => {
  test("decodes, collapses whitespace, and trims", () => {
    expect(normalizeLinkTitle("  Ben\n  &#038;\tJerry&#8217;s  ")).toBe("Ben & Jerry’s")
  })

  test("returns null for empty / whitespace-only input", () => {
    expect(normalizeLinkTitle(null)).toBeNull()
    expect(normalizeLinkDescription(undefined)).toBeNull()
    expect(normalizeLinkPublisher("")).toBeNull()
  })

  test("applies the per-field length policy after decoding", () => {
    expect(normalizeLinkTitle("a".repeat(400))).toHaveLength(LINK_TITLE_MAX_LENGTH)
    expect(normalizeLinkDescription("b".repeat(2500))).toHaveLength(LINK_DESCRIPTION_MAX_LENGTH)
    expect(normalizeLinkPublisher("c".repeat(300))).toHaveLength(LINK_PUBLISHER_MAX_LENGTH)
  })

  test("description cap matches the 2000-char snapshot projection limit", () => {
    expect(LINK_DESCRIPTION_MAX_LENGTH).toBe(2000)
  })

  test("normalizeLinkMetadataText normalizes all three fields in one call", () => {
    expect(
      normalizeLinkMetadataText({
        title: "Ben &#038; Jerry&#8217;s",
        description: "A &amp; B",
        publisher: "Days of Palestine &amp; News",
      }),
    ).toEqual({
      title: "Ben & Jerry’s",
      description: "A & B",
      publisher: "Days of Palestine & News",
    })
  })
})
