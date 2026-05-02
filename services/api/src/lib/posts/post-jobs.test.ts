import { describe, expect, test } from "bun:test"
import { embedRecheckIntervalMs } from "./post-jobs"
import type { Post } from "../../types"

type PostEmbed = NonNullable<Post["embeds"]>[number]

function embed(provider: PostEmbed["provider"], status?: string | null): PostEmbed {
  return {
    embed: `emb_${provider}`,
    embed_key: `${provider}:example`,
    provider,
    provider_ref: "example",
    canonical_url: "https://example.test/market",
    original_url: "https://example.test/market",
    state: "embed",
    preview: status === undefined ? null : { status },
    oembed_html: null,
    oembed_cache_age: null,
    unavailable_reason: null,
    last_checked_at: null,
  } as PostEmbed
}

describe("post embed recheck intervals", () => {
  test("uses a short interval for active prediction markets", () => {
    expect(embedRecheckIntervalMs(embed("kalshi", "open"))).toBe(5 * 60 * 1000)
    expect(embedRecheckIntervalMs(embed("polymarket", "active"))).toBe(5 * 60 * 1000)
    expect(embedRecheckIntervalMs(embed("kalshi", null))).toBe(5 * 60 * 1000)
  })

  test("keeps a daily interval for closed prediction markets and static embeds", () => {
    expect(embedRecheckIntervalMs(embed("kalshi", "closed"))).toBe(24 * 60 * 60 * 1000)
    expect(embedRecheckIntervalMs(embed("polymarket", "settled"))).toBe(24 * 60 * 60 * 1000)
    expect(embedRecheckIntervalMs(embed("x"))).toBe(24 * 60 * 60 * 1000)
    expect(embedRecheckIntervalMs(embed("youtube"))).toBe(24 * 60 * 60 * 1000)
  })
})
