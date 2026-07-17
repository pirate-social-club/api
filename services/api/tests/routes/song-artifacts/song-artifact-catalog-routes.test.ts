import { afterEach, beforeEach, describe, expect, test } from "bun:test"
import { createClient } from "@libsql/client"
import { app } from "../../../src/index"
import { buildLocalCommunityDbUrl } from "../../../src/lib/communities/community-local-db"
import { createRouteTestContext, json, resetRuntimeCaches } from "../../helpers"
import { setStoryRoyaltyRegistrarForTests } from "../../../src/lib/story/story-royalty-registration-service"
import { upsertStoryRegisteredAssetProjection } from "../../../src/lib/communities/commerce/derivative-source-projection"
import { listDerivativeSources } from "../../../src/lib/communities/commerce/service"
import { getCommunityRepository } from "../../../src/lib/communities/db-community-repository"
import { getProfileRepository } from "../../../src/lib/auth/repositories"
import type { Client } from "../../../src/lib/sql-client"
import type { Env } from "../../../src/types"
import {
  completeUniqueHumanVerification,
  exchangeJwt,
  requestJson,
} from "./song-artifact-test-helpers"
import { attachPrimaryWallet, uploadSongArtifact } from "./song-artifact-locked-test-helpers"

let cleanup: (() => Promise<void>) | null = null
let originalFetch: typeof fetch

function installSuccessfulStoryRoyaltyRegistrarForTests(): void {
  setStoryRoyaltyRegistrarForTests(async () => ({
    storyIpId: "0x9999999999999999999999999999999999999999",
    storyIpNftContract: "0x8888888888888888888888888888888888888888",
    storyIpNftTokenId: "17",
    storyLicenseTermsId: "17",
    storyLicenseTemplate: null,
    storyRoyaltyPolicy: "0xBe54FB168b3c982b7AaE60dB6CF75Bd8447b390E",
    storyDerivativeParentIpIds: [],
    storyRevenueToken: "0x1514000000000000000000000000000000000000",
    storyRoyaltyRegistrationStatus: "registered",
    storyDerivativeRegisteredAt: "2026-04-21T00:00:00.000Z",
  }))
}

type DerivativeSourceListBody = {
  items: Array<{
    asset: string
    title: string
    kind: "song" | "video"
    story_ip: string
    story_license_terms: string
    creator_user: string
    creator_handle?: string | null
    creator_display_name?: string | null
  }>
  next_cursor: string | null
}

async function createCommunityForTest(input: {
  env: Env
  accessToken: string
  displayName: string
}): Promise<string> {
  const response = await requestJson(
    "http://pirate.test/communities",
    {
      display_name: input.displayName,
      membership_mode: "request",
      handle_policy: {
        policy_template: "standard",
      },
    },
    input.env,
    input.accessToken,
  )
  expect(response.status === 201 || response.status === 202).toBe(true)
  const body = await json(response) as {
    community: {
      id: string
    }
  }
  return body.community.id.replace(/^com_/, "")
}

async function rewriteCommunityAccessUserId(input: {
  communityDbRoot: string
  communityId: string
  fromUserId: string
  toUserId: string
}): Promise<void> {
  const client = createClient({
    url: buildLocalCommunityDbUrl(input.communityDbRoot, input.communityId),
  })
  try {
    await client.execute({
      sql: `
        UPDATE community_memberships
        SET user_id = ?3, updated_at = ?4
        WHERE community_id = ?1
          AND user_id = ?2
      `,
      args: [input.communityId, input.fromUserId, input.toUserId, new Date().toISOString()],
    })
    await client.execute({
      sql: `
        UPDATE community_roles
        SET user_id = ?3,
            granted_by_user_id = CASE WHEN granted_by_user_id = ?2 THEN ?3 ELSE granted_by_user_id END,
            updated_at = ?4
        WHERE community_id = ?1
          AND user_id = ?2
      `,
      args: [input.communityId, input.fromUserId, input.toUserId, new Date().toISOString()],
    })
  } finally {
    client.close()
  }
}

async function setMembershipProjection(input: {
  client: Pick<Client, "execute">
  communityId: string
  userId: string
  state: "not_member" | "pending_request" | "member" | "banned"
  ordinal?: number
}): Promise<void> {
  const now = new Date(Date.UTC(2026, 0, 1, 0, input.ordinal ?? 0, 0)).toISOString()
  await input.client.execute({
    sql: `
      INSERT INTO community_membership_projections (
        projection_id, community_id, user_id, membership_state, role_summary_json, source_updated_at, created_at, updated_at
      ) VALUES (
        ?1, ?2, ?3, ?4, NULL, ?5, ?5, ?5
      )
      ON CONFLICT(community_id, user_id) DO UPDATE SET
        membership_state = excluded.membership_state,
        source_updated_at = excluded.source_updated_at,
        updated_at = excluded.updated_at
    `,
    args: [
      `cmp_derivative_${input.communityId}_${input.userId}`,
      input.communityId,
      input.userId,
      input.state,
      now,
    ],
  })
}

