import { describe, expect, test } from "bun:test"
import type { CreatePostRequest } from "../../types"
import { hashPostCreateRequestBody, isPostCreateIdempotencyConflict } from "./post-create-idempotency"

function songRequest(overrides: Partial<CreatePostRequest> = {}): CreatePostRequest {
  return {
    idempotency_key: "idem_1",
    identity_mode: "public",
    post_type: "song",
    publish_mode: "async",
    song_artifact_bundle: "sab_1",
    title: "Track",
    access_mode: "locked",
    listing_draft: {
      price_cents: 499,
      regional_pricing_enabled: true,
      donation_partner: "don_1",
      donation_share_bps: 1000,
      status: "active",
    },
    license_preset: "commercial-use",
    rights_basis: "original",
    song_mode: "original",
    translation_policy: "machine_allowed",
    ...overrides,
  } as CreatePostRequest
}

describe("hashPostCreateRequestBody", () => {
  test("is stable across object key order and ignores agent_action_proof", async () => {
    const first = songRequest({
      agent_action_proof: { signature: "sig_a" } as never,
      listing_draft: {
        status: "active",
        donation_share_bps: 1000,
        donation_partner: "don_1",
        regional_pricing_enabled: true,
        price_cents: 499,
      },
    })
    const second = songRequest({
      agent_action_proof: { signature: "sig_b" } as never,
      listing_draft: {
        price_cents: 499,
        regional_pricing_enabled: true,
        donation_partner: "don_1",
        donation_share_bps: 1000,
        status: "active",
      },
    })

    await expect(hashPostCreateRequestBody(first)).resolves.toBe(await hashPostCreateRequestBody(second))
  })

  test("changes when finalize inputs change", async () => {
    const original = await hashPostCreateRequestBody(songRequest())
    const changedListing = await hashPostCreateRequestBody(songRequest({
      listing_draft: {
        price_cents: 599,
        regional_pricing_enabled: true,
        donation_partner: "don_1",
        donation_share_bps: 1000,
        status: "active",
      },
    }))

    expect(changedListing).not.toBe(original)
  })
})

describe("isPostCreateIdempotencyConflict", () => {
  test("rejects mismatched hashes and async reuse of legacy no-hash rows", () => {
    expect(isPostCreateIdempotencyConflict({
      existingBodyHash: "0xaaa",
      incomingBodyHash: "0xaaa",
      incomingPublishMode: "async",
    })).toBe(false)
    expect(isPostCreateIdempotencyConflict({
      existingBodyHash: "0xaaa",
      incomingBodyHash: "0xbbb",
      incomingPublishMode: "sync",
    })).toBe(true)
    expect(isPostCreateIdempotencyConflict({
      existingBodyHash: null,
      incomingBodyHash: "0xbbb",
      incomingPublishMode: "async",
    })).toBe(true)
    expect(isPostCreateIdempotencyConflict({
      existingBodyHash: null,
      incomingBodyHash: "0xbbb",
      incomingPublishMode: "sync",
    })).toBe(false)
  })
})
