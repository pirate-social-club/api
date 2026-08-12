import { afterEach, describe, expect, test } from "bun:test"
import { createClient } from "@libsql/client"
import { app } from "../../src/index"
import { buildLocalCommunityDbUrl } from "../../src/lib/communities/community-local-db"
import { decodePublicPostId } from "../../src/lib/public-ids"
import type { Env } from "../../src/types"
import { createRouteTestContext, json, mintUpstreamJwt, resetRuntimeCaches } from "../helpers"

let cleanup: (() => Promise<void>) | null = null

function requestJson(url: string, body: unknown, env: Env, token?: string, method = "POST"): Promise<Response> {
  return Promise.resolve(app.request(
    url,
    {
      method,
      headers: {
        "content-type": "application/json",
        ...(token ? { authorization: `Bearer ${token}` } : {}),
      },
      body: JSON.stringify(body),
    },
    env,
  ))
}

async function exchangeJwt(env: Env, sub: string): Promise<{ accessToken: string; userId: string }> {
  const jwt = await mintUpstreamJwt(env, { sub })
  const response = await requestJson("http://pirate.test/auth/session/exchange", {
    proof: {
      type: "jwt_based_auth",
      jwt,
    },
  }, env)
  const body = await json(response) as { access_token: string; user: { id: string } }
  return { accessToken: body.access_token, userId: body.user.id.replace(/^usr_/, "") }
}

async function createCommunity(env: Env, accessToken: string, displayName: string): Promise<{ communityId: string }> {
  const response = await requestJson("http://pirate.test/communities", {
    display_name: displayName,
    membership_mode: "request",
  }, env, accessToken)
  expect(response.status).toBe(202)
  const body = await json(response) as { community: { id: string } }
  return { communityId: body.community.id.replace(/^com_/, "") }
}

async function addCommunityMember(communityDbRoot: string, communityId: string, userId: string): Promise<void> {
  const client = createClient({
    url: buildLocalCommunityDbUrl(communityDbRoot, communityId),
  })
  try {
    const now = new Date().toISOString()
    await client.execute({
      sql: `
        INSERT INTO community_memberships (
          membership_id, community_id, user_id, status, joined_at, left_at, banned_at, created_at, updated_at
        ) VALUES (
          ?1, ?2, ?3, 'member', ?4, NULL, NULL, ?4, ?4
        )
      `,
      args: [`mbr_${communityId}_${userId}`, communityId, userId, now],
    })
  } finally {
    client.close()
  }
}

async function seedRightsReviewCase(input: {
  communityDbRoot: string
  communityId: string
  postId: string
  caseId?: string
  analysisId?: string
  subjectAssetId?: string
}): Promise<{ caseId: string; analysisId: string }> {
  const client = createClient({
    url: buildLocalCommunityDbUrl(input.communityDbRoot, input.communityId),
  })
  try {
    const now = new Date().toISOString()
    const caseId = input.caseId ?? `rrc_${crypto.randomUUID().replace(/-/g, "")}`
    const analysisId = input.analysisId ?? `mar_${crypto.randomUUID().replace(/-/g, "")}`
    await client.execute({
      sql: `
        INSERT INTO media_analysis_results (
          media_analysis_result_id, community_id, source_post_id, source_asset_id,
          outcome, content_safety_state, age_gate_policy,
          trigger_sources_json, acrcloud_music_match_json, acrcloud_custom_match_json,
          acrcloud_error_code, acrcloud_error_message, acrcloud_checked_at,
          safety_signals_json, authenticity_signals_json,
          policy_reason_code, policy_reason, created_at, updated_at
        ) VALUES (
          ?1, ?2, ?3, NULL,
          'allow_with_required_reference', 'pending', 'none',
          ?4, NULL, ?5,
          NULL, NULL, ?6,
          NULL, NULL,
          'undeclared_catalog_match', 'Catalog song matched without a declared source', ?6, ?6
        )
      `,
      args: [
        analysisId,
        input.communityId,
        input.postId,
        JSON.stringify({ source: "video_media_analysis" }),
        JSON.stringify([{ title: "Catalog Smoke Song", acrid: "acr_test" }]),
        now,
      ],
    })
    await client.execute({
      sql: `
        INSERT INTO rights_review_cases (
          rights_review_case_id, subject_type, subject_id, community_id,
          status, trigger_source, analysis_result_ref, created_at, updated_at
        ) VALUES (?1, 'post', ?2, ?3, 'open', 'acrcloud_match', ?4, ?5, ?5)
      `,
      args: [caseId, input.postId, input.communityId, analysisId, now],
    })
    await client.execute({
      sql: `
        INSERT INTO rights_holds (
          rights_hold_id, subject_type, subject_id, community_id, hold_type,
          source_case_id, analysis_result_ref, status, reason_code, reason,
          created_at, updated_at
        ) VALUES (
          ?1, 'post', ?2, ?3, 'reference_required',
          ?4, ?5, 'active', 'undeclared_catalog_match', 'Catalog song matched without a declared source',
          ?6, ?6
        )
      `,
      args: [`rhold_${caseId}`, input.postId, input.communityId, caseId, analysisId, now],
    })
    if (input.subjectAssetId) {
      await client.execute({
        sql: `
          INSERT INTO assets (
            asset_id, community_id, source_post_id, creator_user_id, asset_kind, rights_basis,
            access_mode, primary_content_ref, publication_status, story_status,
            locked_delivery_status, created_at, updated_at
          ) VALUES (
            ?1, ?2, ?3, 'usr_rights_owner', 'video_file', 'original',
            'public', ?4, 'story_published', 'published',
            'none', ?5, ?5
          )
        `,
        args: [input.subjectAssetId, input.communityId, input.postId, `video:${input.subjectAssetId}`, now],
      })
      await client.execute({
        sql: "UPDATE posts SET asset_id = ?2, updated_at = ?3 WHERE post_id = ?1",
        args: [input.postId, input.subjectAssetId, now],
      })
    }
    return { caseId, analysisId }
  } finally {
    client.close()
  }
}

