import { describe, expect, test } from "bun:test"

import { assertPostCreateRequest } from "./post-create-validation"
import type { CreatePostRequest, RoyaltyAllocationRequest } from "../../types"

const COMMUNITY_ID = "com_test"

function allocation(overrides: Partial<RoyaltyAllocationRequest> = {}): RoyaltyAllocationRequest {
  return {
    recipient_kind: "collaborator",
    wallet_address: "0x1111111111111111111111111111111111111111",
    share_bps: 1000,
    ...overrides,
  }
}

function validSplit(): RoyaltyAllocationRequest[] {
  return [
    allocation({ recipient_kind: "creator", wallet_address: "0xaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaa", share_bps: 9000 }),
    allocation({ recipient_kind: "collaborator", wallet_address: "0xbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbb", share_bps: 1000 }),
  ]
}

function songRequest(royalty_allocations?: RoyaltyAllocationRequest[] | null): CreatePostRequest {
  return {
    idempotency_key: "idem_song",
    post_type: "song",
    identity_mode: "public",
    song_artifact_bundle: "sab_1",
    license_preset: "commercial-use",
    royalty_allocations,
  } as CreatePostRequest
}

function lockedVideoRequest(royalty_allocations?: RoyaltyAllocationRequest[] | null): CreatePostRequest {
  return {
    idempotency_key: "idem_video",
    post_type: "video",
    media_refs: [{ storage_ref: "s_1", mime_type: "video/mp4" }],
    access_mode: "locked",
    license_preset: "commercial-use",
    royalty_allocations,
  } as CreatePostRequest
}

function linkRequest(link_url: string): CreatePostRequest {
  return {
    idempotency_key: "idem_link",
    post_type: "link",
    identity_mode: "public",
    link_url,
  } as CreatePostRequest
}

describe("assertPostCreateRequest link_url scheme", () => {
  test("rejects a javascript: scheme (would be an XSS sink when rendered as href)", () => {
    expect(() => assertPostCreateRequest(linkRequest("javascript:alert(document.domain)"), COMMUNITY_ID)).toThrow(/valid http/)
  })
  test("rejects a data: scheme", () => {
    expect(() => assertPostCreateRequest(linkRequest("data:text/html,<script>alert(1)</script>"), COMMUNITY_ID)).toThrow(/valid http/)
  })
  test("accepts a normal https URL", () => {
    expect(() => assertPostCreateRequest(linkRequest("https://example.com/article"), COMMUNITY_ID)).not.toThrow()
  })
})

describe("assertPostCreateRequest age_gate_policy", () => {
  test("accepts omitted, none, and 18_plus author declarations", () => {
    expect(() => assertPostCreateRequest({
      idempotency_key: "idem_text_omitted",
      post_type: "text",
      title: "plain",
    } as CreatePostRequest, COMMUNITY_ID)).not.toThrow()
    expect(() => assertPostCreateRequest({
      idempotency_key: "idem_text_none",
      post_type: "text",
      title: "plain",
      age_gate_policy: "none",
    } as CreatePostRequest, COMMUNITY_ID)).not.toThrow()
    expect(() => assertPostCreateRequest({
      idempotency_key: "idem_text_adult",
      post_type: "text",
      title: "plain",
      age_gate_policy: "18_plus",
    } as CreatePostRequest, COMMUNITY_ID)).not.toThrow()
  })

  test("rejects unsupported author age gate declarations", () => {
    expect(() => assertPostCreateRequest({
      idempotency_key: "idem_text_bad",
      post_type: "text",
      title: "plain",
      age_gate_policy: "13_plus",
    } as unknown as CreatePostRequest, COMMUNITY_ID)).toThrow(/age_gate_policy/)
  })
})

