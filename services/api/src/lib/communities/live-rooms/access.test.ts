import { afterEach, describe, expect, spyOn, test } from "bun:test"
import type { InStatement, QueryResult } from "../../sql-client"
import {
  resolveLiveRoomViewerAccess,
  resolvePublicLiveRoomViewerAccess,
} from "./access"
import { parseStoredAudienceGate, resetAudienceGateParseFailureLogDedupeForTests } from "./store"
import type { LiveRoom } from "./types"

type FakeAccessState = {
  members?: Set<string>
  roles?: Map<string, "owner" | "admin" | "moderator">
  entitlements?: Set<string>
  listingPriceUsd?: unknown
  listingStatus?: "active" | "paused"
}

const COMMUNITY_ID = "cmt_gate"

afterEach(() => {
  resetAudienceGateParseFailureLogDedupeForTests()
})

function makeRoom(overrides: Partial<LiveRoom> = {}): LiveRoom {
  return {
    id: "lr_gate",
    object: "live_room",
    community: COMMUNITY_ID,
    anchor_post: "pst_gate",
    host_user: "usr_host",
    guest_user: null,
    room_kind: "solo",
    status: "live",
    access_mode: "gated",
    visibility: "public",
    audience_gate: null,
    title: "Gate test",
    description: null,
    store_url: null,
    store_label: null,
    cover_ref: null,
    event_start_at: null,
    live_started_at: null,
    ended_at: null,
    canceled_at: null,
    broadcast_ref: null,
    recording_enabled: false,
    replay_asset_id: null,
    replay_listing_id: null,
    replay_status: "none",
    performer_allocations: [],
    setlist: {
      id: "lrs_gate",
      object: "live_room_setlist",
      status: "ready",
      items: [],
    },
    created: 1,
    ...overrides,
  }
}

function purchaseGate(targetRefs = ["ast_song"]): LiveRoom["audience_gate"] {
  return {
    version: 1,
    match: "any",
    segments: [
      {
        type: "purchase_entitlement",
        entitlement_kind: "asset_access",
        target_refs: targetRefs,
      },
    ],
  }
}

function memberGate(): LiveRoom["audience_gate"] {
  return {
    version: 1,
    match: "any",
    segments: [{ type: "community_members" }],
  }
}

function entitlementKey(userId: string, targetRef: string, kind = "asset_access"): string {
  return `${userId}:${targetRef}:${kind}`
}

function fakeClient(state: FakeAccessState = {}) {
  return {
    async execute(statement: InStatement | string): Promise<QueryResult> {
      const sql = typeof statement === "string" ? statement : statement.sql
      const args = typeof statement === "string" ? [] : statement.args ?? []
      const userId = String(args[1] ?? "")

      if (/FROM community_memberships/i.test(sql) && /status = 'member'/i.test(sql)) {
        return { rows: state.members?.has(userId) ? [{ status: "member" }] : [] }
      }
      if (/FROM community_roles/i.test(sql) && /status = 'active'/i.test(sql)) {
        const role = state.roles?.get(userId)
        return { rows: role ? [{ role }] : [] }
      }
      if (/FROM community_memberships/i.test(sql)) {
        return { rows: state.members?.has(userId) ? [{ status: "member" }] : [] }
      }
      if (/FROM community_roles/i.test(sql)) {
        return { rows: [] }
      }
      if (/FROM purchase_entitlements/i.test(sql)) {
        const targetRef = String(args[2] ?? "")
        const kind = String(args[3] ?? "")
        const hasEntitlement = state.entitlements?.has(entitlementKey(userId, targetRef, kind)) === true
        return {
          rows: hasEntitlement
            ? [{
              purchase_entitlement_id: "pent_gate",
              purchase_id: "pur_gate",
              community_id: COMMUNITY_ID,
              buyer_kind: "user",
              buyer_user_id: userId,
              buyer_wallet_address: null,
              buyer_wallet_address_normalized: null,
              buyer_chain_ref: null,
              entitlement_kind: kind,
              target_ref: targetRef,
              status: "active",
              granted_at: "2026-07-07T00:00:00.000Z",
              revoked_at: null,
              created_at: "2026-07-07T00:00:00.000Z",
              updated_at: "2026-07-07T00:00:00.000Z",
            }]
            : [],
        }
      }
      if (/FROM\s+listings/i.test(sql) && args[1]) {
        const assetId = String(args[1] ?? "")
        return {
          rows: [{
            listing_id: "lst_gate",
            community_id: COMMUNITY_ID,
            asset_id: assetId,
            live_room_id: null,
            replay_asset_id: null,
            listing_mode: "fixed_price",
            status: state.listingStatus ?? "active",
            price_usd: state.listingPriceUsd ?? 7.5,
            regional_pricing_policy_json: "{}",
            vinyl_release_provider: null,
            vinyl_release_url: null,
            created_by_user_id: "usr_host",
            created_at: "2026-07-07T00:00:00.000Z",
            updated_at: "2026-07-07T00:00:00.000Z",
          }],
        }
      }
      return { rows: [] }
    },
  }
}

