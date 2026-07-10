import { mkdtemp } from "node:fs/promises"
import { tmpdir } from "node:os"
import { join } from "node:path"
import { createClient, type Client } from "@libsql/client"
import { afterEach, describe, expect, spyOn, test } from "bun:test"
import type { Env } from "../../../types"
import { HttpError } from "../../errors"
import { buildLocalCommunityDbUrl, configureLocalCommunityDbClient, ensureCommunityDbSchema } from "../community-local-db"
import { getLiveRoomAccess } from "./service"
import { resetAudienceGateParseFailureLogDedupeForTests } from "./store"

const COMMUNITY_ID = "cmt_live_access_it"
const NOW = "2026-07-07T00:00:00.000Z"

type LiveRoomFixtureOptions = {
  accessMode?: "free" | "gated" | "paid"
  audienceGateJson?: string | null
  assetListingPrice?: number | string
}

afterEach(() => {
  resetAudienceGateParseFailureLogDedupeForTests()
})

async function createFixture(options: LiveRoomFixtureOptions = {}) {
  const rootDir = await mkdtemp(join(tmpdir(), "live-room-access-"))
  const env = {
    ENVIRONMENT: "test",
    LOCAL_COMMUNITY_DB_ROOT: rootDir,
  } as Env
  const databaseUrl = buildLocalCommunityDbUrl(rootDir, COMMUNITY_ID)
  const client = createClient({ url: databaseUrl })
  await configureLocalCommunityDbClient(client)
  await ensureCommunityDbSchema(client)
  await seedBaseRows(client, options)
  client.close()

  return {
    env,
    communityRepository: {
      getPrimaryCommunityDatabaseBinding: async () => null,
      getCommunityById: async () => null,
      getCommunityByRouteSlug: async () => null,
      getCommunityByNamespaceVerificationId: async () => null,
      listActiveCommunities: async () => [],
      searchActiveCommunities: async () => [],
      getCommunityPostProjectionByPostId: async () => null,
      recordCommunityPostProjection: async () => {
        throw new Error("recordCommunityPostProjection is not used by live-room access tests")
      },
      updateCommunityPostProjectionStatus: async () => undefined,
      updateCommunityPostProjectionPayload: async () => undefined,
      updateCommunityPostProjectionMetrics: async () => undefined,
    } as Parameters<typeof getLiveRoomAccess>[0]["communityRepository"],
  }
}

async function seedBaseRows(client: Client, options: LiveRoomFixtureOptions): Promise<void> {
  const accessMode = options.accessMode ?? "gated"
  await client.execute({
    sql: `
      INSERT INTO communities (
        community_id, display_name, description, status, artist_identity_id,
        artist_governance_state, membership_mode, default_age_gate_policy, allow_anonymous_identity,
        anonymous_identity_scope, donation_partner_id, donation_policy_mode, donation_partner_status,
        governance_mode, settings_json, created_by_user_id, created_at, updated_at
      ) VALUES (
        ?1, 'Live Access IT', NULL, 'active', NULL,
        'fan_run', 'open', 'none', 0,
        NULL, NULL, 'none', 'unconfigured',
        'centralized', NULL, 'usr_host', ?2, ?2
      )
    `,
    args: [COMMUNITY_ID, NOW],
  })
  await client.execute({
    sql: `
      INSERT INTO posts (
        post_id, community_id, author_user_id, identity_mode, post_type, status,
        title, analysis_state, content_safety_state, age_gate_policy, created_at, updated_at
      ) VALUES (
        'pst_live_access', ?1, 'usr_host', 'public', 'video', 'published',
        'Live access', 'allow', 'safe', 'none', ?2, ?2
      )
    `,
    args: [COMMUNITY_ID, NOW],
  })
  await client.execute({
    sql: `
      INSERT INTO live_rooms (
        live_room_id, community_id, anchor_post_id, host_user_id, guest_user_id,
        room_kind, status, access_mode, visibility, title, description, cover_ref,
        event_start_at, live_started_at, ended_at, canceled_at, broadcast_ref,
        replay_status, created_at, updated_at, store_url, store_label, recording_enabled,
        replay_asset_id, replay_listing_id, audience_gate_json
      ) VALUES (
        'lr_live_access', ?1, 'pst_live_access', 'usr_host', NULL,
        'solo', 'live', ?2, 'public', 'Live access', NULL, NULL,
        NULL, ?3, NULL, NULL, NULL,
        'none', ?4, ?4, NULL, NULL, 0,
        NULL, NULL, ?5
      )
    `,
    args: [
      COMMUNITY_ID,
      accessMode,
      Math.floor(Date.parse(NOW) / 1000),
      NOW,
      options.audienceGateJson ?? null,
    ],
  })
  await client.execute({
    sql: `
      INSERT INTO live_room_performer_allocations (
        allocation_id, live_room_id, community_id, user_id, role, share_bps, created_at
      ) VALUES ('lra_host', 'lr_live_access', ?1, 'usr_host', 'host', 10000, ?2)
    `,
    args: [COMMUNITY_ID, NOW],
  })
  await client.execute({
    sql: `
      INSERT INTO live_room_setlists (
        setlist_id, live_room_id, community_id, status, created_at, updated_at
      ) VALUES ('lrs_live_access', 'lr_live_access', ?1, 'ready', ?2, ?2)
    `,
    args: [COMMUNITY_ID, NOW],
  })
  await client.execute({
    sql: `
      INSERT INTO listings (
        listing_id, community_id, asset_id, live_room_id, replay_asset_id, listing_mode,
        status, price_usd, regional_pricing_policy_json, vinyl_release_provider,
        vinyl_release_url, created_by_user_id, created_at, updated_at
      ) VALUES (
        'lst_asset_access', ?1, 'ast_song', NULL, NULL, 'fixed_price',
        'active', ?2, '{}', NULL,
        NULL, 'usr_host', ?3, ?3
      )
    `,
    args: [COMMUNITY_ID, options.assetListingPrice ?? 7.5, NOW],
  })
  if (accessMode === "paid") {
    await client.execute({
      sql: `
        INSERT INTO listings (
          listing_id, community_id, asset_id, live_room_id, replay_asset_id, listing_mode,
          status, price_usd, regional_pricing_policy_json, vinyl_release_provider,
          vinyl_release_url, created_by_user_id, created_at, updated_at
        ) VALUES (
          'lst_live_access', ?1, NULL, 'lr_live_access', NULL, 'fixed_price',
          'active', 12, '{}', NULL,
          NULL, 'usr_host', ?2, ?2
        )
      `,
      args: [COMMUNITY_ID, NOW],
    })
    await client.execute({
      sql: `
        INSERT INTO purchases (
          purchase_id, community_id, listing_id, asset_id, live_room_id, replay_asset_id,
          buyer_kind, buyer_user_id, buyer_wallet_address, buyer_wallet_address_normalized,
          buyer_chain_ref, settlement_wallet_attachment_id, purchase_price_usd, pricing_tier,
          settlement_chain, settlement_token, settlement_tx_ref, created_at, settlement_mode
        ) VALUES (
          'pur_live_access', ?1, 'lst_live_access', NULL, 'lr_live_access', NULL,
          'user', 'usr_paid_buyer', NULL, NULL,
          NULL, 'wa_paid_buyer', 12, NULL,
          'eip155:1', 'USDC', '0xpaid', ?2, 'delivery_only_story_settlement'
        )
      `,
      args: [COMMUNITY_ID, NOW],
    })
    await client.execute({
      sql: `
        INSERT INTO purchase_entitlements (
          purchase_entitlement_id, purchase_id, community_id, buyer_kind, buyer_user_id,
          buyer_wallet_address, buyer_wallet_address_normalized, buyer_chain_ref,
          entitlement_kind, target_ref, status, granted_at, revoked_at, created_at, updated_at
        ) VALUES (
          'pent_live_access', 'pur_live_access', ?1, 'user', 'usr_paid_buyer',
          NULL, NULL, NULL,
          'live_room_access', 'lr_live_access', 'active', ?2, NULL, ?2, ?2
        )
      `,
      args: [COMMUNITY_ID, NOW],
    })
  }
}