describe("assertPostCreateRequest royalty_allocations", () => {
  test("accepts a valid creator+collaborator split on a song", () => {
    expect(() => assertPostCreateRequest(songRequest(validSplit()), COMMUNITY_ID)).not.toThrow()
  })

  test("accepts a valid split on a locked video", () => {
    expect(() => assertPostCreateRequest(lockedVideoRequest(validSplit()), COMMUNITY_ID)).not.toThrow()
  })

  test("accepts an omitted split (single-owner stays untouched)", () => {
    expect(() => assertPostCreateRequest(songRequest(undefined), COMMUNITY_ID)).not.toThrow()
    expect(() => assertPostCreateRequest(songRequest(null), COMMUNITY_ID)).not.toThrow()
  })

  test("rejects an empty allocations array", () => {
    expect(() => assertPostCreateRequest(songRequest([]), COMMUNITY_ID)).toThrow(/non-empty/)
  })

  test("rejects zero creators", () => {
    expect(() => assertPostCreateRequest(songRequest([
      allocation({ recipient_kind: "collaborator", wallet_address: "0xaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaa", share_bps: 5000 }),
      allocation({ recipient_kind: "collaborator", wallet_address: "0xbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbb", share_bps: 5000 }),
    ]), COMMUNITY_ID)).toThrow(/exactly one creator/)
  })

  test("rejects two creators", () => {
    expect(() => assertPostCreateRequest(songRequest([
      allocation({ recipient_kind: "creator", wallet_address: "0xaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaa", share_bps: 5000 }),
      allocation({ recipient_kind: "creator", wallet_address: "0xbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbb", share_bps: 5000 }),
    ]), COMMUNITY_ID)).toThrow(/exactly one creator/)
  })

  test("rejects shares that do not total 10000 bps", () => {
    expect(() => assertPostCreateRequest(songRequest([
      allocation({ recipient_kind: "creator", wallet_address: "0xaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaa", share_bps: 9000 }),
      allocation({ recipient_kind: "collaborator", wallet_address: "0xbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbb", share_bps: 500 }),
    ]), COMMUNITY_ID)).toThrow(/total 10000/)
  })

  test("rejects out-of-range or non-integer share_bps", () => {
    for (const bad of [0, 10001, 1000.5]) {
      expect(() => assertPostCreateRequest(songRequest([
        allocation({ recipient_kind: "creator", wallet_address: "0xaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaa", share_bps: 10000 - (bad as number) }),
        allocation({ recipient_kind: "collaborator", wallet_address: "0xbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbb", share_bps: bad as number }),
      ]), COMMUNITY_ID)).toThrow(/share_bps/)
    }
  })

  test("rejects more than 10 recipients", () => {
    const allocations = [allocation({ recipient_kind: "creator", wallet_address: "0xaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaa", share_bps: 9000 })]
    for (let index = 0; index < 10; index += 1) {
      allocations.push(allocation({ wallet_address: `0x${String(index).padStart(40, "c")}`, share_bps: 100 }))
    }
    expect(() => assertPostCreateRequest(songRequest(allocations), COMMUNITY_ID)).toThrow(/at most 10/)
  })

  test("rejects duplicate wallet addresses (case-insensitive)", () => {
    expect(() => assertPostCreateRequest(songRequest([
      allocation({ recipient_kind: "creator", wallet_address: "0xAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAA", share_bps: 9000 }),
      allocation({ recipient_kind: "collaborator", wallet_address: "0xaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaa", share_bps: 1000 }),
    ]), COMMUNITY_ID)).toThrow(/unique/)
  })

  test("rejects an invalid EVM address", () => {
    expect(() => assertPostCreateRequest(songRequest([
      allocation({ recipient_kind: "creator", wallet_address: "not-an-address", share_bps: 9000 }),
      allocation({ recipient_kind: "collaborator", wallet_address: "0xbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbb", share_bps: 1000 }),
    ]), COMMUNITY_ID)).toThrow(/EVM address/)
  })

  test("rejects a collaborator split on a non-royalty-bearing license", () => {
    const request = songRequest(validSplit())
    request.license_preset = "non-commercial"
    expect(() => assertPostCreateRequest(request, COMMUNITY_ID)).toThrow(/commercial license/)
  })

  test("rejects allocations on a public (non-locked) video", () => {
    const request = lockedVideoRequest(validSplit())
    request.access_mode = "public"
    request.license_preset = null
    expect(() => assertPostCreateRequest(request, COMMUNITY_ID)).toThrow(/locked video/)
  })

  test("rejects allocations on a non-asset post type", () => {
    expect(() => assertPostCreateRequest({
      idempotency_key: "idem_text",
      post_type: "text",
      title: "hi",
      royalty_allocations: validSplit(),
    } as CreatePostRequest, COMMUNITY_ID)).toThrow(/song and video/)
  })
})

describe("assertPostCreateRequest listing_draft", () => {
  test("accepts server-side listing inputs in sync song publish mode", () => {
    expect(() => assertPostCreateRequest({
      idempotency_key: "sync-paid-song",
      post_type: "song",
      identity_mode: "public",
      song_artifact_bundle: "sab_1",
      license_preset: "commercial-use",
      listing_draft: {
        price_cents: 499,
        regional_pricing_enabled: false,
        status: "active",
      },
    } as CreatePostRequest, COMMUNITY_ID)).not.toThrow()
  })
})