async function resolveAuthed(room: LiveRoom, userId: string, state: FakeAccessState = {}) {
  return resolveLiveRoomViewerAccess({
    client: fakeClient(state),
    communityId: COMMUNITY_ID,
    liveRoomId: room.id,
    userId,
    loadRoom: async () => room,
  })
}

async function resolvePublic(room: LiveRoom) {
  return resolvePublicLiveRoomViewerAccess({
    client: fakeClient(),
    communityId: COMMUNITY_ID,
    liveRoomId: room.id,
    loadRoom: async () => room,
  })
}

describe("live room audience gate access", () => {
  test("legacy gated rooms with null audience gate keep member-only fallback", async () => {
    const result = await resolveAuthed(makeRoom(), "usr_viewer")

    expect(result.allowed).toBe(false)
    expect(result.decisionReason).toBe("membership_required")
    expect(result.gate).toBeNull()
  })

  test("explicit community member gate admits members", async () => {
    const result = await resolveAuthed(
      makeRoom({ audience_gate: memberGate() }),
      "usr_member",
      { members: new Set(["usr_member"]) },
    )

    expect(result.allowed).toBe(true)
    expect(result.decisionReason).toBeNull()
  })

  test("selected-song buyer who is not a member passes the gate", async () => {
    const result = await resolveAuthed(
      makeRoom({ audience_gate: purchaseGate() }),
      "usr_buyer",
      { entitlements: new Set([entitlementKey("usr_buyer", "ast_song")]) },
    )

    expect(result.allowed).toBe(true)
    expect(result.decisionReason).toBeNull()
  })

  test("selected-song non-buyer fails with gate metadata and public ids", async () => {
    const result = await resolveAuthed(makeRoom({ audience_gate: purchaseGate() }), "usr_viewer")

    expect(result.allowed).toBe(false)
    expect(result.decisionReason).toBe("gate_unsatisfied")
    expect(result.gate).toEqual({
      failed_segments: [{
        type: "purchase_entitlement",
        entitlement_kind: "asset_access",
        required_target_refs: ["asset_ast_song"],
        purchasable_listings: [{
          listing: "lst_lst_gate",
          asset: "asset_ast_song",
          price_cents: 750,
          status: "active",
        }],
      }],
    })
  })

  test("gate failure payload omits inactive listings", async () => {
    const result = await resolveAuthed(
      makeRoom({ audience_gate: purchaseGate() }),
      "usr_viewer",
      { listingStatus: "paused" },
    )

    expect(result.allowed).toBe(false)
    expect(result.decisionReason).toBe("gate_unsatisfied")
    expect(result.gate).toEqual({
      failed_segments: [{
        type: "purchase_entitlement",
        entitlement_kind: "asset_access",
        required_target_refs: ["asset_ast_song"],
      }],
    })
  })

  test("host and moderators bypass explicit gates", async () => {
    const hostResult = await resolveAuthed(makeRoom({ audience_gate: purchaseGate() }), "usr_host")
    const moderatorResult = await resolveAuthed(
      makeRoom({ audience_gate: purchaseGate() }),
      "usr_mod",
      { roles: new Map([["usr_mod", "moderator"]]) },
    )

    expect(hostResult.allowed).toBe(true)
    expect(moderatorResult.allowed).toBe(true)
  })

  test("anonymous explicit gated rooms return gate_unsatisfied while legacy rooms return membership_required", async () => {
    const explicitResult = await resolvePublic(makeRoom({ audience_gate: memberGate() }))
    const legacyResult = await resolvePublic(makeRoom())

    expect(explicitResult.decisionReason).toBe("gate_unsatisfied")
    expect(explicitResult.gate).toEqual({ failed_segments: [{ type: "community_members" }] })
    expect(legacyResult.decisionReason).toBe("membership_required")
    expect(legacyResult.gate).toBeNull()
  })

  test("gate-passing viewers still receive lifecycle denial for non-live rooms", async () => {
    const result = await resolveAuthed(
      makeRoom({ status: "scheduled", audience_gate: purchaseGate() }),
      "usr_buyer",
      { entitlements: new Set([entitlementKey("usr_buyer", "ast_song")]) },
    )

    expect(result.allowed).toBe(false)
    expect(result.decisionReason).toBe("not_live")
    expect(result.gate).toBeNull()
  })

  test("explicit community member gate non-member maps to gate_unsatisfied", async () => {
    const result = await resolveAuthed(makeRoom({ audience_gate: memberGate() }), "usr_viewer")

    expect(result.allowed).toBe(false)
    expect(result.decisionReason).toBe("gate_unsatisfied")
    expect(result.gate).toEqual({ failed_segments: [{ type: "community_members" }] })
  })

  test("present but malformed stored gates fail closed instead of legacy member fallback", async () => {
    const warn = spyOn(console, "warn").mockImplementation(() => undefined)
    const parsedGate = parseStoredAudienceGate(
      "{\"version\":1,\"match\":\"any\",\"segments\":[{\"type\":\"purchase_entitlement\"}]}",
      { communityId: COMMUNITY_ID, liveRoomId: "lr_gate", nowMs: 1_000 },
    )
    const result = await resolveAuthed(
      makeRoom({ audience_gate: parsedGate }),
      "usr_member",
      { members: new Set(["usr_member"]) },
    )

    expect(parsedGate).toEqual({ version: 1, match: "any", segments: [] })
    expect(result.allowed).toBe(false)
    expect(result.decisionReason).toBe("gate_unsatisfied")
    expect(result.gate).toEqual({ failed_segments: [] })
    expect(warn).toHaveBeenCalledWith("[live-rooms] audience gate parse failed", {
      metric: "audience_gate_parse_failed",
      community_id: COMMUNITY_ID,
      live_room_id: "lr_gate",
      reason: "shape_invalid",
    })
    warn.mockRestore()
  })

  test("stored gate parse failure logging is deduped per room and reason", () => {
    const warn = spyOn(console, "warn").mockImplementation(() => undefined)

    parseStoredAudienceGate("{", { communityId: COMMUNITY_ID, liveRoomId: "lr_gate", nowMs: 1_000 })
    parseStoredAudienceGate("{", { communityId: COMMUNITY_ID, liveRoomId: "lr_gate", nowMs: 2_000 })
    parseStoredAudienceGate("{", { communityId: COMMUNITY_ID, liveRoomId: "lr_other", nowMs: 2_000 })

    expect(warn).toHaveBeenCalledTimes(2)
    expect(warn.mock.calls[0]?.[1]).toEqual({
      metric: "audience_gate_parse_failed",
      community_id: COMMUNITY_ID,
      live_room_id: "lr_gate",
      reason: "json_parse",
    })
    expect(warn.mock.calls[1]?.[1]).toEqual({
      metric: "audience_gate_parse_failed",
      community_id: COMMUNITY_ID,
      live_room_id: "lr_other",
      reason: "json_parse",
    })
    warn.mockRestore()
  })
})