describe("live room access service integration", () => {
  test("corrupt stored audience gate resolves as structured gate denial, not 500 or legacy membership", async () => {
    const warn = spyOn(console, "warn").mockImplementation(() => undefined)
    const fixture = await createFixture({
      accessMode: "gated",
      audienceGateJson: "{\"version\":1,\"match\":\"any\",\"segments\":[{\"type\":\"purchase_entitlement\"}]}",
    })

    const response = await getLiveRoomAccess({
      env: fixture.env,
      userId: "usr_viewer",
      communityId: COMMUNITY_ID,
      liveRoomId: "lr_live_access",
      communityRepository: fixture.communityRepository,
    })

    expect(response.access.allowed).toBe(false)
    expect(response.access.decision_reason).toBe("gate_unsatisfied")
    expect(response.access.gate).toEqual({ failed_segments: [] })
    expect(warn).toHaveBeenCalledTimes(1)
    expect(warn.mock.calls[0]?.[1]).toMatchObject({
      metric: "audience_gate_parse_failed",
      community_id: COMMUNITY_ID,
      live_room_id: "lr_live_access",
      reason: "shape_invalid",
    })
    warn.mockRestore()
  })

  test("purchase gate denial serializes public asset ids and omits unpriced listing CTAs", async () => {
    const fixture = await createFixture({
      accessMode: "gated",
      audienceGateJson: JSON.stringify({
        version: 1,
        match: "any",
        segments: [{
          type: "purchase_entitlement",
          entitlement_kind: "asset_access",
          target_refs: ["ast_song"],
        }],
      }),
      assetListingPrice: "not-a-price",
    })

    const response = await getLiveRoomAccess({
      env: fixture.env,
      userId: "usr_viewer",
      communityId: COMMUNITY_ID,
      liveRoomId: "lr_live_access",
      communityRepository: fixture.communityRepository,
    })

    expect(response.access.decision_reason).toBe("gate_unsatisfied")
    expect(response.access.gate).toEqual({
      failed_segments: [{
        type: "purchase_entitlement",
        entitlement_kind: "asset_access",
        required_target_refs: ["asset_ast_song"],
      }],
    })
  })

  test("paid non-member with an active ticket entitlement remains blocked by the scoped membership precondition", async () => {
    const fixture = await createFixture({ accessMode: "paid" })

    await expect(getLiveRoomAccess({
      env: fixture.env,
      userId: "usr_paid_buyer",
      communityId: COMMUNITY_ID,
      liveRoomId: "lr_live_access",
      communityRepository: fixture.communityRepository,
    })).rejects.toMatchObject({
      status: 404,
      code: "not_found",
    } satisfies Partial<HttpError>)
  })
})