async function insertDerivativeSourceAsset(input: {
  communityDbRoot: string
  communityId: string
  creatorUserId: string
  assetId: string
  title: string
  assetKind: "song_audio" | "video_file"
  rightsBasis: "original" | "derivative"
  publicationStatus: "story_published" | "withdrawn"
  storyIpId?: string
  storyLicenseTermsId?: string
  commercialRevSharePct?: number
  postStatus?: "published" | "deleted" | "hidden" | "removed"
}): Promise<void> {
  const client = createClient({
    url: buildLocalCommunityDbUrl(input.communityDbRoot, input.communityId),
  })
  const now = new Date().toISOString()
  const postId = `post_${input.assetId}`

  try {
    await client.execute({
      sql: `
        INSERT INTO posts (
          post_id, community_id, author_user_id, identity_mode, post_type, status,
          song_mode, title, rights_basis, asset_id, analysis_state, content_safety_state,
          age_gate_policy, created_at, updated_at
        ) VALUES (
          ?1, ?2, ?3, 'public', ?4, ?5,
          ?6, ?7, ?8, ?9, 'allow', 'safe',
          'none', ?10, ?10
        )
      `,
      args: [
        postId,
        input.communityId,
        input.creatorUserId,
        input.assetKind === "video_file" ? "video" : "song",
        input.postStatus ?? "published",
        input.assetKind === "song_audio" ? input.rightsBasis === "derivative" ? "remix" : "original" : null,
        input.title,
        input.rightsBasis,
        input.assetId,
        now,
      ],
    })
    await client.execute({
      sql: `
        INSERT INTO assets (
          asset_id, community_id, source_post_id, display_title, song_artifact_bundle_id, creator_user_id, asset_kind,
          rights_basis, access_mode, license_preset, commercial_rev_share_pct,
          primary_content_ref, primary_content_hash, publication_status,
          story_status, story_error, story_ip_id, story_ip_nft_contract, story_ip_nft_token_id,
          story_publish_model, story_license_terms_id, story_license_template, story_royalty_policy,
          story_royalty_policy_id, story_derivative_parent_ip_ids_json, story_derivative_registered_at,
          story_revenue_token, story_royalty_registration_status, locked_delivery_status, locked_delivery_ref,
          locked_delivery_error, created_at, updated_at, story_publish_tx_ref, story_asset_version_id,
          story_cdr_vault_uuid, story_namespace, story_entitlement_token_id, story_read_condition,
          story_write_condition, locked_delivery_storage_ref, locked_delivery_secret_json
        ) VALUES (
          ?1, ?2, ?3, ?4, NULL, ?5, ?6,
          ?7, 'public', 'commercial-remix', 15,
          ?8, ?9, ?10,
          'published', NULL, ?11, NULL, NULL,
          'story_ip_v1', ?12, NULL, NULL,
          NULL, NULL, NULL,
          NULL, 'registered', 'none', NULL,
          NULL, ?13, ?13, NULL, NULL,
          NULL, NULL, NULL, NULL,
          NULL, NULL, NULL
        )
      `,
      args: [
        input.assetId,
        input.communityId,
        postId,
        input.title,
        input.creatorUserId,
        input.assetKind,
        input.rightsBasis,
        `asset:${input.assetId}`,
        `0xhash${input.assetId}`,
        input.publicationStatus,
        input.storyIpId ?? `0x${input.assetId.padEnd(40, "0").slice(0, 40)}`,
        input.storyLicenseTermsId ?? "17",
        now,
      ],
    })
    if (input.commercialRevSharePct != null) {
      await client.execute({
        sql: "UPDATE assets SET commercial_rev_share_pct = ?2 WHERE asset_id = ?1",
        args: [input.assetId, input.commercialRevSharePct],
      })
    }
  } finally {
    client.close()
  }
}

async function insertDerivativeSourceProjection(input: {
  env: Env
  communityId: string
  creatorUserId: string
  assetId: string
  title: string
  assetKind: "song_audio" | "video_file"
  storyIpId?: string
  storyLicenseTermsId?: string
  commercialRevSharePct?: number
  postStatus?: "published" | "deleted" | "hidden" | "removed"
}): Promise<void> {
  const now = new Date().toISOString()
  await upsertStoryRegisteredAssetProjection({
    env: input.env,
    projection: {
      communityId: input.communityId,
      assetId: input.assetId,
      displayTitle: input.title,
      creatorUserId: input.creatorUserId,
      assetKind: input.assetKind,
      licensePreset: "commercial-remix",
      commercialRevSharePct: input.commercialRevSharePct ?? 15,
      storyIpId: input.storyIpId ?? `0x${input.assetId.padEnd(40, "0").slice(0, 40)}`,
      storyLicenseTermsId: input.storyLicenseTermsId ?? "17",
      sourcePostId: `post_${input.assetId}`,
      sourcePostStatus: input.postStatus ?? "published",
      sourceUpdatedAt: now,
      createdAt: now,
    },
  })
}

beforeEach(() => {
  resetRuntimeCaches()
  originalFetch = globalThis.fetch
})

afterEach(async () => {
  globalThis.fetch = originalFetch
  if (cleanup) {
    await cleanup()
    cleanup = null
  }
})

