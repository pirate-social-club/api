import { describe, expect, test } from "bun:test"
import type { CreateLiveRoomRequest } from "./types"
import { normalizeLiveRoomCreateRequest } from "./create-input"

function createRequest(overrides: CreateLiveRoomRequest = {}): CreateLiveRoomRequest {
  return {
    title: "Live",
    setlist: {
      status: "ready",
      items: [
        {
          title: "Opening song",
          rights_basis: "original",
        },
      ],
    },
    ...overrides,
  }
}

describe("normalizeLiveRoomCreateRequest", () => {
  test("normalizes live room store link fields", () => {
    const prepared = normalizeLiveRoomCreateRequest({
      hostUserId: "usr_host",
      body: createRequest({
        title: " Merch drop ",
        store_url: " https://psc-zim-shop.fourthwall.com/ ",
        store_label: " Event merch ",
      }),
    })

    expect(prepared.storeUrl).toBe("https://psc-zim-shop.fourthwall.com/")
    expect(prepared.storeLabel).toBe("Event merch")
  })

  test("normalizes anonymous identity fields", () => {
    const prepared = normalizeLiveRoomCreateRequest({
      hostUserId: "usr_host",
      body: createRequest({
        identity_mode: "anonymous",
        anonymous_scope: "community_stable",
        disclosed_qualifier_ids: [" qual_unique_human ", "qual_unique_human"],
      }),
    })

    expect(prepared.identityMode).toBe("anonymous")
    expect(prepared.anonymousScope).toBe("community_stable")
    expect(prepared.disclosedQualifierIds).toEqual(["qual_unique_human"])
  })

  test("rejects anonymous identity fields on public live rooms", () => {
    expect(() => normalizeLiveRoomCreateRequest({
      hostUserId: "usr_host",
      body: createRequest({
        identity_mode: "public",
        anonymous_scope: "community_stable",
      }),
    })).toThrow("anonymous_scope is only allowed for anonymous posts")
  })

  test("treats blank store link fields as null", () => {
    const prepared = normalizeLiveRoomCreateRequest({
      hostUserId: "usr_host",
      body: createRequest({
        store_url: "  ",
        store_label: "  ",
      }),
    })

    expect(prepared.storeUrl).toBeNull()
    expect(prepared.storeLabel).toBeNull()
  })

  test("rejects invalid store link fields", () => {
    expect(() => normalizeLiveRoomCreateRequest({
      hostUserId: "usr_host",
      body: createRequest({
        store_url: "ftp://example.com/store",
      }),
    })).toThrow("store_url must be an http or https URL")

    expect(() => normalizeLiveRoomCreateRequest({
      hostUserId: "usr_host",
      body: createRequest({
        store_label: "x".repeat(81),
      }),
    })).toThrow("store_label must be 80 characters or fewer")
  })

  test("normalizes gated audience gates and decodes public asset ids", () => {
    const prepared = normalizeLiveRoomCreateRequest({
      hostUserId: "usr_host",
      body: createRequest({
        access_mode: "gated",
        audience_gate: {
          version: 1,
          match: "any",
          segments: [
            { type: "community_members" },
            {
              type: "purchase_entitlement",
              entitlement_kind: "asset_access",
              target_refs: ["asset_ast_song", "asset_ast_song"],
            },
          ],
        },
      }),
    })

    expect(prepared.audienceGate).toEqual({
      version: 1,
      match: "any",
      segments: [
        { type: "community_members" },
        {
          type: "purchase_entitlement",
          entitlement_kind: "asset_access",
          target_refs: ["ast_song"],
        },
      ],
    })
  })

  test("defaults new gated rooms to an explicit community member gate", () => {
    const prepared = normalizeLiveRoomCreateRequest({
      hostUserId: "usr_host",
      body: createRequest({
        access_mode: "gated",
      }),
    })

    expect(prepared.audienceGate).toEqual({
      version: 1,
      match: "any",
      segments: [{ type: "community_members" }],
    })
  })

  test("rejects audience gates on non-gated rooms", () => {
    expect(() => normalizeLiveRoomCreateRequest({
      hostUserId: "usr_host",
      body: createRequest({
        access_mode: "free",
        audience_gate: {
          version: 1,
          match: "any",
          segments: [{ type: "community_members" }],
        },
      }),
    })).toThrow("audience_gate is only supported for gated live rooms")
  })
})