async function readRightsHolds(input: {
  communityDbRoot: string
  communityId: string
}): Promise<Array<{ subject_type: string; subject_id: string; hold_type: string; status: string; released_at: string | null }>> {
  const client = createClient({
    url: buildLocalCommunityDbUrl(input.communityDbRoot, input.communityId),
  })
  try {
    const result = await client.execute(`
      SELECT subject_type, subject_id, hold_type, status, released_at
      FROM rights_holds
      ORDER BY created_at ASC, rights_hold_id ASC
    `)
    return result.rows.map((row) => ({
      subject_type: String(row.subject_type),
      subject_id: String(row.subject_id),
      hold_type: String(row.hold_type),
      status: String(row.status),
      released_at: typeof row.released_at === "string" ? row.released_at : null,
    }))
  } finally {
    client.close()
  }
}

async function seedSourceSongAsset(input: {
  communityDbRoot: string
  communityId: string
  sourcePostId: string
  assetId: string
  songArtifactBundleId: string
}): Promise<void> {
  const client = createClient({
    url: buildLocalCommunityDbUrl(input.communityDbRoot, input.communityId),
  })
  try {
    const now = new Date().toISOString()
    await client.execute({
      sql: `
        INSERT INTO assets (
          asset_id, community_id, source_post_id, song_artifact_bundle_id, creator_user_id, asset_kind, rights_basis,
          access_mode, primary_content_ref, publication_status, story_status,
          locked_delivery_status, created_at, updated_at
        ) VALUES (
          ?1, ?2, ?3, ?4, 'usr_rights_owner', 'song_audio', 'original',
          'locked', ?5, 'story_published', 'published',
          'ready', ?6, ?6
        )
      `,
      args: [
        input.assetId,
        input.communityId,
        input.sourcePostId,
        input.songArtifactBundleId,
        `song:${input.assetId}`,
        now,
      ],
    })
  } finally {
    client.close()
  }
}

async function readPostRightsMetadata(input: {
  communityDbRoot: string
  communityId: string
  postId: string
}): Promise<{ upstreamAssetRefsJson: string | null; derivativeLinks: Array<{ asset_id: string; upstream_asset_id: string }> }> {
  const client = createClient({
    url: buildLocalCommunityDbUrl(input.communityDbRoot, input.communityId),
  })
  try {
    const post = await client.execute({
      sql: "SELECT upstream_asset_refs_json FROM posts WHERE post_id = ?1",
      args: [input.postId],
    })
    const links = await client.execute(`
      SELECT asset_id, upstream_asset_id
      FROM asset_derivative_links
      ORDER BY asset_id, upstream_asset_id
    `)
    return {
      upstreamAssetRefsJson: typeof post.rows[0]?.upstream_asset_refs_json === "string"
        ? post.rows[0].upstream_asset_refs_json
        : null,
      derivativeLinks: links.rows.map((row) => ({
        asset_id: String(row.asset_id),
        upstream_asset_id: String(row.upstream_asset_id),
      })),
    }
  } finally {
    client.close()
  }
}