describe("song artifact catalog routes", () => {
  test("lists Story-registered derivative sources for community members", async () => {
    const ctx = await createRouteTestContext()
    cleanup = ctx.cleanup

    const owner = await exchangeJwt(ctx.env, "derivative-source-owner")
    await completeUniqueHumanVerification(ctx.env, owner.accessToken)
    const ownerProfile = await app.request("http://pirate.test/profiles/me", {
      method: "POST",
      headers: {
        authorization: `Bearer ${owner.accessToken}`,
        "content-type": "application/json",
      },
      body: JSON.stringify({
        display_name: "Derivative Artist",
      }),
    }, ctx.env)
    expect(ownerProfile.status).toBe(200)

    const communityCreate = await requestJson(
      "http://pirate.test/communities",
      {
        display_name: "Derivative Source Club",
        membership_mode: "request",
        handle_policy: {
          policy_template: "standard",
        },
      },
      ctx.env,
      owner.accessToken,
    )
    expect(communityCreate.status === 201 || communityCreate.status === 202).toBe(true)
    const communityCreateBody = await json(communityCreate) as {
      community: {
        id: string
      }
    }
    const communityId = communityCreateBody.community.id.replace(/^com_/, "")

    await insertDerivativeSourceAsset({
      communityDbRoot: ctx.communityDbRoot,
      communityId,
      creatorUserId: owner.userId,
      assetId: "ast_original_song",
      title: "Original Source",
      assetKind: "song_audio",
      rightsBasis: "original",
      publicationStatus: "story_published",
      storyIpId: "0x1111111111111111111111111111111111111111",
      storyLicenseTermsId: "17",
    })
    const longDerivativeTitle = "Derivative Echo 2026-07-06T21:23:32.025Z exact smoke title"
    await insertDerivativeSourceAsset({
      communityDbRoot: ctx.communityDbRoot,
      communityId,
      creatorUserId: owner.userId,
      assetId: "ast_derivative_song",
      title: longDerivativeTitle,
      assetKind: "song_audio",
      rightsBasis: "derivative",
      publicationStatus: "story_published",
      storyIpId: "0x2222222222222222222222222222222222222222",
      storyLicenseTermsId: "18",
    })
    await insertDerivativeSourceAsset({
      communityDbRoot: ctx.communityDbRoot,
      communityId,
      creatorUserId: owner.userId,
      assetId: "ast_zero_share_song",
      title: "Zero Share Source",
      assetKind: "song_audio",
      rightsBasis: "original",
      publicationStatus: "story_published",
      storyIpId: "0x6666666666666666666666666666666666666666",
      storyLicenseTermsId: "22",
      commercialRevSharePct: 0,
    })
    await insertDerivativeSourceAsset({
      communityDbRoot: ctx.communityDbRoot,
      communityId,
      creatorUserId: owner.userId,
      assetId: "ast_withdrawn_song",
      title: "Withdrawn Source",
      assetKind: "song_audio",
      rightsBasis: "original",
      publicationStatus: "withdrawn",
      storyIpId: "0x3333333333333333333333333333333333333333",
      storyLicenseTermsId: "19",
    })
    await insertDerivativeSourceAsset({
      communityDbRoot: ctx.communityDbRoot,
      communityId,
      creatorUserId: owner.userId,
      assetId: "ast_deleted_song",
      title: "Deleted Source",
      assetKind: "song_audio",
      rightsBasis: "original",
      publicationStatus: "story_published",
      storyIpId: "0x7777777777777777777777777777777777777777",
      storyLicenseTermsId: "21",
      postStatus: "deleted",
    })
    await insertDerivativeSourceAsset({
      communityDbRoot: ctx.communityDbRoot,
      communityId,
      creatorUserId: owner.userId,
      assetId: "ast_story_video",
      title: "Video Source",
      assetKind: "video_file",
      rightsBasis: "original",
      publicationStatus: "story_published",
      storyIpId: "0x4444444444444444444444444444444444444444",
      storyLicenseTermsId: "20",
    })

    const songSources = await app.request(
      `http://pirate.test/communities/${communityId}/derivative-sources?kind=song&limit=25`,
      {
        headers: {
          authorization: `Bearer ${owner.accessToken}`,
        },
      },
      ctx.env,
    )
    expect(songSources.status).toBe(200)
    const songSourcesBody = await json(songSources) as DerivativeSourceListBody
    expect(songSourcesBody.next_cursor).toBeNull()
    expect(songSourcesBody.items.map((item) => item.asset).sort()).toEqual([
      "asset_ast_derivative_song",
      "asset_ast_original_song",
    ])
    expect(songSourcesBody.items.map((item) => item.title).sort()).toEqual([
      longDerivativeTitle,
      "Original Source",
    ])
    expect(songSourcesBody.items.every((item) => item.kind === "song")).toBe(true)
    expect(songSourcesBody.items.every((item) => item.creator_handle?.endsWith(".pirate"))).toBe(true)
    expect(songSourcesBody.items.every((item) => !item.creator_handle?.startsWith("usr_"))).toBe(true)
    expect(songSourcesBody.items.every((item) => item.creator_display_name === "Derivative Artist")).toBe(true)
    expect(songSourcesBody.items.find((item) => item.asset === "asset_ast_derivative_song")?.story_license_terms).toBe("18")

    const queriedSources = await app.request(
      `http://pirate.test/communities/${communityId}/derivative-sources?kind=song&q=Derivative`,
      {
        headers: {
          authorization: `Bearer ${owner.accessToken}`,
        },
      },
      ctx.env,
    )
    expect(queriedSources.status).toBe(200)
    const queriedSourcesBody = await json(queriedSources) as DerivativeSourceListBody
    expect(queriedSourcesBody.items.map((item) => item.asset)).toEqual(["asset_ast_derivative_song"])

    const longTitleQuery = encodeURIComponent(longDerivativeTitle)
    const longQuerySources = await app.request(
      `http://pirate.test/communities/${communityId}/derivative-sources?kind=song&q=${longTitleQuery}`,
      {
        headers: {
          authorization: `Bearer ${owner.accessToken}`,
        },
      },
      ctx.env,
    )
    expect(longQuerySources.status).toBe(200)
    const longQuerySourcesBody = await json(longQuerySources) as DerivativeSourceListBody
    expect(longQuerySourcesBody.items.map((item) => item.asset)).toEqual(["asset_ast_derivative_song"])

    const videoSources = await app.request(
      `http://pirate.test/communities/${communityId}/derivative-sources?kind=video`,
      {
        headers: {
          authorization: `Bearer ${owner.accessToken}`,
        },
      },
      ctx.env,
    )
    expect(videoSources.status).toBe(200)
    const videoSourcesBody = await json(videoSources) as DerivativeSourceListBody
    expect(videoSourcesBody.items.map((item) => item.asset)).toEqual(["asset_ast_story_video"])
    expect(videoSourcesBody.items[0]?.kind).toBe("video")

    const liveSources = await app.request(
      `http://pirate.test/communities/${communityId}/derivative-sources?kind=live`,
      {
        headers: {
          authorization: `Bearer ${owner.accessToken}`,
        },
      },
      ctx.env,
    )
    expect(liveSources.status).toBe(200)
    const liveSourcesBody = await json(liveSources) as DerivativeSourceListBody
    expect(liveSourcesBody.items.map((item) => item.asset).sort()).toEqual([
      "asset_ast_derivative_song",
      "asset_ast_original_song",
    ])
    expect(liveSourcesBody.items.every((item) => item.kind === "song")).toBe(true)

    const outsider = await exchangeJwt(ctx.env, "derivative-source-outsider")
    const outsiderSources = await app.request(
      `http://pirate.test/communities/${communityId}/derivative-sources?kind=song`,
      {
        headers: {
          authorization: `Bearer ${outsider.accessToken}`,
        },
      },
      ctx.env,
    )
    expect(outsiderSources.status).toBe(404)
  })

  test("lists global derivative sources from the control-plane projection", async () => {
    const ctx = await createRouteTestContext()
    cleanup = ctx.cleanup

    const viewer = await exchangeJwt(ctx.env, "global-derivative-viewer")
    await completeUniqueHumanVerification(ctx.env, viewer.accessToken)
    const sourceOwner = await exchangeJwt(ctx.env, "global-derivative-source-owner")
    await completeUniqueHumanVerification(ctx.env, sourceOwner.accessToken)

    const sourceCommunityId = await createCommunityForTest({
      env: ctx.env,
      accessToken: sourceOwner.accessToken,
      displayName: "Global Source Club",
    })
    const composerCommunityId = await createCommunityForTest({
      env: ctx.env,
      accessToken: viewer.accessToken,
      displayName: "Global Composer Club",
    })

    await insertDerivativeSourceAsset({
      communityDbRoot: ctx.communityDbRoot,
      communityId: sourceCommunityId,
      creatorUserId: sourceOwner.userId,
      assetId: "ast_global_source",
      title: "Across the Water",
      assetKind: "song_audio",
      rightsBasis: "original",
      publicationStatus: "story_published",
      storyIpId: "0xaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaa",
      storyLicenseTermsId: "21",
    })
    await insertDerivativeSourceProjection({
      env: ctx.env,
      communityId: sourceCommunityId,
      creatorUserId: sourceOwner.userId,
      assetId: "ast_global_source",
      title: "Across the Water",
      assetKind: "song_audio",
      storyIpId: "0xaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaa",
      storyLicenseTermsId: "21",
    })
    await insertDerivativeSourceAsset({
      communityDbRoot: ctx.communityDbRoot,
      communityId: composerCommunityId,
      creatorUserId: viewer.userId,
      assetId: "ast_local_source",
      title: "Local Harbor",
      assetKind: "song_audio",
      rightsBasis: "original",
      publicationStatus: "story_published",
      storyIpId: "0xbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbb",
      storyLicenseTermsId: "22",
    })
    await insertDerivativeSourceProjection({
      env: ctx.env,
      communityId: composerCommunityId,
      creatorUserId: viewer.userId,
      assetId: "ast_local_source",
      title: "Local Harbor",
      assetKind: "song_audio",
      storyIpId: "0xbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbb",
      storyLicenseTermsId: "22",
    })
    await insertDerivativeSourceProjection({
      env: ctx.env,
      communityId: sourceCommunityId,
      creatorUserId: sourceOwner.userId,
      assetId: "ast_zero_share_global_source",
      title: "Free Parent",
      assetKind: "song_audio",
      storyIpId: "0xcccccccccccccccccccccccccccccccccccccccc",
      storyLicenseTermsId: "23",
      commercialRevSharePct: 0,
    })

    const response = await app.request(
      `http://pirate.test/communities/${composerCommunityId}/derivative-sources?scope=global&kind=song`,
      {
        headers: {
          authorization: `Bearer ${viewer.accessToken}`,
        },
      },
      ctx.env,
    )
    expect(response.status).toBe(200)
    const body = await json(response) as DerivativeSourceListBody
    expect(body.items.map((item) => item.asset).sort()).toEqual([
      "asset_ast_global_source",
      "asset_ast_local_source",
    ])
  })

  test("lists global derivative sources when composer membership stores a public user id", async () => {
    const ctx = await createRouteTestContext()
    cleanup = ctx.cleanup

    const viewer = await exchangeJwt(ctx.env, "global-derivative-public-member-viewer")
    await completeUniqueHumanVerification(ctx.env, viewer.accessToken)
    const sourceOwner = await exchangeJwt(ctx.env, "global-derivative-public-member-source-owner")
    await completeUniqueHumanVerification(ctx.env, sourceOwner.accessToken)

    const sourceCommunityId = await createCommunityForTest({
      env: ctx.env,
      accessToken: sourceOwner.accessToken,
      displayName: "Global Public Member Source Club",
    })
    const composerCommunityId = await createCommunityForTest({
      env: ctx.env,
      accessToken: viewer.accessToken,
      displayName: "Global Public Member Composer Club",
    })
    await rewriteCommunityAccessUserId({
      communityDbRoot: ctx.communityDbRoot,
      communityId: composerCommunityId,
      fromUserId: viewer.userId,
      toUserId: `usr_${viewer.userId}`,
    })
    const composerClient = createClient({
      url: buildLocalCommunityDbUrl(ctx.communityDbRoot, composerCommunityId),
    })
    try {
      const membershipRows = await composerClient.execute({
        sql: "SELECT user_id FROM community_memberships WHERE community_id = ?1 ORDER BY user_id",
        args: [composerCommunityId],
      })
      const roleRows = await composerClient.execute({
        sql: "SELECT user_id FROM community_roles WHERE community_id = ?1 ORDER BY user_id",
        args: [composerCommunityId],
      })
      expect(membershipRows.rows.map((row) => String(row.user_id))).toEqual([`usr_${viewer.userId}`])
      expect(roleRows.rows.map((row) => String(row.user_id))).toEqual([`usr_${viewer.userId}`])
    } finally {
      composerClient.close()
    }

    await insertDerivativeSourceProjection({
      env: ctx.env,
      communityId: sourceCommunityId,
      creatorUserId: sourceOwner.userId,
      assetId: "ast_global_public_member_source",
      title: "Public Member Source",
      assetKind: "song_audio",
      storyIpId: "0xcccccccccccccccccccccccccccccccccccccccc",
      storyLicenseTermsId: "23",
    })
    const directResult = await listDerivativeSources({
      env: ctx.env,
      userId: viewer.userId,
      scope: "global",
      communityId: composerCommunityId,
      kind: "song",
      query: null,
      limit: 25,
      communityRepository: getCommunityRepository(ctx.env),
      profileRepository: getProfileRepository(ctx.env),
    })
    expect(directResult.items.map((item) => item.asset)).toEqual(["asset_ast_global_public_member_source"])

    const response = await app.request(
      `http://pirate.test/communities/${composerCommunityId}/derivative-sources?scope=global&kind=song`,
      {
        headers: {
          authorization: `Bearer ${viewer.accessToken}`,
        },
      },
      ctx.env,
    )
    expect(response.status).toBe(200)
    const body = await json(response) as DerivativeSourceListBody
    expect(body.items.map((item) => item.asset)).toEqual(["asset_ast_global_public_member_source"])
  })

  test("global derivative sources require membership in the composer community", async () => {
    const ctx = await createRouteTestContext()
    cleanup = ctx.cleanup

    const viewer = await exchangeJwt(ctx.env, "global-composer-outsider")
    const communityOwner = await exchangeJwt(ctx.env, "global-composer-owner")
    await completeUniqueHumanVerification(ctx.env, communityOwner.accessToken)

    const composerCommunityId = await createCommunityForTest({
      env: ctx.env,
      accessToken: communityOwner.accessToken,
      displayName: "Global Composer Gate Club",
    })

    const response = await app.request(
      `http://pirate.test/communities/${composerCommunityId}/derivative-sources?scope=global&kind=song`,
      {
        headers: {
          authorization: `Bearer ${viewer.accessToken}`,
        },
      },
      ctx.env,
    )
    expect(response.status).toBe(404)
  })

  test("keeps community scope as the default derivative source behavior", async () => {
    const ctx = await createRouteTestContext()
    cleanup = ctx.cleanup

    const viewer = await exchangeJwt(ctx.env, "community-scope-derivative-viewer")
    await completeUniqueHumanVerification(ctx.env, viewer.accessToken)
    const sourceOwner = await exchangeJwt(ctx.env, "community-scope-source-owner")
    await completeUniqueHumanVerification(ctx.env, sourceOwner.accessToken)

    const sourceCommunityId = await createCommunityForTest({
      env: ctx.env,
      accessToken: sourceOwner.accessToken,
      displayName: "Community Scope Source Club",
    })
    const composerCommunityId = await createCommunityForTest({
      env: ctx.env,
      accessToken: viewer.accessToken,
      displayName: "Community Scope Composer Club",
    })

    await insertDerivativeSourceAsset({
      communityDbRoot: ctx.communityDbRoot,
      communityId: sourceCommunityId,
      creatorUserId: sourceOwner.userId,
      assetId: "ast_other_community_source",
      title: "Other Community Source",
      assetKind: "song_audio",
      rightsBasis: "original",
      publicationStatus: "story_published",
    })
    await insertDerivativeSourceAsset({
      communityDbRoot: ctx.communityDbRoot,
      communityId: composerCommunityId,
      creatorUserId: viewer.userId,
      assetId: "ast_composer_community_source",
      title: "Composer Community Source",
      assetKind: "song_audio",
      rightsBasis: "original",
      publicationStatus: "story_published",
    })

    for (const scopeQuery of ["scope=community&", ""]) {
      const response = await app.request(
        `http://pirate.test/communities/${composerCommunityId}/derivative-sources?${scopeQuery}kind=song`,
        {
          headers: {
            authorization: `Bearer ${viewer.accessToken}`,
          },
        },
        ctx.env,
      )
      expect(response.status).toBe(200)
      const body = await json(response) as DerivativeSourceListBody
      expect(body.items.map((item) => item.asset)).toEqual(["asset_ast_composer_community_source"])
    }
  })

  test("global derivative sources are not limited by source-community membership", async () => {
    const ctx = await createRouteTestContext()
    cleanup = ctx.cleanup

    const viewer = await exchangeJwt(ctx.env, "global-access-derivative-viewer")
    await completeUniqueHumanVerification(ctx.env, viewer.accessToken)
    const sourceOwner = await exchangeJwt(ctx.env, "global-access-source-owner")
    await completeUniqueHumanVerification(ctx.env, sourceOwner.accessToken)

    const bannedCommunityId = await createCommunityForTest({
      env: ctx.env,
      accessToken: sourceOwner.accessToken,
      displayName: "Banned Source Club",
    })
    const nonMemberCommunityId = await createCommunityForTest({
      env: ctx.env,
      accessToken: sourceOwner.accessToken,
      displayName: "Non Member Source Club",
    })
    const composerCommunityId = await createCommunityForTest({
      env: ctx.env,
      accessToken: viewer.accessToken,
      displayName: "Access Composer Club",
    })
    await setMembershipProjection({
      client: ctx.client,
      communityId: bannedCommunityId,
      userId: viewer.userId,
      state: "banned",
    })

    await insertDerivativeSourceAsset({
      communityDbRoot: ctx.communityDbRoot,
      communityId: bannedCommunityId,
      creatorUserId: sourceOwner.userId,
      assetId: "ast_banned_source",
      title: "Banned Source",
      assetKind: "song_audio",
      rightsBasis: "original",
      publicationStatus: "story_published",
    })
    await insertDerivativeSourceProjection({
      env: ctx.env,
      communityId: bannedCommunityId,
      creatorUserId: sourceOwner.userId,
      assetId: "ast_banned_source",
      title: "Banned Source",
      assetKind: "song_audio",
    })
    await insertDerivativeSourceAsset({
      communityDbRoot: ctx.communityDbRoot,
      communityId: nonMemberCommunityId,
      creatorUserId: sourceOwner.userId,
      assetId: "ast_non_member_source",
      title: "Non Member Source",
      assetKind: "song_audio",
      rightsBasis: "original",
      publicationStatus: "story_published",
    })
    await insertDerivativeSourceProjection({
      env: ctx.env,
      communityId: nonMemberCommunityId,
      creatorUserId: sourceOwner.userId,
      assetId: "ast_non_member_source",
      title: "Non Member Source",
      assetKind: "song_audio",
    })

    const response = await app.request(
      `http://pirate.test/communities/${composerCommunityId}/derivative-sources?scope=global&kind=song`,
      {
        headers: {
          authorization: `Bearer ${viewer.accessToken}`,
        },
      },
      ctx.env,
    )
    expect(response.status).toBe(200)
    const body = await json(response) as DerivativeSourceListBody
    expect(body.items.map((item) => item.asset).sort()).toEqual([
      "asset_ast_banned_source",
      "asset_ast_non_member_source",
    ])
  })

  test("global derivative source kind and query filters still apply", async () => {
    const ctx = await createRouteTestContext()
    cleanup = ctx.cleanup

    const viewer = await exchangeJwt(ctx.env, "global-filter-derivative-viewer")
    await completeUniqueHumanVerification(ctx.env, viewer.accessToken)
    const sourceOwner = await exchangeJwt(ctx.env, "global-filter-source-owner")
    await completeUniqueHumanVerification(ctx.env, sourceOwner.accessToken)

    const sourceCommunityId = await createCommunityForTest({
      env: ctx.env,
      accessToken: sourceOwner.accessToken,
      displayName: "Global Filter Source Club",
    })
    const composerCommunityId = await createCommunityForTest({
      env: ctx.env,
      accessToken: viewer.accessToken,
      displayName: "Global Filter Composer Club",
    })

    const longNeedleSongTitle = "Needle Song 2026-07-06T21:23:32.025Z exact smoke title"
    await insertDerivativeSourceAsset({
      communityDbRoot: ctx.communityDbRoot,
      communityId: sourceCommunityId,
      creatorUserId: sourceOwner.userId,
      assetId: "ast_filter_song",
      title: longNeedleSongTitle,
      assetKind: "song_audio",
      rightsBasis: "original",
      publicationStatus: "story_published",
    })
    await insertDerivativeSourceProjection({
      env: ctx.env,
      communityId: sourceCommunityId,
      creatorUserId: sourceOwner.userId,
      assetId: "ast_filter_song",
      title: longNeedleSongTitle,
      assetKind: "song_audio",
    })
    await insertDerivativeSourceAsset({
      communityDbRoot: ctx.communityDbRoot,
      communityId: sourceCommunityId,
      creatorUserId: sourceOwner.userId,
      assetId: "ast_filter_video",
      title: "Needle Video",
      assetKind: "video_file",
      rightsBasis: "original",
      publicationStatus: "story_published",
    })
    await insertDerivativeSourceProjection({
      env: ctx.env,
      communityId: sourceCommunityId,
      creatorUserId: sourceOwner.userId,
      assetId: "ast_filter_video",
      title: "Needle Video",
      assetKind: "video_file",
    })
    await insertDerivativeSourceProjection({
      env: ctx.env,
      communityId: sourceCommunityId,
      creatorUserId: sourceOwner.userId,
      assetId: "ast_filter_removed_song",
      title: "Needle Removed Song",
      assetKind: "song_audio",
      postStatus: "removed",
    })

    const videoResponse = await app.request(
      `http://pirate.test/communities/${composerCommunityId}/derivative-sources?scope=global&kind=video&q=Needle`,
      {
        headers: {
          authorization: `Bearer ${viewer.accessToken}`,
        },
      },
      ctx.env,
    )
    expect(videoResponse.status).toBe(200)
    const videoBody = await json(videoResponse) as DerivativeSourceListBody
    expect(videoBody.items.map((item) => item.asset)).toEqual(["asset_ast_filter_video"])

    const songResponse = await app.request(
      `http://pirate.test/communities/${composerCommunityId}/derivative-sources?scope=global&kind=song&q=Needle`,
      {
        headers: {
          authorization: `Bearer ${viewer.accessToken}`,
        },
      },
      ctx.env,
    )
    expect(songResponse.status).toBe(200)
    const songBody = await json(songResponse) as DerivativeSourceListBody
    expect(songBody.items.map((item) => item.asset)).toEqual(["asset_ast_filter_song"])

    const longSongResponse = await app.request(
      `http://pirate.test/communities/${composerCommunityId}/derivative-sources?scope=global&kind=song&q=${encodeURIComponent(longNeedleSongTitle)}`,
      {
        headers: {
          authorization: `Bearer ${viewer.accessToken}`,
        },
      },
      ctx.env,
    )
    expect(longSongResponse.status).toBe(200)
    const longSongBody = await json(longSongResponse) as DerivativeSourceListBody
    expect(longSongBody.items.map((item) => item.asset)).toEqual(["asset_ast_filter_song"])

    const missingResponse = await app.request(
      `http://pirate.test/communities/${composerCommunityId}/derivative-sources?scope=global&kind=song&q=Missing`,
      {
        headers: {
          authorization: `Bearer ${viewer.accessToken}`,
        },
      },
      ctx.env,
    )
    expect(missingResponse.status).toBe(200)
    const missingBody = await json(missingResponse) as DerivativeSourceListBody
    expect(missingBody.items).toEqual([])
  })

  test("requires derivative references when ACRCloud custom bucket returns a match", async () => {
    const storedObjects = new Map<string, { body: Uint8Array; contentType: string }>()

    ;(globalThis as { fetch: (input: RequestInfo | URL, init?: RequestInit) => Promise<Response> }).fetch = async (input: RequestInfo | URL, init?: RequestInit): Promise<Response> => {
      const request = input instanceof Request ? input : new Request(input, init)
      if (request.url === "https://openrouter.test/api/v1/chat/completions") {
        return Response.json({
          choices: [
            {
              message: {
                content: JSON.stringify({
                  age_gate_rating: "safe",
                  reason: "clean lyrics",
                }),
              },
            },
          ],
        })
      }

      if (request.url === "https://acrcloud.test/v1/identify") {
        return Response.json({
          status: {
            code: 0,
            msg: "Success",
          },
          metadata: {
            custom_files: [
              {
                acrid: "acr_match_1",
                bucket_id: "30358",
                score: 100,
              },
            ],
          },
        })
      }

      if (request.url === "https://elevenlabs.test/forced-alignment") {
        return Response.json({
          provider: "elevenlabs",
          segments: [
            {
              start_ms: 0,
              end_ms: 1800,
              text: "Line one",
            },
          ],
        })
      }

      if (!request.url.startsWith("https://s3.filebase.test/")) {
        return await originalFetch(request)
      }

      if (request.method === "POST" && new URL(request.url).searchParams.has("uploads")) {
        return new Response(
          "<InitiateMultipartUploadResult><UploadId>fixture-multipart-upload</UploadId></InitiateMultipartUploadResult>",
          { status: 200, headers: { "content-type": "application/xml" } },
        )
      }

      if (request.method === "PUT") {
        storedObjects.set(request.url, {
          body: new Uint8Array(await request.arrayBuffer()),
          contentType: request.headers.get("content-type") || "application/octet-stream",
        })
        return new Response(null, {
          status: 200,
          headers: { "x-amz-meta-cid": "bafysongartifactcid" },
        })
      }

      if (request.method === "GET") {
        const stored = storedObjects.get(request.url)
        if (!stored) {
          return new Response("missing", { status: 404 })
        }
        return new Response(stored.body.slice().buffer, {
          status: 200,
          headers: {
            "content-type": stored.contentType,
            "content-length": String(stored.body.byteLength),
          },
        })
      }

      return new Response("unexpected method", { status: 500 })
    }

    const ctx = await createRouteTestContext({
      FILEBASE_S3_ACCESS_KEY: "test-filebase-access",
      FILEBASE_S3_SECRET_KEY: "test-filebase-secret",
      FILEBASE_S3_ENDPOINT: "https://s3.filebase.test",
      FILEBASE_MEDIA_BUCKET: "pirate-media",
      OPENROUTER_API_KEY: "test-openrouter-key",
      OPENROUTER_BASE_URL: "https://openrouter.test/api/v1",
      OPENROUTER_MODEL: "google/gemini-3.1-flash-lite-preview",
      ACRCLOUD_ACCESS_KEY: "test-acrcloud-access",
      ACRCLOUD_ACCESS_SECRET: "test-acrcloud-secret",
      ACRCLOUD_HOST: "acrcloud.test",
      ELEVENLABS_API_KEY: "test-elevenlabs-key",
      ELEVENLABS_FORCE_ALIGNMENT_URL: "https://elevenlabs.test/forced-alignment",
    })
    cleanup = ctx.cleanup

    const author = await exchangeJwt(ctx.env, "song-author-custom-match")
    await attachPrimaryWallet({
      client: ctx.client,
      userId: author.userId,
      walletAttachmentId: "wal_song_author_custom_match",
      walletAddress: "0xaaa0000000000000000000000000000000000004",
    })
    installSuccessfulStoryRoyaltyRegistrarForTests()
    await completeUniqueHumanVerification(ctx.env, author.accessToken)

    const communityCreate = await requestJson(
      "http://pirate.test/communities",
      {
        display_name: "Song Match Club",
        membership_mode: "request",
        handle_policy: {
          policy_template: "standard",
        },
      },
      ctx.env,
      author.accessToken,
    )
    const communityCreateBody = await json(communityCreate) as {
      community: {
        id: string
      }
    }
    const communityId = communityCreateBody.community.id.replace(/^com_/, "")

    const uploadIntentBody = await uploadSongArtifact({
      env: ctx.env,
      communityId,
      accessToken: author.accessToken,
      artifactKind: "primary_audio",
      mimeType: "audio/mpeg",
      filename: "anthem.mp3",
      bytes: new Uint8Array([1, 2, 3, 4, 5, 6, 7, 8]),
    })

    const bundleCreate = await requestJson(
      `http://pirate.test/communities/${communityId}/song-artifacts`,
      {
        primary_audio: {
          song_artifact_upload: uploadIntentBody.id,
        },
        title: "Catalog Song",
        lyrics: "Line one",
      },
      ctx.env,
      author.accessToken,
    )
    expect(bundleCreate.status).toBe(201)
    const bundleBody = await json(bundleCreate) as {
      id: string
      moderation_result?: {
        analysis_state?: string
        audio_identification?: {
          match_found?: boolean
        }
      }
    }
    expect(bundleBody.moderation_result?.analysis_state).toBe("allow_with_required_reference")
    expect(bundleBody.moderation_result?.audio_identification?.match_found).toBe(true)

    const zeroShareParentIpId = "0x7777777777777777777777777777777777777777"
    await insertDerivativeSourceProjection({
      env: ctx.env,
      communityId,
      creatorUserId: author.userId,
      assetId: "ast_zero_share_raw_ref_parent",
      title: "Zero-share raw ref parent",
      assetKind: "song_audio",
      storyIpId: zeroShareParentIpId,
      storyLicenseTermsId: "17",
      commercialRevSharePct: 0,
    })
    const zeroSharePostCreate = await requestJson(
      `http://pirate.test/communities/${communityId}/posts`,
      {
        idempotency_key: "song-post-zero-share-raw-ref",
        post_type: "song",
        identity_mode: "public",
        title: "Zero-share raw ref remix",
        song_mode: "remix",
        rights_basis: "derivative",
        license_preset: "commercial-remix",
        commercial_rev_share_pct: 10,
        upstream_asset_refs: [`story:ip:${zeroShareParentIpId}#licenseTermsId=17`],
        song_artifact_bundle: bundleBody.id,
      },
      ctx.env,
      author.accessToken,
    )
    expect(zeroSharePostCreate.status).toBe(400)

    const blockedPostCreate = await requestJson(
      `http://pirate.test/communities/${communityId}/posts`,
      {
        idempotency_key: "song-post-match-no-refs",
        post_type: "song",
        identity_mode: "public",
        title: "Matched song",
        song_mode: "original",
        rights_basis: "original",
        song_artifact_bundle: bundleBody.id,
      },
      ctx.env,
      author.accessToken,
    )
    expect(blockedPostCreate.status).toBe(400)

    const allowedPostCreate = await requestJson(
      `http://pirate.test/communities/${communityId}/posts`,
      {
        idempotency_key: "song-post-match-with-refs",
        post_type: "song",
        identity_mode: "public",
        title: "Matched song derivative",
        song_mode: "remix",
        rights_basis: "derivative",
        license_preset: "commercial-remix",
        commercial_rev_share_pct: 10,
        upstream_asset_refs: ["acr:custom-file:acr_match_1"],
        song_artifact_bundle: bundleBody.id,
      },
      ctx.env,
      author.accessToken,
    )
    expect(allowedPostCreate.status).toBe(201)
  })
})
