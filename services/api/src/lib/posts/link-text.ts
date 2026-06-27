import { decodeHTML } from "entities"

// Single source of truth for turning link metadata (title/description/publisher)
// into clean, storable text.
//
// Link metadata arrives HTML-encoded: a WordPress og:title such as
//   "Israel&#8217;s Ben &#038; Jerry"
// must be decoded to "Israel's Ben & Jerry" before we store it.
//
// Two distinct operations live here, and the distinction matters:
//
//  - decodeHtmlEntities(): turns HTML character references into text. This is a
//    single HTML-decode pass and is NOT idempotent — decoding twice keeps
//    eating references (e.g. "&amp;lt;" -> "&lt;" -> "<"). Decode each value
//    exactly once, at the source that produced the encoded text.
//
//  - clampLinkText(): whitespace-collapse + trim + length cap. This is purely a
//    formatting/length operation, takes already-decoded text, and IS
//    idempotent — safe to apply again at the persistence boundary as a backstop.
//
// IMPORTANT: stored values are decoded plain text, NOT HTML. Any output boundary
// that emits them into markup (HTML body, an attribute, an iframe title=) MUST
// re-escape there. Decode-for-storage and escape-for-output are opposite
// operations that live in different places.

/**
 * Decode HTML character references (named, decimal, and hex) into plain text.
 *
 * Delegates to the standards-complete `entities` library, so the full HTML5
 * named-reference set, multi-codepoint references, and the spec's numeric
 * remapping rules (invalid/out-of-range code points -> U+FFFD) are all handled.
 *
 * Single-pass and non-idempotent by nature — see the module note above.
 */
export function decodeHtmlEntities(value: string): string {
  return decodeHTML(value)
}

// Per-field length policies, kept separate so each can evolve independently.
// Description matches the 2000-char post-snapshot projection cap so we don't
// discard metadata that downstream would have kept; titles and publisher/site
// labels are short by nature.
export const LINK_TITLE_MAX_LENGTH = 300
export const LINK_DESCRIPTION_MAX_LENGTH = 2000
export const LINK_PUBLISHER_MAX_LENGTH = 200

/**
 * Whitespace-collapse, trim, and length-cap already-decoded text. Decode-free
 * and idempotent — safe to apply as a backstop at the persistence boundary.
 */
export function clampLinkText(
  value: string | null | undefined,
  maxLength: number,
): string | null {
  if (value == null) {
    return null
  }
  const collapsed = String(value).replace(/\s+/gu, " ").trim()
  return collapsed ? collapsed.slice(0, maxLength) : null
}

function decodeAndClamp(
  value: string | null | undefined,
  maxLength: number,
): string | null {
  if (value == null) {
    return null
  }
  return clampLinkText(decodeHtmlEntities(String(value)), maxLength)
}

export function normalizeLinkTitle(value: string | null | undefined): string | null {
  return decodeAndClamp(value, LINK_TITLE_MAX_LENGTH)
}

export function normalizeLinkDescription(value: string | null | undefined): string | null {
  return decodeAndClamp(value, LINK_DESCRIPTION_MAX_LENGTH)
}

export function normalizeLinkPublisher(value: string | null | undefined): string | null {
  return decodeAndClamp(value, LINK_PUBLISHER_MAX_LENGTH)
}

export type RawLinkMetadataText = {
  title?: string | null
  description?: string | null
  publisher?: string | null
}

export type NormalizedLinkMetadataText = {
  title: string | null
  description: string | null
  publisher: string | null
}

/**
 * Normalize a provider's raw metadata text in one call. Use this once per
 * provider result so every provider funnels through the same decode + clamp.
 */
export function normalizeLinkMetadataText(
  raw: RawLinkMetadataText,
): NormalizedLinkMetadataText {
  return {
    title: normalizeLinkTitle(raw.title),
    description: normalizeLinkDescription(raw.description),
    publisher: normalizeLinkPublisher(raw.publisher),
  }
}

/** Length caps keyed for the persistence-boundary backstop in the repository. */
export const LINK_ENRICHMENT_FIELD_LIMITS = {
  title: LINK_TITLE_MAX_LENGTH,
  description: LINK_DESCRIPTION_MAX_LENGTH,
  publisher: LINK_PUBLISHER_MAX_LENGTH,
} as const