async function setStoryRoyaltyRegistrationStatus(input: {
  communityDbRoot: string
  communityId: string
  assetId: string
  status: "none" | "pending" | "registered"
  completeRegistration?: boolean
}): Promise<void> {
  const client = createClient({
    url: buildLocalCommunityDbUrl(input.communityDbRoot, input.communityId),
  })
  try {
    await client.execute({
      sql: `
        UPDATE assets
        SET story_royalty_registration_status = ?2,
            story_ip_id = ?3,
            story_license_terms_id = ?4,
            updated_at = ?5
        WHERE asset_id = ?1
      `,
      args: [
        input.assetId,
        input.status,
        input.status === "registered" && input.completeRegistration !== false ? "0xStoryIp" : null,
        input.status === "registered" && input.completeRegistration !== false ? "1" : null,
        new Date().toISOString(),
      ],
    })
  } finally {
    client.close()
  }
}

afterEach(async () => {
  resetRuntimeCaches()
  if (cleanup) {
    await cleanup()
    cleanup = null
  }
})

describe("rights review routes", () => {
  test("owners can list, read, and resolve rights review cases", async () => {
    const ctx = await createRouteTestContext()
    cleanup = ctx.cleanup

    const owner = await exchangeJwt(ctx.env, "rights-review-owner")
    const community = await createCommunity(ctx.env, owner.accessToken, "Rights Review Club")

    const createdPost = await requestJson(
      `http://pirate.test/communities/${community.communityId}/posts`,
      {
        post_type: "text",
        title: "Catalog match video",
        body: "Represents a video post with an undeclared soundtrack match",
        idempotency_key: "rights-review-post-1",
      },
      ctx.env,
      owner.accessToken,
    )
    expect(createdPost.status).toBe(201)
    const postBody = await json(createdPost) as { id: string }
    const rawPostId = decodePublicPostId(postBody.id)
    const sourcePost = await requestJson(
      `http://pirate.test/communities/${community.communityId}/posts`,
      {
        post_type: "text",
        title: "Catalog source song",
        body: "Represents the matched source song post",
        idempotency_key: "rights-review-source-post-1",
      },
      ctx.env,
      owner.accessToken,
    )
    expect(sourcePost.status).toBe(201)
    const sourcePostBody = await json(sourcePost) as { id: string }
    const rawSourcePostId = decodePublicPostId(sourcePostBody.id)
    await seedSourceSongAsset({
      communityDbRoot: ctx.communityDbRoot,
      communityId: community.communityId,
      sourcePostId: rawSourcePostId,
      assetId: "ast_source_song",
      songArtifactBundleId: "sab_catalog_song",
    })
    const seeded = await seedRightsReviewCase({
      communityDbRoot: ctx.communityDbRoot,
      communityId: community.communityId,
      postId: rawPostId,
      subjectAssetId: "ast_review_video",
    })

    const cases = await app.request(
      `http://pirate.test/communities/${community.communityId}/rights-review/cases`,
      {
        headers: {
          authorization: `Bearer ${owner.accessToken}`,
        },
      },
      ctx.env,
    )
    expect(cases.status).toBe(200)
    const casesBody = await json(cases) as {
      items: Array<{
        rights_review_case_id: string
        status: string
        trigger_source: string
        analysis: { media_analysis_result_id: string; outcome: string; acrcloud_custom_match: unknown } | null
        post: { post_id: string; title: string | null } | null
      }>
    }
    expect(casesBody.items).toHaveLength(1)
    expect(casesBody.items[0]?.rights_review_case_id).toBe(seeded.caseId)
    expect(casesBody.items[0]?.status).toBe("open")
    expect(casesBody.items[0]?.trigger_source).toBe("acrcloud_match")
    expect(casesBody.items[0]?.analysis?.media_analysis_result_id).toBe(seeded.analysisId)
    expect(casesBody.items[0]?.analysis?.outcome).toBe("allow_with_required_reference")
    expect(casesBody.items[0]?.post?.post_id).toBe(rawPostId)

    const detail = await app.request(
      `http://pirate.test/communities/${community.communityId}/rights-review/cases/${seeded.caseId}`,
      {
        headers: {
          authorization: `Bearer ${owner.accessToken}`,
        },
      },
      ctx.env,
    )
    expect(detail.status).toBe(200)
    const detailBody = await json(detail) as {
      case: { rights_review_case_id: string; status: string }
      analysis: { policy_reason_code: string | null } | null
      post: { post_id: string; title: string | null } | null
    }
    expect(detailBody.case.rights_review_case_id).toBe(seeded.caseId)
    expect(detailBody.case.status).toBe("open")
    expect(detailBody.analysis?.policy_reason_code).toBe("undeclared_catalog_match")
    expect(detailBody.post?.post_id).toBe(rawPostId)

    const invalidClear = await requestJson(
      `http://pirate.test/communities/${community.communityId}/rights-review/cases/${seeded.caseId}/actions`,
      {
        action_type: "clear_with_upstream_refs",
      },
      ctx.env,
      owner.accessToken,
    )
    expect(invalidClear.status).toBe(400)

    await setStoryRoyaltyRegistrationStatus({
      communityDbRoot: ctx.communityDbRoot,
      communityId: community.communityId,
      assetId: "ast_review_video",
      status: "registered",
    })
    const unsafePlainClear = await requestJson(
      `http://pirate.test/communities/${community.communityId}/rights-review/cases/${seeded.caseId}/actions`,
      { action_type: "clear" },
      ctx.env,
      owner.accessToken,
    )
    expect(unsafePlainClear.status).toBe(409)
    expect((await json(unsafePlainClear) as { code: string; details: { asset_id: string } })).toMatchObject({
      code: "story_lineage_correction_required",
      details: { asset_id: "ast_review_video" },
    })
    const registeredCases = await app.request(
      `http://pirate.test/communities/${community.communityId}/rights-review/cases`,
      { headers: { authorization: `Bearer ${owner.accessToken}` } },
      ctx.env,
    )
    expect(registeredCases.status).toBe(200)
    expect((await json(registeredCases) as {
      items: Array<{ story_royalty_registration_status: string | null }>
    }).items[0]?.story_royalty_registration_status).toBe("registered")

    const unsafeStoryClear = await requestJson(
      `http://pirate.test/communities/${community.communityId}/rights-review/cases/${seeded.caseId}/actions`,
      {
        action_type: "clear_with_upstream_refs",
        evidence_refs: [`song-bundle:${community.communityId}:sab_catalog_song`],
      },
      ctx.env,
      owner.accessToken,
    )
    expect(unsafeStoryClear.status).toBe(409)
    const unsafeStoryClearBody = await json(unsafeStoryClear) as {
      code: string
      details: { asset_id: string }
    }
    expect(unsafeStoryClearBody).toMatchObject({
      code: "story_lineage_correction_required",
      details: { asset_id: "ast_review_video" },
    })
    expect(await readPostRightsMetadata({
      communityDbRoot: ctx.communityDbRoot,
      communityId: community.communityId,
      postId: rawPostId,
    })).toEqual({
      upstreamAssetRefsJson: null,
      derivativeLinks: [],
    })
    expect((await readRightsHolds({
      communityDbRoot: ctx.communityDbRoot,
      communityId: community.communityId,
    }))[0]?.status).toBe("active")

    await setStoryRoyaltyRegistrationStatus({
      communityDbRoot: ctx.communityDbRoot,
      communityId: community.communityId,
      assetId: "ast_review_video",
      status: "registered",
      completeRegistration: false,
    })
    const incompleteStoryClear = await requestJson(
      `http://pirate.test/communities/${community.communityId}/rights-review/cases/${seeded.caseId}/actions`,
      { action_type: "clear" },
      ctx.env,
      owner.accessToken,
    )
    expect(incompleteStoryClear.status).toBe(409)
    expect((await json(incompleteStoryClear) as { code: string }).code).toBe("story_lineage_correction_required")

    await setStoryRoyaltyRegistrationStatus({
      communityDbRoot: ctx.communityDbRoot,
      communityId: community.communityId,
      assetId: "ast_review_video",
      status: "pending",
    })
    const pendingStoryClear = await requestJson(
      `http://pirate.test/communities/${community.communityId}/rights-review/cases/${seeded.caseId}/actions`,
      {
        action_type: "clear_with_upstream_refs",
        evidence_refs: [`song-bundle:${community.communityId}:sab_catalog_song`],
      },
      ctx.env,
      owner.accessToken,
    )
    expect(pendingStoryClear.status).toBe(409)
    expect((await json(pendingStoryClear) as { code: string }).code).toBe("story_lineage_correction_required")

    await setStoryRoyaltyRegistrationStatus({
      communityDbRoot: ctx.communityDbRoot,
      communityId: community.communityId,
      assetId: "ast_review_video",
      status: "none",
    })

    const action = await requestJson(
      `http://pirate.test/communities/${community.communityId}/rights-review/cases/${seeded.caseId}/actions`,
      {
        action_type: "clear_with_upstream_refs",
        evidence_refs: [`song-bundle:${community.communityId}:sab_catalog_song`],
      },
      ctx.env,
      owner.accessToken,
    )
    expect(action.status).toBe(200)
    const actionBody = await json(action) as {
      case: {
        status: string
        resolution: string | null
        resolver_user_id: string | null
        resolved_at: string | null
        submitted_evidence_refs: unknown
      }
      analysis: { resolved_at: string | null } | null
      post: { upstream_asset_refs: string[] | null } | null
    }
    expect(actionBody.case.status).toBe("resolved")
    expect(actionBody.case.resolution).toBe("clear_with_upstream_refs")
    expect(actionBody.case.resolver_user_id).toBe(owner.userId)
    expect(typeof actionBody.case.resolved_at).toBe("string")
    expect(actionBody.case.submitted_evidence_refs).toEqual([`song-bundle:${community.communityId}:sab_catalog_song`])
    expect(typeof actionBody.analysis?.resolved_at).toBe("string")
    expect(actionBody.post?.upstream_asset_refs).toEqual(["story:asset:ast_source_song"])

    const rightsMetadata = await readPostRightsMetadata({
      communityDbRoot: ctx.communityDbRoot,
      communityId: community.communityId,
      postId: rawPostId,
    })
    expect(JSON.parse(rightsMetadata.upstreamAssetRefsJson ?? "[]")).toEqual(["story:asset:ast_source_song"])
    expect(rightsMetadata.derivativeLinks).toEqual([{
      asset_id: "ast_review_video",
      upstream_asset_id: "ast_source_song",
    }])
    const holdsAfterClear = await readRightsHolds({
      communityDbRoot: ctx.communityDbRoot,
      communityId: community.communityId,
    })
    expect(holdsAfterClear).toHaveLength(1)
    expect(holdsAfterClear[0]?.status).toBe("released")
    expect(typeof holdsAfterClear[0]?.released_at).toBe("string")

    const activeAfterResolve = await app.request(
      `http://pirate.test/communities/${community.communityId}/rights-review/cases`,
      {
        headers: {
          authorization: `Bearer ${owner.accessToken}`,
        },
      },
      ctx.env,
    )
    expect(activeAfterResolve.status).toBe(200)
    const activeAfterResolveBody = await json(activeAfterResolve) as { items: Array<unknown> }
    expect(activeAfterResolveBody.items).toHaveLength(0)
  }, 15_000)

  test("block action creates an active blocked rights hold", async () => {
    const ctx = await createRouteTestContext()
    cleanup = ctx.cleanup

    const owner = await exchangeJwt(ctx.env, "rights-review-block-owner")
    const community = await createCommunity(ctx.env, owner.accessToken, "Rights Review Block Club")

    const createdPost = await requestJson(
      `http://pirate.test/communities/${community.communityId}/posts`,
      {
        post_type: "text",
        title: "Rights blocked video",
        body: "Represents a blocked rights case",
        idempotency_key: "rights-review-block-post-1",
      },
      ctx.env,
      owner.accessToken,
    )
    expect(createdPost.status).toBe(201)
    const postBody = await json(createdPost) as { id: string }
    const rawPostId = decodePublicPostId(postBody.id)
    const seeded = await seedRightsReviewCase({
      communityDbRoot: ctx.communityDbRoot,
      communityId: community.communityId,
      postId: rawPostId,
    })

    const action = await requestJson(
      `http://pirate.test/communities/${community.communityId}/rights-review/cases/${seeded.caseId}/actions`,
      {
        action_type: "block",
      },
      ctx.env,
      owner.accessToken,
    )
    expect(action.status).toBe(200)
    const actionBody = await json(action) as { case: { status: string; resolution: string | null } }
    expect(actionBody.case.status).toBe("blocked")
    expect(actionBody.case.resolution).toBe("block")

    const holds = await readRightsHolds({
      communityDbRoot: ctx.communityDbRoot,
      communityId: community.communityId,
    })
    expect(holds).toHaveLength(1)
    expect(holds[0]).toMatchObject({
      subject_type: "post",
      subject_id: rawPostId,
      hold_type: "blocked",
      status: "active",
      released_at: null,
    })
  }, 15_000)

  test("community members cannot read rights review cases", async () => {
    const ctx = await createRouteTestContext()
    cleanup = ctx.cleanup

    const owner = await exchangeJwt(ctx.env, "rights-review-denied-owner")
    const community = await createCommunity(ctx.env, owner.accessToken, "Rights Review Denied Club")

    const member = await exchangeJwt(ctx.env, "rights-review-denied-member")
    await addCommunityMember(ctx.communityDbRoot, community.communityId, member.userId)

    const denied = await app.request(
      `http://pirate.test/communities/${community.communityId}/rights-review/cases`,
      {
        headers: {
          authorization: `Bearer ${member.accessToken}`,
        },
      },
      ctx.env,
    )
    expect(denied.status).toBe(403)
  })
})
