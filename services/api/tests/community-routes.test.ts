import { createHash } from "node:crypto"
import { afterEach, beforeEach, describe, expect, test } from "bun:test"
import { createClient, type Client } from "@libsql/client"
import app from "../src/index"
import {
  requestJson,
  requestBytes,
  withMockedAcrcloudIdentify,
  exchangeJwt,
  prepareVerifiedNamespace,
  prepareVerifiedSpacesNamespace,
  completeUniqueHumanVerification,
  addCommunityMember,
  setCommunityMembershipMode,
  addCommunityRole,
  insertCommunityListing,
  readPurchaseQuoteRow,
  readAssetRow,
  readMediaAnalysisRow,
  countDerivativeLinks,
  countRightsReviewCases,
  insertOpenRightsReviewCase,
  readProjectionStatus,
  setPostStatus,
  setAssetCdrFields,
  expirePurchaseQuote,
  setPrimaryWalletAttachment,
  buildSongMediaRef,
  setPassportWalletScore,
  setVerifiedUserNationality,
  createCompletedSongArtifactUpload,
  buildUploadBytes,
  buildWavBytes,
  readPurchaseRow,
  readPurchaseEntitlementRow,
} from "./community-test-helpers"
import { bootstrapLocalCommunityDb, buildLocalCommunityDbUrl } from "../src/lib/communities/community-local-db"
import { getCommunityPurchaseQuoteById } from "../src/lib/communities/community-purchase-quote-store"
import { createRightsReviewCase } from "../src/lib/posts/community-post-store"
import { getControlPlaneSongArtifactBundleRepository } from "../src/lib/posts/control-plane-song-artifact-repository"
import { createRouteTestContext, json, mintUpstreamJwt, resetRuntimeCaches } from "./helpers"
import type { Env } from "../src/types"


let cleanup: (() => Promise<void>) | null = null

beforeEach(() => {
  resetRuntimeCaches()
})

afterEach(async () => {
  if (cleanup) {
    await cleanup()
    cleanup = null
  }
})

describe("community routes", () => {
  test("community create, job fetch, post create, and post read work through the full route stack", async () => {
    const ctx = await createRouteTestContext()
    cleanup = ctx.cleanup

    const session = await exchangeJwt(ctx.env, "community-user")
    const namespaceVerificationId = await prepareVerifiedNamespace(ctx.env, session.accessToken)

    const communityCreate = await requestJson("http://pirate.test/communities", {
      display_name: "Pirate Test Club",
      namespace: {
        namespace_verification_id: namespaceVerificationId,
      },
    }, ctx.env, session.accessToken)
    expect(communityCreate.status).toBe(202)
    const communityCreateBody = await json(communityCreate) as {
      community: {
        community_id: string
        community_stage: string | null
        civic_scale_tier: string | null
        display_name: string
        member_count: number | null
        namespace_verification_id: string | null
        provisioning_state: string
        qualified_member_count: number | null
        registry_publication_state: string
        registry_publication_job_id: string | null
        status: string
      }
      job: { job_id: string; status: string }
    }
    expect(communityCreateBody.community.display_name).toBe("Pirate Test Club")
    expect(communityCreateBody.community.namespace_verification_id).toBe(namespaceVerificationId)
    expect(communityCreateBody.community.provisioning_state).toBe("active")
    expect(communityCreateBody.community.registry_publication_state).toBe("published")
    expect(typeof communityCreateBody.community.registry_publication_job_id).toBe("string")
    expect(communityCreateBody.community.status).toBe("active")
    expect(communityCreateBody.community.community_stage).toBe("initial")
    expect(communityCreateBody.community.civic_scale_tier).toBe("club")
    expect(communityCreateBody.community.member_count).toBe(1)
    expect(communityCreateBody.community.qualified_member_count).toBe(1)
    expect(communityCreateBody.job.status).toBe("succeeded")

    const registryRefs = await ctx.client.execute({
      sql: `
        SELECT attempts_table_name, club_registry_table_name, club_namespace_table_name
        FROM community_registry_table_refs
        WHERE community_id = ?1
        LIMIT 1
      `,
      args: [communityCreateBody.community.community_id],
    })
    expect(registryRefs.rows).toHaveLength(1)
    expect(String(registryRefs.rows[0]?.attempts_table_name || "")).not.toBe("")
    expect(String(registryRefs.rows[0]?.club_registry_table_name || "")).not.toBe("")
    expect(String(registryRefs.rows[0]?.club_namespace_table_name || "")).not.toBe("")

    const communityGet = await app.request(
      `http://pirate.test/communities/${communityCreateBody.community.community_id}`,
      {
        headers: {
          authorization: `Bearer ${session.accessToken}`,
        },
      },
      ctx.env,
    )
    expect(communityGet.status).toBe(200)
    const communityGetBody = await json(communityGet) as {
      community_stage: string | null
      civic_scale_tier: string | null
      member_count: number | null
      qualified_member_count: number | null
    }
    expect(communityGetBody.community_stage).toBe("initial")
    expect(communityGetBody.civic_scale_tier).toBe("club")
    expect(communityGetBody.member_count).toBe(1)
    expect(communityGetBody.qualified_member_count).toBe(1)

    const jobGet = await app.request(
      `http://pirate.test/jobs/${communityCreateBody.job.job_id}`,
      {
        headers: {
          authorization: `Bearer ${session.accessToken}`,
        },
      },
      ctx.env,
    )
    expect(jobGet.status).toBe(200)
    const jobBody = await json(jobGet) as { status: string; subject_id: string }
    expect(jobBody.status).toBe("succeeded")
    expect(jobBody.subject_id).toBe(communityCreateBody.community.community_id)

    const registryJob = await app.request(
      `http://pirate.test/jobs/${communityCreateBody.community.registry_publication_job_id}`,
      {
        headers: {
          authorization: `Bearer ${session.accessToken}`,
        },
      },
      ctx.env,
    )
    expect(registryJob.status).toBe(200)
    const registryJobBody = await json(registryJob) as { job_type: string; status: string; subject_id: string }
    expect(registryJobBody.job_type).toBe("community_registry_publication")
    expect(registryJobBody.status).toBe("succeeded")
    expect(registryJobBody.subject_id).toBe(communityCreateBody.community.community_id)

    const createdPost = await requestJson(
      `http://pirate.test/communities/${communityCreateBody.community.community_id}/posts`,
      {
        post_type: "text",
        title: "Hello Pirate",
        body: "Testing the local community flow.",
        idempotency_key: "post-key-1",
      },
      ctx.env,
      session.accessToken,
    )
    expect(createdPost.status).toBe(201)
    const postBody = await json(createdPost) as {
      post_id: string
      community_id: string
      status: string
      title: string | null
      author_user_id: string | null
    }
    expect(postBody.community_id).toBe(communityCreateBody.community.community_id)
    expect(postBody.status).toBe("published")
    expect(postBody.title).toBe("Hello Pirate")
    expect(postBody.author_user_id).toBe(session.userId)

    const retriedPost = await requestJson(
      `http://pirate.test/communities/${communityCreateBody.community.community_id}/posts`,
      {
        post_type: "text",
        title: "Hello Pirate",
        body: "Testing the local community flow.",
        idempotency_key: "post-key-1",
      },
      ctx.env,
      session.accessToken,
    )
    expect(retriedPost.status).toBe(201)
    const retriedPostBody = await json(retriedPost) as {
      post_id: string
      community_id: string
      status: string
    }
    expect(retriedPostBody.post_id).toBe(postBody.post_id)
    expect(retriedPostBody.community_id).toBe(postBody.community_id)
    expect(retriedPostBody.status).toBe("published")

    const fetchedPost = await app.request(
      `http://pirate.test/posts/${postBody.post_id}?locale=es`,
      {
        headers: {
          authorization: `Bearer ${session.accessToken}`,
        },
      },
      ctx.env,
    )
    expect(fetchedPost.status).toBe(200)
    const fetchedPostBody = await json(fetchedPost) as {
      post: { post_id: string; title: string | null }
      resolved_locale: string
      translation_state: string
    }
    expect(fetchedPostBody.post.post_id).toBe(postBody.post_id)
    expect(fetchedPostBody.post.title).toBe("Hello Pirate")
    expect(fetchedPostBody.resolved_locale).toBe("es")
    expect(fetchedPostBody.translation_state).toBe("same_language")

    const reviewHeldPost = await requestJson(
      `http://pirate.test/communities/${communityCreateBody.community.community_id}/posts`,
      {
        post_type: "text",
        title: "[review-required] Hello Pirate",
        body: "Force the local review-held stub path.",
        idempotency_key: "post-key-review-required",
      },
      ctx.env,
      session.accessToken,
    )
    expect(reviewHeldPost.status).toBe(202)
    const reviewHeldPostBody = await json(reviewHeldPost) as {
      post_id: string
      community_id: string
      status: string
      analysis_state: string
      content_safety_state: string
    }
    expect(reviewHeldPostBody.community_id).toBe(communityCreateBody.community.community_id)
    expect(reviewHeldPostBody.status).toBe("draft")
    expect(reviewHeldPostBody.analysis_state).toBe("review_required")
    expect(reviewHeldPostBody.content_safety_state).toBe("pending")

    const fetchedReviewHeldPost = await app.request(
      `http://pirate.test/posts/${reviewHeldPostBody.post_id}?locale=es`,
      {
        headers: {
          authorization: `Bearer ${session.accessToken}`,
        },
      },
      ctx.env,
    )
    expect(fetchedReviewHeldPost.status).toBe(200)
    const fetchedReviewHeldPostBody = await json(fetchedReviewHeldPost) as {
      post: {
        post_id: string
        status: string
        analysis_state: string
        content_safety_state: string
      }
      resolved_locale: string
    }
    expect(fetchedReviewHeldPostBody.post.post_id).toBe(reviewHeldPostBody.post_id)
    expect(fetchedReviewHeldPostBody.post.status).toBe("draft")
    expect(fetchedReviewHeldPostBody.post.analysis_state).toBe("review_required")
    expect(fetchedReviewHeldPostBody.post.content_safety_state).toBe("pending")
    expect(fetchedReviewHeldPostBody.resolved_locale).toBe("es")

    const reviewQueue = await app.request(
      `http://pirate.test/communities/${communityCreateBody.community.community_id}/moderation-cases`,
      {
        headers: {
          authorization: `Bearer ${session.accessToken}`,
        },
      },
      ctx.env,
    )
    expect(reviewQueue.status).toBe(200)
    const reviewQueueBody = await json(reviewQueue) as {
      items: Array<{
        post_id: string
        opened_by: string
        queue_scope: string
        status: string
      }>
    }
    expect(reviewQueueBody.items.some((item) => item.post_id === reviewHeldPostBody.post_id)).toBe(true)
    const heldCase = reviewQueueBody.items.find((item) => item.post_id === reviewHeldPostBody.post_id)
    expect(heldCase?.opened_by).toBe("platform_analysis")
    expect(heldCase?.queue_scope).toBe("community")
    expect(heldCase?.status).toBe("open")

    const blockedPost = await requestJson(
      `http://pirate.test/communities/${communityCreateBody.community.community_id}/posts`,
      {
        post_type: "text",
        title: "[blocked] Hello Pirate",
        body: "Force the local blocked stub path.",
        idempotency_key: "post-key-blocked",
      },
      ctx.env,
      session.accessToken,
    )
    expect(blockedPost.status).toBe(422)
    const blockedPostBody = await json(blockedPost) as { code: string }
    expect(blockedPostBody.code).toBe("analysis_blocked")

    const controlPlaneProjectionCount = await ctx.client.execute({
      sql: `
        SELECT COUNT(*) AS count
        FROM community_post_projections
        WHERE community_id = ?1
      `,
      args: [communityCreateBody.community.community_id],
    })
    expect(Number(controlPlaneProjectionCount.rows[0]?.count ?? 0)).toBe(2)

    const communityDb = createClient({
      url: buildLocalCommunityDbUrl(ctx.communityDbRoot, communityCreateBody.community.community_id),
    })
    try {
      const communityPostCount = await communityDb.execute({
        sql: `
          SELECT COUNT(*) AS count
          FROM posts
          WHERE community_id = ?1
        `,
        args: [communityCreateBody.community.community_id],
      })
      expect(Number(communityPostCount.rows[0]?.count ?? 0)).toBe(2)
    } finally {
      communityDb.close()
    }

    const listedPosts = await app.request(
      `http://pirate.test/communities/${communityCreateBody.community.community_id}/posts?locale=es`,
      {
        headers: {
          authorization: `Bearer ${session.accessToken}`,
        },
      },
      ctx.env,
    )
    expect(listedPosts.status).toBe(200)
    const listedPostsBody = await json(listedPosts) as {
      items: Array<{
        post: { post_id: string; status: string }
        resolved_locale: string
      }>
      next_cursor: string | null
    }
    expect(listedPostsBody.items).toHaveLength(1)
    expect(listedPostsBody.items[0]?.post.post_id).toBe(postBody.post_id)
    expect(listedPostsBody.items[0]?.post.status).toBe("published")
    expect(listedPostsBody.items[0]?.resolved_locale).toBe("es")
    expect(listedPostsBody.items.some((item) => item.post.post_id === reviewHeldPostBody.post_id)).toBe(false)
    expect(listedPostsBody.next_cursor).toBeNull()
  })

  test("members can report posts and moderators can resolve moderation cases", async () => {
    const ctx = await createRouteTestContext()
    cleanup = ctx.cleanup

    const owner = await exchangeJwt(ctx.env, "moderation-owner")
    const namespaceVerificationId = await prepareVerifiedNamespace(ctx.env, owner.accessToken)

    const communityCreate = await requestJson("http://pirate.test/communities", {
      display_name: "Pirate Moderation Club",
      namespace: {
        namespace_verification_id: namespaceVerificationId,
      },
    }, ctx.env, owner.accessToken)
    expect(communityCreate.status).toBe(202)
    const communityCreateBody = await json(communityCreate) as {
      community: { community_id: string }
    }

    const createdPost = await requestJson(
      `http://pirate.test/communities/${communityCreateBody.community.community_id}/posts`,
      {
        post_type: "text",
        title: "Reportable post",
        body: "This post will be reported by another member.",
        idempotency_key: "moderation-report-post",
      },
      ctx.env,
      owner.accessToken,
    )
    expect(createdPost.status).toBe(201)
    const createdPostBody = await json(createdPost) as { post_id: string }

    const reporter = await exchangeJwt(ctx.env, "moderation-reporter")
    await completeUniqueHumanVerification(ctx.env, reporter.accessToken)
    await addCommunityMember(ctx.communityDbRoot, communityCreateBody.community.community_id, reporter.userId)

    const createdReport = await requestJson(
      `http://pirate.test/communities/${communityCreateBody.community.community_id}/posts/${createdPostBody.post_id}/reports`,
      {
        reason_code: "harassment",
        note: "Member flagged this for review.",
      },
      ctx.env,
      reporter.accessToken,
    )
    expect(createdReport.status).toBe(201)
    const createdReportBody = await json(createdReport) as {
      user_report_id: string
      reporter_user_id: string
      reason_code: string
    }
    expect(createdReportBody.user_report_id).toMatch(/^urp_/)
    expect(createdReportBody.reporter_user_id).toBe(reporter.userId)
    expect(createdReportBody.reason_code).toBe("harassment")

    const duplicateReport = await requestJson(
      `http://pirate.test/communities/${communityCreateBody.community.community_id}/posts/${createdPostBody.post_id}/reports`,
      {
        reason_code: "harassment",
      },
      ctx.env,
      reporter.accessToken,
    )
    expect(duplicateReport.status).toBe(409)

    const reporterQueueRead = await app.request(
      `http://pirate.test/communities/${communityCreateBody.community.community_id}/moderation-cases`,
      {
        headers: {
          authorization: `Bearer ${reporter.accessToken}`,
        },
      },
      ctx.env,
    )
    expect(reporterQueueRead.status).toBe(403)

    const ownerQueueRead = await app.request(
      `http://pirate.test/communities/${communityCreateBody.community.community_id}/moderation-cases`,
      {
        headers: {
          authorization: `Bearer ${owner.accessToken}`,
        },
      },
      ctx.env,
    )
    expect(ownerQueueRead.status).toBe(200)
    const ownerQueueBody = await json(ownerQueueRead) as {
      items: Array<{
        moderation_case_id: string
        status: string
        opened_by: string
        queue_scope: string
        priority: string
      }>
    }
    expect(ownerQueueBody.items).toHaveLength(1)
    const moderationCaseId = ownerQueueBody.items[0]?.moderation_case_id ?? ""
    expect(moderationCaseId).toMatch(/^mcs_/)
    expect(ownerQueueBody.items[0]?.status).toBe("open")
    expect(ownerQueueBody.items[0]?.opened_by).toBe("user_report")
    expect(ownerQueueBody.items[0]?.queue_scope).toBe("community")
    expect(ownerQueueBody.items[0]?.priority).toBe("low")

    const ownerCaseDetail = await app.request(
      `http://pirate.test/communities/${communityCreateBody.community.community_id}/moderation-cases/${moderationCaseId}`,
      {
        headers: {
          authorization: `Bearer ${owner.accessToken}`,
        },
      },
      ctx.env,
    )
    expect(ownerCaseDetail.status).toBe(200)
    const ownerCaseBody = await json(ownerCaseDetail) as {
      case: { moderation_case_id: string; status: string }
      post: { post_id: string; status: string }
      reports: Array<{ reporter_user_id: string }>
      signals: Array<unknown>
      actions: Array<unknown>
    }
    expect(ownerCaseBody.case.moderation_case_id).toBe(moderationCaseId)
    expect(ownerCaseBody.case.status).toBe("open")
    expect(ownerCaseBody.post.post_id).toBe(createdPostBody.post_id)
    expect(ownerCaseBody.post.status).toBe("published")
    expect(ownerCaseBody.reports).toHaveLength(1)
    expect(ownerCaseBody.reports[0]?.reporter_user_id).toBe(reporter.userId)
    expect(ownerCaseBody.signals).toHaveLength(0)
    expect(ownerCaseBody.actions).toHaveLength(0)

    const resolvedCase = await requestJson(
      `http://pirate.test/communities/${communityCreateBody.community.community_id}/moderation-cases/${moderationCaseId}/actions`,
      {
        action_type: "remove",
        note: "Removed after review.",
      },
      ctx.env,
      owner.accessToken,
    )
    expect(resolvedCase.status).toBe(200)
    const resolvedCaseBody = await json(resolvedCase) as {
      case: { status: string; resolved_at: string | null }
      post: { status: string }
      actions: Array<{
        action_type: string
        previous_post_status: string | null
        next_post_status: string | null
      }>
    }
    expect(resolvedCaseBody.case.status).toBe("resolved")
    expect(resolvedCaseBody.case.resolved_at).not.toBeNull()
    expect(resolvedCaseBody.post.status).toBe("removed")
    expect(resolvedCaseBody.actions).toHaveLength(1)
    expect(resolvedCaseBody.actions[0]?.action_type).toBe("remove")
    expect(resolvedCaseBody.actions[0]?.previous_post_status).toBe("published")
    expect(resolvedCaseBody.actions[0]?.next_post_status).toBe("removed")

    const openQueueAfterResolution = await app.request(
      `http://pirate.test/communities/${communityCreateBody.community.community_id}/moderation-cases`,
      {
        headers: {
          authorization: `Bearer ${owner.accessToken}`,
        },
      },
      ctx.env,
    )
    expect(openQueueAfterResolution.status).toBe(200)
    const openQueueAfterResolutionBody = await json(openQueueAfterResolution) as {
      items: Array<unknown>
    }
    expect(openQueueAfterResolutionBody.items).toHaveLength(0)

    const resolvedQueue = await app.request(
      `http://pirate.test/communities/${communityCreateBody.community.community_id}/moderation-cases?status=resolved`,
      {
        headers: {
          authorization: `Bearer ${owner.accessToken}`,
        },
      },
      ctx.env,
    )
    expect(resolvedQueue.status).toBe(200)
    const resolvedQueueBody = await json(resolvedQueue) as {
      items: Array<{ moderation_case_id: string; status: string }>
    }
    expect(resolvedQueueBody.items).toHaveLength(1)
    expect(resolvedQueueBody.items[0]?.moderation_case_id).toBe(moderationCaseId)
    expect(resolvedQueueBody.items[0]?.status).toBe("resolved")

    const secondReporter = await exchangeJwt(ctx.env, "moderation-second-reporter")
    await completeUniqueHumanVerification(ctx.env, secondReporter.accessToken)
    await addCommunityMember(ctx.communityDbRoot, communityCreateBody.community.community_id, secondReporter.userId)
    const reportRemovedPost = await requestJson(
      `http://pirate.test/communities/${communityCreateBody.community.community_id}/posts/${createdPostBody.post_id}/reports`,
      {
        reason_code: "misleading",
      },
      ctx.env,
      secondReporter.accessToken,
    )
    expect(reportRemovedPost.status).toBe(201)

    const reporterReadRemovedPost = await app.request(
      `http://pirate.test/posts/${createdPostBody.post_id}`,
      {
        headers: {
          authorization: `Bearer ${reporter.accessToken}`,
        },
      },
      ctx.env,
    )
    expect(reporterReadRemovedPost.status).toBe(404)
  })

  test("community list returns only communities created by the caller", async () => {
    const ctx = await createRouteTestContext()
    cleanup = ctx.cleanup

    const owner = await exchangeJwt(ctx.env, "community-list-owner")
    const other = await exchangeJwt(ctx.env, "community-list-other")

    const ownerNamespaceOne = await prepareVerifiedNamespace(ctx.env, owner.accessToken, "owner-list-root-one")
    const ownerNamespaceTwo = await prepareVerifiedNamespace(ctx.env, owner.accessToken, "owner-list-root-two")
    const otherNamespace = await prepareVerifiedNamespace(ctx.env, other.accessToken, "other-list-root-one")

    await requestJson("http://pirate.test/communities", {
      display_name: "Owner Club One",
      namespace: {
        namespace_verification_id: ownerNamespaceOne,
      },
    }, ctx.env, owner.accessToken)
    await requestJson("http://pirate.test/communities", {
      display_name: "Owner Club Two",
      namespace: {
        namespace_verification_id: ownerNamespaceTwo,
      },
    }, ctx.env, owner.accessToken)
    await requestJson("http://pirate.test/communities", {
      display_name: "Other Club",
      namespace: {
        namespace_verification_id: otherNamespace,
      },
    }, ctx.env, other.accessToken)

    const listed = await app.request(
      "http://pirate.test/communities",
      {
        headers: {
          authorization: `Bearer ${owner.accessToken}`,
        },
      },
      ctx.env,
    )

    expect(listed.status).toBe(200)
    const body = await json(listed) as {
      items: Array<{ display_name: string; created_by_user_id: string }>
      next_cursor: string | null
    }
    expect(body.items).toHaveLength(2)
    expect(body.items.map((item) => item.display_name)).toEqual(["Owner Club Two", "Owner Club One"])
    expect(body.items.every((item) => item.created_by_user_id === owner.userId)).toBe(true)
    expect(body.next_cursor).toBeNull()
  })

  test("community discovery excludes active communities that are not published", async () => {
    const ctx = await createRouteTestContext()
    cleanup = ctx.cleanup

    const owner = await exchangeJwt(ctx.env, "discover-unpublished-owner")
    const namespaceVerificationId = await prepareVerifiedNamespace(ctx.env, owner.accessToken, "discover-unpublished-root")

    const communityCreate = await requestJson("http://pirate.test/communities", {
      display_name: "Should Disappear",
      namespace: {
        namespace_verification_id: namespaceVerificationId,
      },
    }, ctx.env, owner.accessToken)
    expect(communityCreate.status).toBe(202)
    const communityCreateBody = await json(communityCreate) as {
      community: { community_id: string }
    }

    await ctx.client.execute({
      sql: `
        UPDATE communities
        SET registry_publication_state = 'publication_error',
            registry_error_code = 'manual_test_state'
        WHERE community_id = ?1
      `,
      args: [communityCreateBody.community.community_id],
    })

    const discovered = await app.request(
      "http://pirate.test/communities/discover?limit=10",
      {},
      ctx.env,
    )
    expect(discovered.status).toBe(200)
    const discoveredBody = await json(discovered) as {
      items: Array<{ community_id: string }>
    }
    expect(discoveredBody.items.some((item) => item.community_id === communityCreateBody.community.community_id)).toBe(false)
  })

  test("public community read resolves normalized root label without auth", async () => {
    const ctx = await createRouteTestContext()
    cleanup = ctx.cleanup

    const owner = await exchangeJwt(ctx.env, "public-community-read-owner")
    const namespaceVerificationId = await prepareVerifiedNamespace(ctx.env, owner.accessToken, "infinity")

    const communityCreate = await requestJson("http://pirate.test/communities", {
      display_name: "Infinity",
      namespace: {
        namespace_verification_id: namespaceVerificationId,
      },
    }, ctx.env, owner.accessToken)
    expect(communityCreate.status).toBe(202)

    const communityResponse = await app.request("http://pirate.test/communities/infinity", {}, ctx.env)
    expect(communityResponse.status).toBe(200)
    const communityBody = await json(communityResponse) as {
      community_id: string
      display_name: string
      provisioning_state: string
      registry_publication_state: string
    }
    expect(communityBody.community_id).toMatch(/^cmt_/)
    expect(communityBody.display_name).toBe("Infinity")
    expect(communityBody.provisioning_state).toBe("active")
    expect(communityBody.registry_publication_state).toBe("published")
  })

  test("public community namespace lookup resolves plain normalized root label without auth", async () => {
    const ctx = await createRouteTestContext()
    cleanup = ctx.cleanup

    const owner = await exchangeJwt(ctx.env, "public-community-namespace-read-owner")
    const namespaceVerificationId = await prepareVerifiedNamespace(ctx.env, owner.accessToken, "infinity-namespace")

    const communityCreate = await requestJson("http://pirate.test/communities", {
      display_name: "Infinity Namespace",
      namespace: {
        namespace_verification_id: namespaceVerificationId,
      },
    }, ctx.env, owner.accessToken)
    expect(communityCreate.status).toBe(202)

    const communityResponse = await app.request(
      "http://pirate.test/communities/by-namespace/infinity-namespace",
      {},
      ctx.env,
    )
    expect(communityResponse.status).toBe(200)
    const communityBody = await json(communityResponse) as {
      community_id: string
      display_name: string
      namespace_verification_id: string | null
    }
    expect(communityBody.community_id).toMatch(/^cmt_/)
    expect(communityBody.display_name).toBe("Infinity Namespace")
    expect(typeof communityBody.namespace_verification_id).toBe("string")
  })

  test("public community namespace lookup rejects @-prefixed HNS labels without auth", async () => {
    const ctx = await createRouteTestContext()
    cleanup = ctx.cleanup

    const owner = await exchangeJwt(ctx.env, "public-community-read-with-at-owner")
    const namespaceVerificationId = await prepareVerifiedNamespace(ctx.env, owner.accessToken, "at-infinity")

    const communityCreate = await requestJson("http://pirate.test/communities", {
      display_name: "At Infinity",
      namespace: {
        namespace_verification_id: namespaceVerificationId,
      },
    }, ctx.env, owner.accessToken)
    expect(communityCreate.status).toBe(202)

    const communityResponse = await app.request(
      "http://pirate.test/communities/by-namespace/%40at-infinity",
      {},
      ctx.env,
    )
    expect(communityResponse.status).toBe(404)
  })

  test("public community namespace lookup resolves @-prefixed Spaces labels without auth", async () => {
    const ctx = await createRouteTestContext({
      ALLOW_STUB_NAMESPACE_VERIFICATION: "true",
    })
    cleanup = ctx.cleanup

    const owner = await exchangeJwt(ctx.env, "public-community-read-spaces-owner")
    const namespaceVerificationId = await prepareVerifiedSpacesNamespace(ctx.env, owner.accessToken, "@pirate")

    const communityCreate = await requestJson("http://pirate.test/communities", {
      display_name: "Pirate",
      namespace: {
        namespace_verification_id: namespaceVerificationId,
      },
    }, ctx.env, owner.accessToken)
    expect(communityCreate.status).toBe(202)

    const communityResponse = await app.request(
      "http://pirate.test/communities/by-namespace/%40pirate",
      {},
      ctx.env,
    )
    expect(communityResponse.status).toBe(200)
    const communityBody = await json(communityResponse) as {
      community_id: string
      display_name: string
      namespace_verification_id: string | null
    }
    expect(communityBody.community_id).toMatch(/^cmt_/)
    expect(communityBody.display_name).toBe("Pirate")
    expect(typeof communityBody.namespace_verification_id).toBe("string")
  })

  test("public community posts resolve normalized root label without auth", async () => {
    const ctx = await createRouteTestContext()
    cleanup = ctx.cleanup

    const owner = await exchangeJwt(ctx.env, "public-community-posts-owner")
    const namespaceVerificationId = await prepareVerifiedNamespace(ctx.env, owner.accessToken, "infinity-posts")

    const communityCreate = await requestJson("http://pirate.test/communities", {
      display_name: "Infinity Posts",
      namespace: {
        namespace_verification_id: namespaceVerificationId,
      },
    }, ctx.env, owner.accessToken)
    expect(communityCreate.status).toBe(202)
    const communityCreateBody = await json(communityCreate) as {
      community: { community_id: string }
    }

    const createdPost = await requestJson(
      `http://pirate.test/communities/${communityCreateBody.community.community_id}/posts`,
      {
        post_type: "text",
        title: "Public infinity post",
        body: "Visible without auth.",
        idempotency_key: "public-infinity-post",
      },
      ctx.env,
      owner.accessToken,
    )
    expect(createdPost.status).toBe(201)
    const createdPostBody = await json(createdPost) as { post_id: string }

    const listedPosts = await app.request("http://pirate.test/communities/infinity-posts/posts", {}, ctx.env)
    expect(listedPosts.status).toBe(200)
    const listedPostsBody = await json(listedPosts) as {
      items: Array<{ post: { post_id: string } }>
      next_cursor: string | null
    }
    expect(listedPostsBody.items).toHaveLength(1)
    expect(listedPostsBody.items[0]?.post.post_id).toBe(createdPostBody.post_id)
    expect(listedPostsBody.next_cursor).toBeNull()
  })

  test("public community posts reject @-prefixed HNS labels without auth", async () => {
    const ctx = await createRouteTestContext()
    cleanup = ctx.cleanup

    const owner = await exchangeJwt(ctx.env, "public-community-posts-with-at-owner")
    const namespaceVerificationId = await prepareVerifiedNamespace(ctx.env, owner.accessToken, "at-infinity-posts")

    const communityCreate = await requestJson("http://pirate.test/communities", {
      display_name: "At Infinity Posts",
      namespace: {
        namespace_verification_id: namespaceVerificationId,
      },
    }, ctx.env, owner.accessToken)
    expect(communityCreate.status).toBe(202)

    const listedPosts = await app.request(
      "http://pirate.test/communities/%40at-infinity-posts/posts",
      {},
      ctx.env,
    )
    expect(listedPosts.status).toBe(404)
  })

  test("community create fails when no registry publisher is configured and the local stub is not allowed", async () => {
    const ctx = await createRouteTestContext({
      ALLOW_LOCAL_STUB_REGISTRY_PUBLICATION: "false",
    })
    cleanup = ctx.cleanup

    const session = await exchangeJwt(ctx.env, "community-no-publisher-user")
    const namespaceVerificationId = await prepareVerifiedNamespace(ctx.env, session.accessToken, "no-publisher-root")

    const communityCreate = await requestJson("http://pirate.test/communities", {
      display_name: "No Publisher Club",
      namespace: {
        namespace_verification_id: namespaceVerificationId,
      },
    }, ctx.env, session.accessToken)

    expect(communityCreate.status).toBe(500)
    const body = await json(communityCreate) as { error?: { message?: string }; message?: string }
    expect(body.error?.message ?? body.message).toBe("REGISTRY_PUBLISHER_URL is not configured")
  })

  test("community create fails outside local environments when no provision operator is configured", async () => {
    const ctx = await createRouteTestContext()
    cleanup = ctx.cleanup

    const session = await exchangeJwt(ctx.env, "community-no-provision-operator-user")
    const namespaceVerificationId = await prepareVerifiedNamespace(ctx.env, session.accessToken, "no-provision-operator")

    const productionEnv = {
      ...ctx.env,
      ENVIRONMENT: "production",
      ALLOW_LOCAL_STUB_REGISTRY_PUBLICATION: "true",
    }

    const communityCreate = await requestJson("http://pirate.test/communities", {
      display_name: "No Provision Operator Club",
      namespace: {
        namespace_verification_id: namespaceVerificationId,
      },
    }, productionEnv, session.accessToken)

    expect(communityCreate.status).toBe(500)
    const body = await json(communityCreate) as { error?: { message?: string }; message?: string }
    expect(body.error?.message ?? body.message).toBe("COMMUNITY_PROVISION_OPERATOR_BASE_URL is not configured")
  })

  test("community create provisions through the private operator when configured", async () => {
    const operatorToken = "operator-test-token"
    const operatorBaseUrl = "http://operator.test"
    const wrapKey = "11".repeat(32)
    const originalFetch = globalThis.fetch
    const ctx = await createRouteTestContext()
    cleanup = ctx.cleanup

    globalThis.fetch = (async (input, init) => {
      const requestUrl = typeof input === "string" ? input : input instanceof URL ? input.toString() : input.url
      if (!requestUrl.startsWith(operatorBaseUrl)) {
        return originalFetch(input as never, init)
      }

      const url = new URL(requestUrl)
      const authorization = init?.headers instanceof Headers
        ? init.headers.get("authorization")
        : Array.isArray(init?.headers)
          ? init?.headers.find(([key]) => key.toLowerCase() === "authorization")?.[1]
          : init?.headers && "authorization" in init.headers
            ? String((init.headers as Record<string, unknown>).authorization)
            : null

      if (authorization !== `Bearer ${operatorToken}`) {
        return new Response(JSON.stringify({ error_code: "operator_unauthorized" }), {
          status: 401,
          headers: { "content-type": "application/json" },
        })
      }

      if (url.pathname !== "/internal/v0/community-provisioning/provision") {
        return new Response("not found", { status: 404 })
      }

      const body = init?.body ? JSON.parse(String(init.body)) as {
        community_id: string
        creator_user_id: string
        display_name: string
        namespace_verification_id: string
        created_at: string
        bootstrap_payload: {
          description?: string | null
          namespace_label: string
          membership_mode: "open" | "request" | "gated"
          default_age_gate_policy: "none" | "18_plus"
          allow_anonymous_identity: boolean
          anonymous_identity_scope?: "community_stable" | "thread_stable" | "post_ephemeral" | null
          governance_mode: "centralized"
          handle_policy_template: string
          gate_rules: Array<{
            scope: "membership" | "viewer" | "posting"
            gate_family: "token_holding" | "identity_proof"
            gate_type: string
            proof_requirements_json: string
            chain_namespace: string | null
            gate_config_json: string | null
          }>
        }
      } : null
      if (!body) {
        return new Response(JSON.stringify({ error_code: "missing_body" }), {
          status: 400,
          headers: { "content-type": "application/json" },
        })
      }

      const databaseUrl = buildLocalCommunityDbUrl(ctx.communityDbRoot, body.community_id)
      await bootstrapLocalCommunityDb({
        rootDir: ctx.communityDbRoot,
        communityId: body.community_id,
        createdByUserId: body.creator_user_id,
        displayName: body.display_name,
        description: body.bootstrap_payload.description ?? null,
        namespaceVerificationId: body.namespace_verification_id,
        namespaceLabel: body.bootstrap_payload.namespace_label,
        membershipMode: body.bootstrap_payload.membership_mode,
        defaultAgeGatePolicy: body.bootstrap_payload.default_age_gate_policy,
        allowAnonymousIdentity: body.bootstrap_payload.allow_anonymous_identity,
        anonymousIdentityScope: body.bootstrap_payload.anonymous_identity_scope ?? null,
        governanceMode: body.bootstrap_payload.governance_mode,
        handlePolicyTemplate: body.bootstrap_payload.handle_policy_template,
        pricingModel: null,
        gateRules: body.bootstrap_payload.gate_rules.map((rule) => ({
          scope: rule.scope,
          gateFamily: rule.gate_family,
          gateType: rule.gate_type,
          proofRequirementsJson: rule.proof_requirements_json,
          chainNamespace: rule.chain_namespace,
          gateConfigJson: rule.gate_config_json,
        })),
        now: body.created_at,
      })

      return new Response(JSON.stringify({
        organization_slug: "pirate-social",
        group_name: "club-cmt-private-operator",
        group_id: "grp_private_operator",
        database_name: "main-cmt-private-operator",
        database_id: "db_private_operator",
        database_url: databaseUrl,
        location: "aws-us-east-1",
        token_name: `worker-${body.community_id}-v1`,
        plaintext_token: "operator-db-token",
        issued_at: body.created_at,
        expires_at: null,
      }), {
        headers: { "content-type": "application/json" },
      })
    }) as typeof globalThis.fetch

    try {
      const session = await exchangeJwt(ctx.env, "community-private-operator-user")
      const namespaceVerificationId = await prepareVerifiedNamespace(ctx.env, session.accessToken, "private-operator-root")
      const productionEnv = {
        ...ctx.env,
        ENVIRONMENT: "production",
        TURSO_COMMUNITY_DB_WRAP_KEY: wrapKey,
        TURSO_COMMUNITY_DB_WRAP_KEY_VERSION: "3",
        COMMUNITY_PROVISION_OPERATOR_BASE_URL: operatorBaseUrl,
        COMMUNITY_PROVISION_OPERATOR_AUTH_TOKEN: operatorToken,
        COMMUNITY_PROVISION_OPERATOR_TIMEOUT_MS: "1000",
        COMMUNITY_PROVISION_DEFAULT_GROUP_LOCATION: "aws-us-east-1",
        ALLOW_LOCAL_STUB_REGISTRY_PUBLICATION: "true",
      }

      const communityCreate = await requestJson("http://pirate.test/communities", {
        display_name: "Private Operator Club",
        namespace: {
          namespace_verification_id: namespaceVerificationId,
        },
      }, productionEnv, session.accessToken)

      expect(communityCreate.status).toBe(202)
      const body = await json(communityCreate) as {
        community: {
          community_id: string
          provisioning_state: string
        }
        job: {
          status: string
        }
      }
      expect(body.job.status).toBe("succeeded")
      expect(body.community.provisioning_state).toBe("active")

      const bindingRows = await ctx.client.execute({
        sql: `
          SELECT organization_slug, database_name, database_url, status
          FROM community_database_bindings
          WHERE community_id = ?1
            AND binding_role = 'primary'
          LIMIT 1
        `,
        args: [body.community.community_id],
      })
      expect(bindingRows.rows).toHaveLength(1)
      expect(String(bindingRows.rows[0]?.organization_slug)).toBe("pirate-social")
      expect(String(bindingRows.rows[0]?.database_name)).toBe("main-cmt-private-operator")
      expect(String(bindingRows.rows[0]?.status)).toBe("active")
      expect(String(bindingRows.rows[0]?.database_url)).toBe(
        buildLocalCommunityDbUrl(ctx.communityDbRoot, body.community.community_id),
      )

      const credentialRows = await ctx.client.execute({
        sql: `
          SELECT token_name, encryption_key_version, status
          FROM community_db_credentials
          WHERE community_database_binding_id = (
            SELECT community_database_binding_id
            FROM community_database_bindings
            WHERE community_id = ?1
              AND binding_role = 'primary'
            LIMIT 1
          )
        `,
        args: [body.community.community_id],
      })
      expect(credentialRows.rows).toHaveLength(1)
      expect(String(credentialRows.rows[0]?.token_name)).toBe(`worker-${body.community.community_id}-v1`)
      expect(Number(credentialRows.rows[0]?.encryption_key_version)).toBe(3)
      expect(String(credentialRows.rows[0]?.status)).toBe("active")
    } finally {
      globalThis.fetch = originalFetch
    }
  })

  test("community discovery ranks by qualified_member_count instead of raw member inflation", async () => {
    const ctx = await createRouteTestContext()
    cleanup = ctx.cleanup

    const ownerA = await exchangeJwt(ctx.env, "discover-owner-a")
    const ownerB = await exchangeJwt(ctx.env, "discover-owner-b")
    const walletJoinerOne = await exchangeJwt(ctx.env, "discover-wallet-joiner-one")
    const walletJoinerTwo = await exchangeJwt(ctx.env, "discover-wallet-joiner-two")
    const verifiedJoiner = await exchangeJwt(ctx.env, "discover-verified-joiner")

    const namespaceA = await prepareVerifiedNamespace(ctx.env, ownerA.accessToken, "discover-root-a")
    const namespaceB = await prepareVerifiedNamespace(ctx.env, ownerB.accessToken, "discover-root-b")

    const communityAResponse = await requestJson("http://pirate.test/communities", {
      display_name: "Inflated Raw Club",
      namespace: {
        namespace_verification_id: namespaceA,
      },
    }, ctx.env, ownerA.accessToken)
    expect(communityAResponse.status).toBe(202)
    const communityABody = await json(communityAResponse) as {
      community: { community_id: string }
    }

    const communityBResponse = await requestJson("http://pirate.test/communities", {
      display_name: "Qualified Club",
      namespace: {
        namespace_verification_id: namespaceB,
      },
    }, ctx.env, ownerB.accessToken)
    expect(communityBResponse.status).toBe(202)
    const communityBBody = await json(communityBResponse) as {
      community: { community_id: string }
    }

    await setPassportWalletScore(ctx.env, walletJoinerOne.userId, {
      score: 120,
      scoreThreshold: 100,
      passingScore: true,
    })
    await setPassportWalletScore(ctx.env, walletJoinerTwo.userId, {
      score: 140,
      scoreThreshold: 100,
      passingScore: true,
    })

    const walletJoinAOne = await app.request(
      `http://pirate.test/communities/${communityABody.community.community_id}/join`,
      {
        method: "POST",
        headers: {
          authorization: `Bearer ${walletJoinerOne.accessToken}`,
        },
      },
      ctx.env,
    )
    expect(walletJoinAOne.status).toBe(200)

    const walletJoinATwo = await app.request(
      `http://pirate.test/communities/${communityABody.community.community_id}/join`,
      {
        method: "POST",
        headers: {
          authorization: `Bearer ${walletJoinerTwo.accessToken}`,
        },
      },
      ctx.env,
    )
    expect(walletJoinATwo.status).toBe(200)

    await completeUniqueHumanVerification(ctx.env, verifiedJoiner.accessToken, "self")
    const verifiedJoinB = await app.request(
      `http://pirate.test/communities/${communityBBody.community.community_id}/join`,
      {
        method: "POST",
        headers: {
          authorization: `Bearer ${verifiedJoiner.accessToken}`,
        },
      },
      ctx.env,
    )
    expect(verifiedJoinB.status).toBe(200)

    const controlPlaneCounts = await ctx.client.execute({
      sql: `
        SELECT community_id, projected_member_count, projected_qualified_member_count
        FROM communities
        WHERE community_id IN (?1, ?2)
        ORDER BY community_id ASC
      `,
      args: [communityABody.community.community_id, communityBBody.community.community_id],
    })
    const countByCommunityId = Object.fromEntries(
      controlPlaneCounts.rows.map((row) => [
        String(row.community_id),
        {
          projected_member_count: Number(row.projected_member_count),
          projected_qualified_member_count: Number(row.projected_qualified_member_count),
        },
      ]),
    )
    expect(countByCommunityId[communityBBody.community.community_id]).toEqual({
      projected_member_count: 2,
      projected_qualified_member_count: 2,
    })
    expect(countByCommunityId[communityABody.community.community_id]).toEqual({
      projected_member_count: 3,
      projected_qualified_member_count: 1,
    })

    await ctx.client.execute({
      sql: `
        UPDATE community_database_bindings
        SET database_url = 'invalid://discover-broken',
            updated_at = CURRENT_TIMESTAMP
        WHERE community_id = ?1
          AND binding_role = 'primary'
      `,
      args: [communityABody.community.community_id],
    })

    const discovered = await app.request(
      "http://pirate.test/communities/discover?limit=10",
      {},
      ctx.env,
    )
    expect(discovered.status).toBe(200)
    const discoveredBody = await json(discovered) as {
      items: Array<{
        community_id: string
        display_name: string
        member_count: number | null
        qualified_member_count: number | null
      }>
      next_cursor: string | null
    }
    expect(discoveredBody.items.slice(0, 2).map((item) => item.display_name)).toEqual([
      "Qualified Club",
      "Inflated Raw Club",
    ])
    expect(discoveredBody.items[0]?.qualified_member_count).toBe(2)
    expect(discoveredBody.items[0]?.member_count).toBe(2)
    expect(discoveredBody.items[1]?.qualified_member_count).toBe(1)
    expect(discoveredBody.items[1]?.member_count).toBe(3)
    expect(discoveredBody.next_cursor).toBeNull()
  })

  test("community patch updates mutable local fields and marks published communities stale", async () => {
    const ctx = await createRouteTestContext()
    cleanup = ctx.cleanup

    const owner = await exchangeJwt(ctx.env, "community-patch-owner")
    const namespaceVerificationId = await prepareVerifiedNamespace(ctx.env, owner.accessToken, "patch-root-one")

    const communityCreate = await requestJson("http://pirate.test/communities", {
      display_name: "Patch Club",
      namespace: {
        namespace_verification_id: namespaceVerificationId,
      },
    }, ctx.env, owner.accessToken)
    expect(communityCreate.status).toBe(202)
    const communityCreateBody = await json(communityCreate) as {
      community: {
        community_id: string
        registry_publication_state: string
        description: string | null
        membership_mode: string
        default_age_gate_policy: string
      }
    }
    expect(communityCreateBody.community.registry_publication_state).toBe("published")

    const patched = await requestJson(
      `http://pirate.test/communities/${communityCreateBody.community.community_id}`,
      {
        description: "Updated patch description",
        membership_mode: "request",
        allow_anonymous_identity: true,
        anonymous_identity_scope: "thread_stable",
        default_age_gate_policy: "none",
      },
      ctx.env,
      owner.accessToken,
      "PATCH",
    )

    expect(patched.status).toBe(200)
    const patchedBody = await json(patched) as {
      community_id: string
      description: string | null
      membership_mode: string
      allow_anonymous_identity: boolean
      anonymous_identity_scope: string | null
      default_age_gate_policy: string
      registry_publication_state: string
    }
    expect(patchedBody.community_id).toBe(communityCreateBody.community.community_id)
    expect(patchedBody.description).toBe("Updated patch description")
    expect(patchedBody.membership_mode).toBe("request")
    expect(patchedBody.allow_anonymous_identity).toBe(true)
    expect(patchedBody.anonymous_identity_scope).toBe("thread_stable")
    expect(patchedBody.default_age_gate_policy).toBe("none")
    expect(patchedBody.registry_publication_state).toBe("stale")

    const disableAnonymousIdentity = await requestJson(
      `http://pirate.test/communities/${communityCreateBody.community.community_id}`,
      {
        allow_anonymous_identity: false,
      },
      ctx.env,
      owner.accessToken,
      "PATCH",
    )
    expect(disableAnonymousIdentity.status).toBe(200)
    const disabledBody = await json(disableAnonymousIdentity) as {
      allow_anonymous_identity: boolean
      anonymous_identity_scope: string | null
    }
    expect(disabledBody.allow_anonymous_identity).toBe(false)
    expect(disabledBody.anonymous_identity_scope).toBeNull()

    const fetched = await app.request(
      `http://pirate.test/communities/${communityCreateBody.community.community_id}`,
      {
        headers: {
          authorization: `Bearer ${owner.accessToken}`,
        },
      },
      ctx.env,
    )
    expect(fetched.status).toBe(200)
    const fetchedBody = await json(fetched) as {
      description: string | null
      membership_mode: string
      allow_anonymous_identity: boolean
      anonymous_identity_scope: string | null
      registry_publication_state: string
    }
    expect(fetchedBody.description).toBe("Updated patch description")
    expect(fetchedBody.membership_mode).toBe("request")
    expect(fetchedBody.allow_anonymous_identity).toBe(false)
    expect(fetchedBody.anonymous_identity_scope).toBeNull()
    expect(fetchedBody.registry_publication_state).toBe("stale")
  })

  test("community profile get and patch persist ordered rules and resource links", async () => {
    const ctx = await createRouteTestContext()
    cleanup = ctx.cleanup

    const owner = await exchangeJwt(ctx.env, "community-profile-owner")
    const namespaceVerificationId = await prepareVerifiedNamespace(ctx.env, owner.accessToken, "profile-root-one")

    const communityCreate = await requestJson("http://pirate.test/communities", {
      display_name: "Profile Club",
      namespace: {
        namespace_verification_id: namespaceVerificationId,
      },
    }, ctx.env, owner.accessToken)
    expect(communityCreate.status).toBe(202)
    const communityCreateBody = await json(communityCreate) as {
      community: { community_id: string }
    }

    const initialProfile = await app.request(
      `http://pirate.test/communities/${communityCreateBody.community.community_id}/community-profile`,
      {
        headers: {
          authorization: `Bearer ${owner.accessToken}`,
        },
      },
      ctx.env,
    )
    expect(initialProfile.status).toBe(200)
    const initialProfileBody = await json(initialProfile) as {
      rules: unknown[]
      resource_links: unknown[]
    }
    expect(initialProfileBody.rules).toHaveLength(0)
    expect(initialProfileBody.resource_links).toHaveLength(0)

    const patchedProfile = await requestJson(
      `http://pirate.test/communities/${communityCreateBody.community.community_id}/community-profile`,
      {
        rules: [
          {
            title: "Be decent",
            body: "No spam.",
            position: 1,
          },
          {
            title: "Stay on topic",
            body: "Infinity only.",
            position: 0,
          },
        ],
        resource_links: [
          {
            label: "Docs",
            url: "https://example.com/docs",
            resource_kind: "document",
            position: 1,
          },
          {
            label: "Discord",
            url: "https://discord.gg/example",
            resource_kind: "discord",
            position: 0,
          },
        ],
      },
      ctx.env,
      owner.accessToken,
      "PATCH",
    )
    expect(patchedProfile.status).toBe(200)
    const patchedProfileBody = await json(patchedProfile) as {
      rules: Array<{ rule_id: string; title: string; position: number; status: string }>
      resource_links: Array<{ resource_link_id: string; label: string; position: number; status: string }>
    }
    expect(patchedProfileBody.rules.map((rule) => rule.title)).toEqual(["Stay on topic", "Be decent"])
    expect(patchedProfileBody.rules.every((rule) => typeof rule.rule_id === "string" && rule.rule_id.length > 0)).toBe(true)
    expect(patchedProfileBody.rules.every((rule) => rule.status === "active")).toBe(true)
    expect(patchedProfileBody.resource_links.map((link) => link.label)).toEqual(["Discord", "Docs"])
    expect(
      patchedProfileBody.resource_links.every((link) => typeof link.resource_link_id === "string" && link.resource_link_id.length > 0),
    ).toBe(true)
    expect(patchedProfileBody.resource_links.every((link) => link.status === "active")).toBe(true)

    const fetchedProfile = await app.request(
      `http://pirate.test/communities/${communityCreateBody.community.community_id}/community-profile`,
      {
        headers: {
          authorization: `Bearer ${owner.accessToken}`,
        },
      },
      ctx.env,
    )
    expect(fetchedProfile.status).toBe(200)
    const fetchedProfileBody = await json(fetchedProfile) as {
      rules: Array<{ title: string }>
      resource_links: Array<{ label: string }>
    }
    expect(fetchedProfileBody.rules.map((rule) => rule.title)).toEqual(["Stay on topic", "Be decent"])
    expect(fetchedProfileBody.resource_links.map((link) => link.label)).toEqual(["Discord", "Docs"])
  })

  test("community reference links create, list, patch, and archive persist in order", async () => {
    const ctx = await createRouteTestContext()
    cleanup = ctx.cleanup

    const owner = await exchangeJwt(ctx.env, "community-reference-links-owner")
    const namespaceVerificationId = await prepareVerifiedNamespace(ctx.env, owner.accessToken, "reference-links-root-one")

    const communityCreate = await requestJson("http://pirate.test/communities", {
      display_name: "Reference Link Club",
      namespace: {
        namespace_verification_id: namespaceVerificationId,
      },
    }, ctx.env, owner.accessToken)
    expect(communityCreate.status).toBe(202)
    const communityCreateBody = await json(communityCreate) as {
      community: { community_id: string; registry_publication_state: string }
    }
    expect(communityCreateBody.community.registry_publication_state).toBe("published")

    const created = await requestJson(
      `http://pirate.test/communities/${communityCreateBody.community.community_id}/reference-links`,
      {
        platform: "official_website",
        url: "https://example.com",
        label: "Official Site",
        position: 1,
      },
      ctx.env,
      owner.accessToken,
    )
    expect(created.status).toBe(201)
    const createdBody = await json(created) as {
      community_reference_link_id: string
      label: string | null
      link_status: string
      verification_applicability: string
      verification_state: string | null
      position: number
    }
    expect(createdBody.label).toBe("Official Site")
    expect(createdBody.link_status).toBe("active")
    expect(createdBody.verification_applicability).toBe("eligible")
    expect(createdBody.verification_state).toBe("unverified")
    expect(createdBody.position).toBe(1)

    const communityAfterCreate = await app.request(
      `http://pirate.test/communities/${communityCreateBody.community.community_id}`,
      {
        headers: {
          authorization: `Bearer ${owner.accessToken}`,
        },
      },
      ctx.env,
    )
    expect(communityAfterCreate.status).toBe(200)
    const communityAfterCreateBody = await json(communityAfterCreate) as {
      registry_publication_state: string
    }
    expect(communityAfterCreateBody.registry_publication_state).toBe("stale")

    await requestJson(
      `http://pirate.test/communities/${communityCreateBody.community.community_id}/reference-links`,
      {
        platform: "youtube",
        url: "https://youtube.com/@example",
        label: "YouTube",
        position: 0,
      },
      ctx.env,
      owner.accessToken,
    )

    const listed = await app.request(
      `http://pirate.test/communities/${communityCreateBody.community.community_id}/reference-links`,
      {
        headers: {
          authorization: `Bearer ${owner.accessToken}`,
        },
      },
      ctx.env,
    )
    expect(listed.status).toBe(200)
    const listedBody = await json(listed) as {
      items: Array<{ community_reference_link_id: string; label: string | null }>
    }
    expect(listedBody.items).toHaveLength(2)
    expect(listedBody.items.map((item) => item.label)).toEqual(["YouTube", "Official Site"])

    const fetched = await app.request(
      `http://pirate.test/communities/${communityCreateBody.community.community_id}/reference-links/${createdBody.community_reference_link_id}`,
      {
        headers: {
          authorization: `Bearer ${owner.accessToken}`,
        },
      },
      ctx.env,
    )
    expect(fetched.status).toBe(200)
    const fetchedBody = await json(fetched) as {
      community_reference_link_id: string
      label: string | null
      normalized_url: string
    }
    expect(fetchedBody.community_reference_link_id).toBe(createdBody.community_reference_link_id)
    expect(fetchedBody.label).toBe("Official Site")
    expect(fetchedBody.normalized_url).toBe("https://example.com/")

    const patched = await requestJson(
      `http://pirate.test/communities/${communityCreateBody.community.community_id}/reference-links/${createdBody.community_reference_link_id}`,
      {
        label: "Main Website",
        position: 2,
      },
      ctx.env,
      owner.accessToken,
      "PATCH",
    )
    expect(patched.status).toBe(200)
    const patchedBody = await json(patched) as {
      label: string | null
      position: number
      link_status: string
    }
    expect(patchedBody.label).toBe("Main Website")
    expect(patchedBody.position).toBe(2)
    expect(patchedBody.link_status).toBe("active")

    const archived = await requestJson(
      `http://pirate.test/communities/${communityCreateBody.community.community_id}/reference-links/${createdBody.community_reference_link_id}/archive`,
      {},
      ctx.env,
      owner.accessToken,
    )
    expect(archived.status).toBe(200)
    const archivedBody = await json(archived) as {
      community_reference_link_id: string
      link_status: string
    }
    expect(archivedBody.community_reference_link_id).toBe(createdBody.community_reference_link_id)
    expect(archivedBody.link_status).toBe("archived")
  })

  test("community donation policy returns defaults and persists explicit updates", async () => {
    const ctx = await createRouteTestContext()
    cleanup = ctx.cleanup

    const owner = await exchangeJwt(ctx.env, "community-donation-policy-owner")
    const namespaceVerificationId = await prepareVerifiedNamespace(ctx.env, owner.accessToken, "donation-policy-root-one")

    const communityCreate = await requestJson("http://pirate.test/communities", {
      display_name: "Donation Policy Club",
      namespace: {
        namespace_verification_id: namespaceVerificationId,
      },
    }, ctx.env, owner.accessToken)
    expect(communityCreate.status).toBe(202)
    const communityCreateBody = await json(communityCreate) as {
      community: { community_id: string; registry_publication_state: string }
    }
    expect(communityCreateBody.community.registry_publication_state).toBe("published")

    const initial = await app.request(
      `http://pirate.test/communities/${communityCreateBody.community.community_id}/donation-policy`,
      {
        headers: {
          authorization: `Bearer ${owner.accessToken}`,
        },
      },
      ctx.env,
    )
    expect(initial.status).toBe(200)
    const initialBody = await json(initial) as {
      community_id: string
      donation_policy_mode: string
      donation_partner_status: string
      donation_partner_id: string | null
    }
    expect(initialBody.community_id).toBe(communityCreateBody.community.community_id)
    expect(initialBody.donation_policy_mode).toBe("none")
    expect(initialBody.donation_partner_status).toBe("unconfigured")
    expect(initialBody.donation_partner_id).toBeNull()

    const patched = await requestJson(
      `http://pirate.test/communities/${communityCreateBody.community.community_id}/donation-policy`,
      {
        donation_policy_mode: "optional_creator_sidecar",
        donation_partner_id: "don_partner_endaoment_alpha",
        donation_partner_status: "active",
      },
      ctx.env,
      owner.accessToken,
      "PATCH",
    )
    expect(patched.status).toBe(200)
    const patchedBody = await json(patched) as {
      donation_policy_mode: string
      donation_partner_status: string
      donation_partner_id: string | null
    }
    expect(patchedBody.donation_policy_mode).toBe("optional_creator_sidecar")
    expect(patchedBody.donation_partner_status).toBe("active")
    expect(patchedBody.donation_partner_id).toBe("don_partner_endaoment_alpha")

    const communityAfterPatch = await app.request(
      `http://pirate.test/communities/${communityCreateBody.community.community_id}`,
      {
        headers: {
          authorization: `Bearer ${owner.accessToken}`,
        },
      },
      ctx.env,
    )
    expect(communityAfterPatch.status).toBe(200)
    const communityAfterPatchBody = await json(communityAfterPatch) as {
      registry_publication_state: string
      donation_policy_mode: string
      donation_partner_status: string
      donation_partner_id: string | null
    }
    expect(communityAfterPatchBody.registry_publication_state).toBe("stale")
    expect(communityAfterPatchBody.donation_policy_mode).toBe("optional_creator_sidecar")
    expect(communityAfterPatchBody.donation_partner_status).toBe("active")
    expect(communityAfterPatchBody.donation_partner_id).toBe("don_partner_endaoment_alpha")

    const fetched = await app.request(
      `http://pirate.test/communities/${communityCreateBody.community.community_id}/donation-policy`,
      {
        headers: {
          authorization: `Bearer ${owner.accessToken}`,
        },
      },
      ctx.env,
    )
    expect(fetched.status).toBe(200)
    const fetchedBody = await json(fetched) as {
      donation_policy_mode: string
      donation_partner_status: string
      donation_partner_id: string | null
    }
    expect(fetchedBody.donation_policy_mode).toBe("optional_creator_sidecar")
    expect(fetchedBody.donation_partner_status).toBe("active")
    expect(fetchedBody.donation_partner_id).toBe("don_partner_endaoment_alpha")
  })

  test("community flair policy returns defaults and persists explicit updates", async () => {
    const ctx = await createRouteTestContext()
    cleanup = ctx.cleanup

    const owner = await exchangeJwt(ctx.env, "community-flair-policy-owner")
    const namespaceVerificationId = await prepareVerifiedNamespace(ctx.env, owner.accessToken, "flair-policy-root-one")

    const communityCreate = await requestJson("http://pirate.test/communities", {
      display_name: "Flair Policy Club",
      namespace: {
        namespace_verification_id: namespaceVerificationId,
      },
    }, ctx.env, owner.accessToken)
    expect(communityCreate.status).toBe(202)
    const communityCreateBody = await json(communityCreate) as {
      community: { community_id: string; registry_publication_state: string }
    }
    expect(communityCreateBody.community.registry_publication_state).toBe("published")

    const initial = await app.request(
      `http://pirate.test/communities/${communityCreateBody.community.community_id}/flairs`,
      {
        headers: {
          authorization: `Bearer ${owner.accessToken}`,
        },
      },
      ctx.env,
    )
    expect(initial.status).toBe(200)
    const initialBody = await json(initial) as {
      flair_enabled: boolean
      require_flair_on_top_level_posts: boolean
      definitions: unknown[]
    }
    expect(initialBody.flair_enabled).toBe(false)
    expect(initialBody.require_flair_on_top_level_posts).toBe(false)
    expect(initialBody.definitions).toHaveLength(0)

    const patched = await requestJson(
      `http://pirate.test/communities/${communityCreateBody.community.community_id}/flairs`,
      {
        flair_enabled: true,
        require_flair_on_top_level_posts: true,
        definitions: [
          {
            label: "Meta",
            position: 1,
            color_token: "orange",
            allowed_post_types: ["text", "image"],
          },
          {
            label: "Song",
            position: 0,
            description: "Music posts",
            allowed_post_types: ["song"],
          },
        ],
      },
      ctx.env,
      owner.accessToken,
      "PATCH",
    )
    expect(patched.status).toBe(200)
    const patchedBody = await json(patched) as {
      flair_enabled: boolean
      require_flair_on_top_level_posts: boolean
      definitions: Array<{ flair_id: string; label: string; position: number; status: string }>
    }
    expect(patchedBody.flair_enabled).toBe(true)
    expect(patchedBody.require_flair_on_top_level_posts).toBe(true)
    expect(patchedBody.definitions.map((definition) => definition.label)).toEqual(["Song", "Meta"])
    expect(patchedBody.definitions.every((definition) => definition.status === "active")).toBe(true)
    expect(patchedBody.definitions.every((definition) => definition.flair_id.length > 0)).toBe(true)

    const communityAfterPatch = await app.request(
      `http://pirate.test/communities/${communityCreateBody.community.community_id}`,
      {
        headers: {
          authorization: `Bearer ${owner.accessToken}`,
        },
      },
      ctx.env,
    )
    expect(communityAfterPatch.status).toBe(200)
    const communityAfterPatchBody = await json(communityAfterPatch) as {
      registry_publication_state: string
      flair_policy: {
        flair_enabled: boolean
        definitions: Array<{ label: string }>
      } | null
    }
    expect(communityAfterPatchBody.registry_publication_state).toBe("stale")
    expect(communityAfterPatchBody.flair_policy?.flair_enabled).toBe(true)
    expect(communityAfterPatchBody.flair_policy?.definitions.map((definition) => definition.label)).toEqual(["Song", "Meta"])
  })

  test("community content authenticity policy returns defaults and persists explicit updates", async () => {
    const ctx = await createRouteTestContext()
    cleanup = ctx.cleanup

    const owner = await exchangeJwt(ctx.env, "community-content-authenticity-owner")
    const namespaceVerificationId = await prepareVerifiedNamespace(ctx.env, owner.accessToken, "content-auth-root-one")

    const communityCreate = await requestJson("http://pirate.test/communities", {
      display_name: "Content Authenticity Club",
      namespace: {
        namespace_verification_id: namespaceVerificationId,
      },
    }, ctx.env, owner.accessToken)
    expect(communityCreate.status).toBe(202)
    const communityCreateBody = await json(communityCreate) as {
      community: { community_id: string; registry_publication_state: string }
    }
    expect(communityCreateBody.community.registry_publication_state).toBe("published")

    const initial = await app.request(
      `http://pirate.test/communities/${communityCreateBody.community.community_id}/content-authenticity-policy`,
      {
        headers: {
          authorization: `Bearer ${owner.accessToken}`,
        },
      },
      ctx.env,
    )
    expect(initial.status).toBe(200)
    const initialBody = await json(initial) as {
      policy_origin: string
      authenticity_stance: string
      text_policy: { allow_ai_generated: boolean }
    }
    expect(initialBody.policy_origin).toBe("default")
    expect(initialBody.authenticity_stance).toBe("human_first")
    expect(initialBody.text_policy.allow_ai_generated).toBe(false)

    const patched = await requestJson(
      `http://pirate.test/communities/${communityCreateBody.community.community_id}/content-authenticity-policy`,
      {
        authenticity_stance: "ai_allowed_with_disclosure",
        text_policy: {
          allow_ai_assisted_editing: true,
          allow_ai_generated: true,
        },
        image_policy: {
          allow_ai_upscale: true,
          allow_ai_restoration: true,
          allow_generative_editing: true,
          allow_ai_generated: true,
        },
        video_policy: {
          allow_ai_upscale: true,
          allow_ai_restoration: true,
          allow_ai_frame_interpolation: true,
          allow_generative_editing: true,
          allow_ai_generated: true,
        },
        song_policy: {
          allow_ai_assisted_mastering: true,
          allow_ai_stem_separation: true,
          allow_ai_generated_instrumentals: true,
          allow_ai_generated_lyrics: false,
          allow_ai_generated_vocals: false,
        },
      },
      ctx.env,
      owner.accessToken,
      "PATCH",
    )
    expect(patched.status).toBe(200)
    const patchedBody = await json(patched) as {
      policy_origin: string
      authenticity_stance: string
      text_policy: { allow_ai_generated: boolean }
      song_policy: { allow_ai_generated_lyrics: boolean }
    }
    expect(patchedBody.policy_origin).toBe("explicit")
    expect(patchedBody.authenticity_stance).toBe("ai_allowed_with_disclosure")
    expect(patchedBody.text_policy.allow_ai_generated).toBe(true)
    expect(patchedBody.song_policy.allow_ai_generated_lyrics).toBe(false)

    const communityAfterPatch = await app.request(
      `http://pirate.test/communities/${communityCreateBody.community.community_id}`,
      {
        headers: {
          authorization: `Bearer ${owner.accessToken}`,
        },
      },
      ctx.env,
    )
    expect(communityAfterPatch.status).toBe(200)
    const communityAfterPatchBody = await json(communityAfterPatch) as {
      registry_publication_state: string
      content_authenticity_policy: {
        policy_origin: string
        authenticity_stance: string
      }
    }
    expect(communityAfterPatchBody.registry_publication_state).toBe("stale")
    expect(communityAfterPatchBody.content_authenticity_policy.policy_origin).toBe("explicit")
    expect(communityAfterPatchBody.content_authenticity_policy.authenticity_stance).toBe("ai_allowed_with_disclosure")
  })

  test("community source policy returns defaults and persists explicit updates", async () => {
    const ctx = await createRouteTestContext()
    cleanup = ctx.cleanup

    const owner = await exchangeJwt(ctx.env, "community-source-policy-owner")
    const namespaceVerificationId = await prepareVerifiedNamespace(ctx.env, owner.accessToken, "source-policy-root-one")

    const communityCreate = await requestJson("http://pirate.test/communities", {
      display_name: "Source Policy Club",
      namespace: {
        namespace_verification_id: namespaceVerificationId,
      },
    }, ctx.env, owner.accessToken)
    expect(communityCreate.status).toBe(202)
    const communityCreateBody = await json(communityCreate) as {
      community: { community_id: string; registry_publication_state: string }
    }
    expect(communityCreateBody.community.registry_publication_state).toBe("published")

    const initial = await app.request(
      `http://pirate.test/communities/${communityCreateBody.community.community_id}/source-policy`,
      {
        headers: {
          authorization: `Bearer ${owner.accessToken}`,
        },
      },
      ctx.env,
    )
    expect(initial.status).toBe(200)
    const initialBody = await json(initial) as {
      policy_origin: string
      identified_person_media_scope: string
      require_source_url_for_reposts: boolean
      allow_human_made_fan_art_of_real_people: boolean
      require_fan_art_disclosure: boolean
    }
    expect(initialBody.policy_origin).toBe("default")
    expect(initialBody.identified_person_media_scope).toBe("subject_only")
    expect(initialBody.require_source_url_for_reposts).toBe(true)
    expect(initialBody.allow_human_made_fan_art_of_real_people).toBe(false)
    expect(initialBody.require_fan_art_disclosure).toBe(false)

    const patched = await requestJson(
      `http://pirate.test/communities/${communityCreateBody.community.community_id}/source-policy`,
      {
        identified_person_media_scope: "subject_or_authorized",
        require_source_url_for_reposts: true,
        allow_human_made_fan_art_of_real_people: true,
        require_fan_art_disclosure: true,
      },
      ctx.env,
      owner.accessToken,
      "PATCH",
    )
    expect(patched.status).toBe(200)
    const patchedBody = await json(patched) as {
      policy_origin: string
      identified_person_media_scope: string
      allow_human_made_fan_art_of_real_people: boolean
      require_fan_art_disclosure: boolean
    }
    expect(patchedBody.policy_origin).toBe("explicit")
    expect(patchedBody.identified_person_media_scope).toBe("subject_or_authorized")
    expect(patchedBody.allow_human_made_fan_art_of_real_people).toBe(true)
    expect(patchedBody.require_fan_art_disclosure).toBe(true)

    const communityAfterPatch = await app.request(
      `http://pirate.test/communities/${communityCreateBody.community.community_id}`,
      {
        headers: {
          authorization: `Bearer ${owner.accessToken}`,
        },
      },
      ctx.env,
    )
    expect(communityAfterPatch.status).toBe(200)
    const communityAfterPatchBody = await json(communityAfterPatch) as {
      registry_publication_state: string
      source_policy: {
        policy_origin: string
        identified_person_media_scope: string
      }
    }
    expect(communityAfterPatchBody.registry_publication_state).toBe("stale")
    expect(communityAfterPatchBody.source_policy.policy_origin).toBe("explicit")
    expect(communityAfterPatchBody.source_policy.identified_person_media_scope).toBe("subject_or_authorized")
  })

  test("community market-context policy returns defaults and persists explicit updates", async () => {
    const ctx = await createRouteTestContext()
    cleanup = ctx.cleanup

    const owner = await exchangeJwt(ctx.env, "community-market-context-owner")
    const namespaceVerificationId = await prepareVerifiedNamespace(ctx.env, owner.accessToken, "market-context-root-one")

    const communityCreate = await requestJson("http://pirate.test/communities", {
      display_name: "Market Context Club",
      namespace: {
        namespace_verification_id: namespaceVerificationId,
      },
    }, ctx.env, owner.accessToken)
    expect(communityCreate.status).toBe(202)
    const communityCreateBody = await json(communityCreate) as {
      community: { community_id: string; registry_publication_state: string }
    }
    expect(communityCreateBody.community.registry_publication_state).toBe("published")

    const initial = await app.request(
      `http://pirate.test/communities/${communityCreateBody.community.community_id}/market-context-policy`,
      {
        headers: {
          authorization: `Bearer ${owner.accessToken}`,
        },
      },
      ctx.env,
    )
    expect(initial.status).toBe(200)
    const initialBody = await json(initial) as {
      policy_origin: string
      mode: string
      provider_set: string
      resolved_profile: { market_context_profile_id: string; profile_key: string }
    }
    expect(initialBody.policy_origin).toBe("default")
    expect(initialBody.mode).toBe("off")
    expect(initialBody.provider_set).toBe("platform_default")
    expect(initialBody.resolved_profile.market_context_profile_id).toBe("marketctx_default_v0")

    const patched = await requestJson(
      `http://pirate.test/communities/${communityCreateBody.community.community_id}/market-context-policy`,
      {
        mode: "on",
        enabled_post_types: ["link", "image"],
        max_markets_per_post: 2,
        provider_set: "approved_profile",
        market_context_profile_id: "marketctx_music_politics_v1",
      },
      ctx.env,
      owner.accessToken,
      "PATCH",
    )
    expect(patched.status).toBe(200)
    const patchedBody = await json(patched) as {
      policy_origin: string
      mode: string
      enabled_post_types: string[]
      max_markets_per_post: number
      provider_set: string
      resolved_profile: { market_context_profile_id: string; profile_key: string; provider_keys: string[] }
    }
    expect(patchedBody.policy_origin).toBe("explicit")
    expect(patchedBody.mode).toBe("on")
    expect(patchedBody.enabled_post_types).toEqual(["link", "image"])
    expect(patchedBody.max_markets_per_post).toBe(2)
    expect(patchedBody.provider_set).toBe("approved_profile")
    expect(patchedBody.resolved_profile.market_context_profile_id).toBe("marketctx_music_politics_v1")
    expect(patchedBody.resolved_profile.profile_key).toBe("marketctx_music_politics_v1")
    expect(patchedBody.resolved_profile.provider_keys).toEqual(["approved_profile"])

    const communityAfterPatch = await app.request(
      `http://pirate.test/communities/${communityCreateBody.community.community_id}`,
      {
        headers: {
          authorization: `Bearer ${owner.accessToken}`,
        },
      },
      ctx.env,
    )
    expect(communityAfterPatch.status).toBe(200)
    const communityAfterPatchBody = await json(communityAfterPatch) as {
      registry_publication_state: string
      market_context_policy: {
        policy_origin: string
        mode: string
        provider_set: string
      }
    }
    expect(communityAfterPatchBody.registry_publication_state).toBe("stale")
    expect(communityAfterPatchBody.market_context_policy.policy_origin).toBe("explicit")
    expect(communityAfterPatchBody.market_context_policy.mode).toBe("on")
    expect(communityAfterPatchBody.market_context_policy.provider_set).toBe("approved_profile")
  })

  test("community content authenticity detection policy returns defaults and persists explicit updates", async () => {
    const ctx = await createRouteTestContext()
    cleanup = ctx.cleanup

    const owner = await exchangeJwt(ctx.env, "community-content-detection-owner")
    const namespaceVerificationId = await prepareVerifiedNamespace(ctx.env, owner.accessToken, "content-detection-root-one")

    const communityCreate = await requestJson("http://pirate.test/communities", {
      display_name: "Content Detection Club",
      namespace: {
        namespace_verification_id: namespaceVerificationId,
      },
    }, ctx.env, owner.accessToken)
    expect(communityCreate.status).toBe(202)
    const communityCreateBody = await json(communityCreate) as {
      community: { community_id: string; registry_publication_state: string }
    }
    expect(communityCreateBody.community.registry_publication_state).toBe("published")

    const initial = await app.request(
      `http://pirate.test/communities/${communityCreateBody.community.community_id}/content-authenticity-detection-policy`,
      {
        headers: {
          authorization: `Bearer ${owner.accessToken}`,
        },
      },
      ctx.env,
    )
    expect(initial.status).toBe(200)
    const initialBody = await json(initial) as {
      policy_origin: string
      selection_mode: string
      resolved_profile: { authenticity_detection_profile_id: string; profile_key: string; provider_key: string }
    }
    expect(initialBody.policy_origin).toBe("default")
    expect(initialBody.selection_mode).toBe("platform_default")
    expect(initialBody.resolved_profile.authenticity_detection_profile_id).toBe("authdet_default_v0")
    expect(initialBody.resolved_profile.provider_key).toBe("platform_default")

    const patched = await requestJson(
      `http://pirate.test/communities/${communityCreateBody.community.community_id}/content-authenticity-detection-policy`,
      {
        selection_mode: "approved_profile",
        authenticity_detection_profile_id: "authdet_music_label_v2",
      },
      ctx.env,
      owner.accessToken,
      "PATCH",
    )
    expect(patched.status).toBe(200)
    const patchedBody = await json(patched) as {
      policy_origin: string
      selection_mode: string
      resolved_profile: { authenticity_detection_profile_id: string; profile_key: string; provider_key: string }
    }
    expect(patchedBody.policy_origin).toBe("explicit")
    expect(patchedBody.selection_mode).toBe("approved_profile")
    expect(patchedBody.resolved_profile.authenticity_detection_profile_id).toBe("authdet_music_label_v2")
    expect(patchedBody.resolved_profile.profile_key).toBe("authdet_music_label_v2")
    expect(patchedBody.resolved_profile.provider_key).toBe("approved_profile")

    const communityAfterPatch = await app.request(
      `http://pirate.test/communities/${communityCreateBody.community.community_id}`,
      {
        headers: {
          authorization: `Bearer ${owner.accessToken}`,
        },
      },
      ctx.env,
    )
    expect(communityAfterPatch.status).toBe(200)
    const communityAfterPatchBody = await json(communityAfterPatch) as {
      registry_publication_state: string
      content_authenticity_detection_policy: {
        policy_origin: string
        selection_mode: string
      }
    }
    expect(communityAfterPatchBody.registry_publication_state).toBe("stale")
    expect(communityAfterPatchBody.content_authenticity_detection_policy.policy_origin).toBe("explicit")
    expect(communityAfterPatchBody.content_authenticity_detection_policy.selection_mode).toBe("approved_profile")
  })

  test("community create returns publication_error when the publisher times out after provisioning succeeds", async () => {
    const publisherToken = "publisher-test-token"
    const publisherBaseUrl = "http://publisher.test"
    const originalFetch = globalThis.fetch
    globalThis.fetch = (async (input, init) => {
      const requestUrl = typeof input === "string" ? input : input instanceof URL ? input.toString() : input.url
      if (!requestUrl.startsWith(publisherBaseUrl)) {
        return originalFetch(input as never, init)
      }

      const url = new URL(requestUrl)
      const authorization = init?.headers instanceof Headers
        ? init.headers.get("authorization")
        : Array.isArray(init?.headers)
          ? init?.headers.find(([key]) => key.toLowerCase() === "authorization")?.[1]
          : init?.headers && "authorization" in init.headers
            ? String((init.headers as Record<string, unknown>).authorization)
            : null

      if (authorization !== `Bearer ${publisherToken}`) {
        return new Response(JSON.stringify({ error_code: "publisher_unauthorized" }), {
          status: 401,
          headers: { "content-type": "application/json" },
        })
      }

      if (url.pathname === "/internal/v0/create-community-attempt") {
        return new Response(JSON.stringify({
          ok: true,
          registry_attempt_id: "rga_timeout_test",
          actor_primary_wallet_snapshot: null,
          actor_governance_address_snapshot: null,
          result_ref: "publisher://attempt/rga_timeout_test",
        }), {
          headers: { "content-type": "application/json" },
        })
      }

      if (url.pathname === "/internal/v0/publish-community-create") {
        await new Promise((resolve, reject) => {
          const timer = setTimeout(resolve, 150)
          const signal = init?.signal
          if (signal) {
            signal.addEventListener("abort", () => {
              clearTimeout(timer)
              const error = new Error("aborted")
              error.name = "AbortError"
              reject(error)
            }, { once: true })
          }
        })
        return new Response(JSON.stringify({
          ok: true,
          status: "published",
          result_ref: "tableland://community/cmt_timeout_test",
          registry_published_at: new Date().toISOString(),
          table_refs: {
            attempts_table: "community_create_attempts_current_84532_1",
            club_registry_table: "clubreg_timeout_test_84532_1",
            club_namespace_table: "clubns_timeout_test_84532_1",
          },
        }), {
          headers: { "content-type": "application/json" },
        })
      }

      return new Response("not found", { status: 404 })
    }) as typeof globalThis.fetch

    try {
      const ctx = await createRouteTestContext({
        REGISTRY_PUBLISHER_URL: publisherBaseUrl,
        REGISTRY_PUBLISHER_AUTH_TOKEN: publisherToken,
        REGISTRY_PUBLISHER_TIMEOUT_MS: "25",
      })
      cleanup = ctx.cleanup

      const session = await exchangeJwt(ctx.env, "publisher-timeout-user")
      const namespaceVerificationId = await prepareVerifiedNamespace(ctx.env, session.accessToken)

      const communityCreate = await requestJson("http://pirate.test/communities", {
        display_name: "Timeout Club",
        namespace: {
          namespace_verification_id: namespaceVerificationId,
        },
      }, ctx.env, session.accessToken)

      expect(communityCreate.status).toBe(202)
      const body = await json(communityCreate) as {
        community: {
          community_id: string
          provisioning_state: string
          registry_publication_state: string
          registry_publication_job_id: string | null
          registry_error_code: string | null
        }
        job: {
          job_id: string
          status: string
        }
      }

      expect(body.job.status).toBe("succeeded")
      expect(body.community.provisioning_state).toBe("active")
      expect(body.community.registry_publication_state).toBe("publication_error")
      expect(typeof body.community.registry_publication_job_id).toBe("string")
      expect(body.community.registry_error_code).toBe("registry_publisher_timeout")

      const registryJob = await app.request(
        `http://pirate.test/jobs/${body.community.registry_publication_job_id}`,
        {
          headers: {
            authorization: `Bearer ${session.accessToken}`,
          },
        },
        ctx.env,
      )

      expect(registryJob.status).toBe(200)
      const registryJobBody = await json(registryJob) as { status: string; error_code: string | null }
      expect(registryJobBody.status).toBe("failed")
      expect(registryJobBody.error_code).toBe("registry_publisher_timeout")
    } finally {
      globalThis.fetch = originalFetch
    }
  })

  test("community create sends the primary wallet snapshot to the publisher attempt call", async () => {
    const publisherToken = "publisher-test-token"
    const publisherBaseUrl = "http://publisher.test"
    const originalFetch = globalThis.fetch
    let createAttemptBody: Record<string, unknown> | null = null

    globalThis.fetch = (async (input, init) => {
      const requestUrl = typeof input === "string" ? input : input instanceof URL ? input.toString() : input.url
      if (!requestUrl.startsWith(publisherBaseUrl)) {
        return originalFetch(input as never, init)
      }

      const url = new URL(requestUrl)
      if (url.pathname === "/internal/v0/create-community-attempt") {
        createAttemptBody = init?.body ? JSON.parse(String(init.body)) as Record<string, unknown> : null
        return new Response(JSON.stringify({
          ok: true,
          registry_attempt_id: "rga_wallet_snapshot_test",
          actor_primary_wallet_snapshot: createAttemptBody?.actor_primary_wallet_snapshot ?? null,
          actor_governance_address_snapshot: createAttemptBody?.actor_governance_address_snapshot ?? null,
          result_ref: "publisher://attempt/rga_wallet_snapshot_test",
        }), {
          headers: { "content-type": "application/json" },
        })
      }

      if (url.pathname === "/internal/v0/publish-community-create") {
        return new Response(JSON.stringify({
          ok: true,
          status: "published",
          result_ref: "tableland://community/cmt_wallet_snapshot_test",
          registry_published_at: new Date().toISOString(),
          table_refs: {
            attempts_table: "community_create_attempts_current_84532_1",
            club_registry_table: "clubreg_wallet_snapshot_test_84532_1",
            club_namespace_table: "clubns_wallet_snapshot_test_84532_1",
          },
        }), {
          headers: { "content-type": "application/json" },
        })
      }

      return new Response("not found", { status: 404 })
    }) as typeof globalThis.fetch

    try {
      const ctx = await createRouteTestContext({
        REGISTRY_PUBLISHER_URL: publisherBaseUrl,
        REGISTRY_PUBLISHER_AUTH_TOKEN: publisherToken,
      })
      cleanup = ctx.cleanup

      const session = await exchangeJwt(ctx.env, "publisher-wallet-snapshot-user")
      await setPrimaryWalletAttachment(ctx.env, session.userId, "0x1234000000000000000000000000000000005678")
      const namespaceVerificationId = await prepareVerifiedNamespace(ctx.env, session.accessToken)

      const communityCreate = await requestJson("http://pirate.test/communities", {
        display_name: "Wallet Snapshot Club",
        namespace: {
          namespace_verification_id: namespaceVerificationId,
        },
      }, ctx.env, session.accessToken)

      expect(communityCreate.status).toBe(202)
      expect(createAttemptBody?.["actor_primary_wallet_snapshot"]).toBe("0x1234000000000000000000000000000000005678")
      expect(createAttemptBody?.["actor_governance_address_snapshot"] ?? null).toBeNull()
    } finally {
      globalThis.fetch = originalFetch
    }
  })

  test("post create returns 403 until the member completes unique_human verification", async () => {
    const ctx = await createRouteTestContext()
    cleanup = ctx.cleanup

    const verifiedCreator = await exchangeJwt(ctx.env, "community-verified-creator")
    const namespaceVerificationId = await prepareVerifiedNamespace(ctx.env, verifiedCreator.accessToken)

    const communityCreate = await requestJson("http://pirate.test/communities", {
      display_name: "Pirate Verified Posting Club",
      namespace: {
        namespace_verification_id: namespaceVerificationId,
      },
    }, ctx.env, verifiedCreator.accessToken)
    expect(communityCreate.status).toBe(202)
    const communityCreateBody = await json(communityCreate) as {
      community: { community_id: string }
    }

    const unverifiedMember = await exchangeJwt(ctx.env, "community-unverified-member")
    await addCommunityMember(
      ctx.communityDbRoot,
      communityCreateBody.community.community_id,
      unverifiedMember.userId,
    )
    const deniedPost = await requestJson(
      `http://pirate.test/communities/${communityCreateBody.community.community_id}/posts`,
      {
        post_type: "text",
        title: "Blocked post",
        body: "This should require unique_human verification.",
        idempotency_key: "post-key-unverified-member",
      },
      ctx.env,
      unverifiedMember.accessToken,
    )

    expect(deniedPost.status).toBe(403)
    const deniedBody = await json(deniedPost) as { code: string; message: string }
    expect(deniedBody.code).toBe("verification_required")
    expect(deniedBody.message).toBe("unique_human verification is required")
  })

  test("anonymous post create also requires unique_human verification", async () => {
    const ctx = await createRouteTestContext()
    cleanup = ctx.cleanup

    const verifiedCreator = await exchangeJwt(ctx.env, "community-anon-verified-creator")
    const namespaceVerificationId = await prepareVerifiedNamespace(ctx.env, verifiedCreator.accessToken)

    const communityCreate = await requestJson("http://pirate.test/communities", {
      display_name: "Pirate Anonymous Posting Club",
      namespace: {
        namespace_verification_id: namespaceVerificationId,
      },
    }, ctx.env, verifiedCreator.accessToken)
    expect(communityCreate.status).toBe(202)
    const communityCreateBody = await json(communityCreate) as {
      community: { community_id: string }
    }

    const unverifiedMember = await exchangeJwt(ctx.env, "community-anon-unverified-member")
    await addCommunityMember(
      ctx.communityDbRoot,
      communityCreateBody.community.community_id,
      unverifiedMember.userId,
    )
    const deniedPost = await requestJson(
      `http://pirate.test/communities/${communityCreateBody.community.community_id}/posts`,
      {
        post_type: "text",
        title: "Blocked anonymous post",
        body: "Anonymous posting still needs strong human verification.",
        identity_mode: "anonymous",
        anonymous_scope: "community_stable",
        idempotency_key: "post-key-unverified-anonymous-member",
      },
      ctx.env,
      unverifiedMember.accessToken,
    )

    expect(deniedPost.status).toBe(403)
    const deniedBody = await json(deniedPost) as { code: string; message: string }
    expect(deniedBody.code).toBe("verification_required")
    expect(deniedBody.message).toBe("unique_human verification is required")
  })

  test("post create can require a very-verified posting gate", async () => {
    const ctx = await createRouteTestContext()
    cleanup = ctx.cleanup

    const creator = await exchangeJwt(ctx.env, "community-posting-gate-creator")
    const namespaceVerificationId = await prepareVerifiedNamespace(ctx.env, creator.accessToken)

    const communityCreate = await requestJson("http://pirate.test/communities", {
      display_name: "Pirate Very Posting Club",
      namespace: {
        namespace_verification_id: namespaceVerificationId,
      },
    }, ctx.env, creator.accessToken)
    expect(communityCreate.status).toBe(202)
    const communityCreateBody = await json(communityCreate) as {
      community: { community_id: string }
    }

    const gateRuleCreate = await requestJson(
      `http://pirate.test/communities/${communityCreateBody.community.community_id}/gate-rules`,
      {
        scope: "posting",
        gate_family: "identity_proof",
        gate_type: "unique_human",
        proof_requirements: [
          {
            proof_type: "unique_human",
            accepted_providers: ["very"],
          },
        ],
      },
      ctx.env,
      creator.accessToken,
    )
    expect(gateRuleCreate.status).toBe(201)

    const selfMember = await exchangeJwt(ctx.env, "community-posting-gate-self-member")
    await completeUniqueHumanVerification(ctx.env, selfMember.accessToken, "self")
    await addCommunityMember(ctx.communityDbRoot, communityCreateBody.community.community_id, selfMember.userId)

    const selfDeniedPost = await requestJson(
      `http://pirate.test/communities/${communityCreateBody.community.community_id}/posts`,
      {
        post_type: "text",
        title: "Blocked by provider gate",
        body: "A self-verified member should not pass a very-only posting gate.",
        idempotency_key: "post-key-posting-gate-self",
      },
      ctx.env,
      selfMember.accessToken,
    )
    expect(selfDeniedPost.status).toBe(403)
    const selfDeniedBody = await json(selfDeniedPost) as { code: string; message: string }
    expect(selfDeniedBody.code).toBe("gate_failed")
    expect(selfDeniedBody.message).toBe("Posting requirements are not satisfied")

    const veryMember = await exchangeJwt(ctx.env, "community-posting-gate-very-member")
    await completeUniqueHumanVerification(ctx.env, veryMember.accessToken, "very")
    await addCommunityMember(ctx.communityDbRoot, communityCreateBody.community.community_id, veryMember.userId)

    const veryAllowedPost = await requestJson(
      `http://pirate.test/communities/${communityCreateBody.community.community_id}/posts`,
      {
        post_type: "text",
        title: "Allowed by provider gate",
        body: "A very-verified member should pass the posting gate.",
        idempotency_key: "post-key-posting-gate-very",
      },
      ctx.env,
      veryMember.accessToken,
    )
  expect(veryAllowedPost.status).toBe(201)
})

test("post create can require a Self nationality posting gate", async () => {
  const ctx = await createRouteTestContext()
  cleanup = ctx.cleanup

  const creator = await exchangeJwt(ctx.env, "community-posting-nationality-creator")
  const namespaceVerificationId = await prepareVerifiedNamespace(ctx.env, creator.accessToken)

  const communityCreate = await requestJson("http://pirate.test/communities", {
    display_name: "Pirate US Posting Club",
    namespace: {
      namespace_verification_id: namespaceVerificationId,
    },
  }, ctx.env, creator.accessToken)
  expect(communityCreate.status).toBe(202)
  const communityCreateBody = await json(communityCreate) as {
    community: { community_id: string }
  }

  const gateRuleCreate = await requestJson(
    `http://pirate.test/communities/${communityCreateBody.community.community_id}/gate-rules`,
    {
      scope: "posting",
      gate_family: "identity_proof",
      gate_type: "nationality",
      gate_config: {
        required_value: "US",
      },
      proof_requirements: [
        {
          proof_type: "nationality",
          accepted_providers: ["self"],
        },
      ],
    },
    ctx.env,
    creator.accessToken,
  )
  expect(gateRuleCreate.status).toBe(201)

  const deniedMember = await exchangeJwt(ctx.env, "community-posting-nationality-ca-member")
  await setVerifiedUserNationality({
    client: ctx.client,
    userId: deniedMember.userId,
    countryCode: "CA",
  })
  await addCommunityMember(ctx.communityDbRoot, communityCreateBody.community.community_id, deniedMember.userId)

  const deniedPost = await requestJson(
    `http://pirate.test/communities/${communityCreateBody.community.community_id}/posts`,
    {
      post_type: "text",
      title: "Blocked by nationality gate",
      body: "A non-US member should not pass the posting gate.",
      idempotency_key: "post-key-posting-nationality-ca",
    },
    ctx.env,
    deniedMember.accessToken,
  )
  expect(deniedPost.status).toBe(403)
  const deniedBody = await json(deniedPost) as { code: string; message: string }
  expect(deniedBody.code).toBe("gate_failed")
  expect(deniedBody.message).toBe("Posting requirements are not satisfied")

  const allowedMember = await exchangeJwt(ctx.env, "community-posting-nationality-us-member")
  await setVerifiedUserNationality({
    client: ctx.client,
    userId: allowedMember.userId,
    countryCode: "US",
  })
  await addCommunityMember(ctx.communityDbRoot, communityCreateBody.community.community_id, allowedMember.userId)

  const allowedPost = await requestJson(
    `http://pirate.test/communities/${communityCreateBody.community.community_id}/posts`,
    {
      post_type: "text",
      title: "Allowed by nationality gate",
      body: "A US member should pass the posting gate.",
      idempotency_key: "post-key-posting-nationality-us",
    },
    ctx.env,
    allowedMember.accessToken,
  )
  expect(allowedPost.status).toBe(201)
})

  test("first-post-only posting gates only apply to the first text post", async () => {
    const ctx = await createRouteTestContext()
    cleanup = ctx.cleanup

    const creator = await exchangeJwt(ctx.env, "community-first-post-gate-creator")
    const namespaceVerificationId = await prepareVerifiedNamespace(ctx.env, creator.accessToken)

    const communityCreate = await requestJson("http://pirate.test/communities", {
      display_name: "Pirate First Text Gate Club",
      namespace: {
        namespace_verification_id: namespaceVerificationId,
      },
    }, ctx.env, creator.accessToken)
    expect(communityCreate.status).toBe(202)
    const communityCreateBody = await json(communityCreate) as {
      community: { community_id: string }
    }

    const gateRuleCreate = await requestJson(
      `http://pirate.test/communities/${communityCreateBody.community.community_id}/gate-rules`,
      {
        scope: "posting",
        gate_family: "identity_proof",
        gate_type: "unique_human",
        proof_requirements: [
          {
            proof_type: "unique_human",
            accepted_providers: ["very"],
          },
        ],
        gate_config: {
          post_types: ["text"],
          first_post_only: true,
        },
      },
      ctx.env,
      creator.accessToken,
    )
    expect(gateRuleCreate.status).toBe(201)

    const selfMember = await exchangeJwt(ctx.env, "community-first-post-gate-self-member")
    await completeUniqueHumanVerification(ctx.env, selfMember.accessToken, "self")
    await addCommunityMember(ctx.communityDbRoot, communityCreateBody.community.community_id, selfMember.userId)

    const selfDeniedFirstPost = await requestJson(
      `http://pirate.test/communities/${communityCreateBody.community.community_id}/posts`,
      {
        post_type: "text",
        title: "Blocked first text post",
        body: "A self-verified member should not pass the first text post gate.",
        idempotency_key: "post-key-first-post-self-denied",
      },
      ctx.env,
      selfMember.accessToken,
    )
    expect(selfDeniedFirstPost.status).toBe(403)

    const veryMember = await exchangeJwt(ctx.env, "community-first-post-gate-very-member")
    await completeUniqueHumanVerification(ctx.env, veryMember.accessToken, "very")
    await addCommunityMember(ctx.communityDbRoot, communityCreateBody.community.community_id, veryMember.userId)

    const firstAllowedTextPost = await requestJson(
      `http://pirate.test/communities/${communityCreateBody.community.community_id}/posts`,
      {
        post_type: "text",
        title: "Allowed first text post",
        body: "A very-verified member should pass the first text post gate.",
        idempotency_key: "post-key-first-post-very-allowed",
      },
      ctx.env,
      veryMember.accessToken,
    )
    expect(firstAllowedTextPost.status).toBe(201)

    await completeUniqueHumanVerification(ctx.env, veryMember.accessToken, "self")

    const secondAllowedTextPost = await requestJson(
      `http://pirate.test/communities/${communityCreateBody.community.community_id}/posts`,
      {
        post_type: "text",
        title: "Allowed second text post",
        body: "Once the first text post exists, the first-post-only gate should no longer apply.",
        idempotency_key: "post-key-first-post-self-allowed",
      },
      ctx.env,
      veryMember.accessToken,
    )
    expect(secondAllowedTextPost.status).toBe(201)
  })

  test("users/me can report whether the caller already created a text post in a community", async () => {
    const ctx = await createRouteTestContext()
    cleanup = ctx.cleanup

    const creator = await exchangeJwt(ctx.env, "community-posting-state-creator")
    const namespaceVerificationId = await prepareVerifiedNamespace(ctx.env, creator.accessToken)

    const communityCreate = await requestJson("http://pirate.test/communities", {
      display_name: "Pirate Posting State Club",
      namespace: {
        namespace_verification_id: namespaceVerificationId,
      },
    }, ctx.env, creator.accessToken)
    expect(communityCreate.status).toBe(202)
    const communityCreateBody = await json(communityCreate) as {
      community: { community_id: string }
    }

    const member = await exchangeJwt(ctx.env, "community-posting-state-member")
    await completeUniqueHumanVerification(ctx.env, member.accessToken, "self")
    await addCommunityMember(ctx.communityDbRoot, communityCreateBody.community.community_id, member.userId)

    const beforePost = await app.request(
      `http://pirate.test/users/me?community_ref=${encodeURIComponent(communityCreateBody.community.community_id)}`,
      {
        headers: {
          authorization: `Bearer ${member.accessToken}`,
        },
      },
      ctx.env,
    )
    expect(beforePost.status).toBe(200)
    const beforePostBody = await json(beforePost) as {
      community_posting_state: { has_created_text_post: boolean } | null
    }
    expect(beforePostBody.community_posting_state?.has_created_text_post).toBe(false)

    const createdPost = await requestJson(
      `http://pirate.test/communities/${communityCreateBody.community.community_id}/posts`,
      {
        post_type: "text",
        title: "First created text post",
        body: "This post should flip the community posting state flag.",
        idempotency_key: "post-key-community-posting-state",
      },
      ctx.env,
      member.accessToken,
    )
    expect(createdPost.status).toBe(201)

    const afterPost = await app.request(
      `http://pirate.test/users/me?community_ref=${encodeURIComponent(communityCreateBody.community.community_id)}`,
      {
        headers: {
          authorization: `Bearer ${member.accessToken}`,
        },
      },
      ctx.env,
    )
    expect(afterPost.status).toBe(200)
    const afterPostBody = await json(afterPost) as {
      community_posting_state: { has_created_text_post: boolean } | null
    }
    expect(afterPostBody.community_posting_state?.has_created_text_post).toBe(true)
  })

  test("post create returns 404 for a verified non-member", async () => {
    const ctx = await createRouteTestContext()
    cleanup = ctx.cleanup

    const verifiedCreator = await exchangeJwt(ctx.env, "community-post-owner")
    const namespaceVerificationId = await prepareVerifiedNamespace(ctx.env, verifiedCreator.accessToken)

    const communityCreate = await requestJson("http://pirate.test/communities", {
      display_name: "Pirate Non Member Club",
      namespace: {
        namespace_verification_id: namespaceVerificationId,
      },
    }, ctx.env, verifiedCreator.accessToken)
    expect(communityCreate.status).toBe(202)
    const communityCreateBody = await json(communityCreate) as {
      community: { community_id: string }
    }

    const verifiedNonMember = await exchangeJwt(ctx.env, "community-verified-non-member")
    await completeUniqueHumanVerification(ctx.env, verifiedNonMember.accessToken)

    const deniedPost = await requestJson(
      `http://pirate.test/communities/${communityCreateBody.community.community_id}/posts`,
      {
        post_type: "text",
        title: "Hello From Outside",
        body: "This user is verified but not a member.",
        idempotency_key: "post-key-non-member",
      },
      ctx.env,
      verifiedNonMember.accessToken,
    )

    expect(deniedPost.status).toBe(404)
    const deniedBody = await json(deniedPost) as { code: string; message: string }
    expect(deniedBody.code).toBe("not_found")
    expect(deniedBody.message).toBe("Community not found")
  })

  test("review-held post direct read is limited to the author and community owner", async () => {
    const ctx = await createRouteTestContext()
    cleanup = ctx.cleanup

    const owner = await exchangeJwt(ctx.env, "community-review-held-owner")
    const namespaceVerificationId = await prepareVerifiedNamespace(ctx.env, owner.accessToken)

    const communityCreate = await requestJson("http://pirate.test/communities", {
      display_name: "Pirate Review Held Visibility Club",
      namespace: {
        namespace_verification_id: namespaceVerificationId,
      },
    }, ctx.env, owner.accessToken)
    expect(communityCreate.status).toBe(202)
    const communityCreateBody = await json(communityCreate) as {
      community: { community_id: string }
    }

    const author = await exchangeJwt(ctx.env, "community-review-held-author")
    await completeUniqueHumanVerification(ctx.env, author.accessToken)
    await addCommunityMember(ctx.communityDbRoot, communityCreateBody.community.community_id, author.userId)

    const reviewHeldPost = await requestJson(
      `http://pirate.test/communities/${communityCreateBody.community.community_id}/posts`,
      {
        post_type: "text",
        title: "[review-required] Member Draft",
        body: "This post should remain hidden from other members.",
        idempotency_key: "post-key-review-held-member-author",
      },
      ctx.env,
      author.accessToken,
    )
    expect(reviewHeldPost.status).toBe(202)
    const reviewHeldBody = await json(reviewHeldPost) as {
      post_id: string
      status: string
      author_user_id: string | null
    }
    expect(reviewHeldBody.status).toBe("draft")
    expect(reviewHeldBody.author_user_id).toBe(author.userId)

    const ownerRead = await app.request(
      `http://pirate.test/posts/${reviewHeldBody.post_id}`,
      {
        headers: {
          authorization: `Bearer ${owner.accessToken}`,
        },
      },
      ctx.env,
    )
    expect(ownerRead.status).toBe(200)
    const ownerReadBody = await json(ownerRead) as {
      post: { post_id: string; status: string }
    }
    expect(ownerReadBody.post.post_id).toBe(reviewHeldBody.post_id)
    expect(ownerReadBody.post.status).toBe("draft")

    const otherMember = await exchangeJwt(ctx.env, "community-review-held-other-member")
    await addCommunityMember(ctx.communityDbRoot, communityCreateBody.community.community_id, otherMember.userId)

    const deniedRead = await app.request(
      `http://pirate.test/posts/${reviewHeldBody.post_id}`,
      {
        headers: {
          authorization: `Bearer ${otherMember.accessToken}`,
        },
      },
      ctx.env,
    )
    expect(deniedRead.status).toBe(404)
    const deniedBody = await json(deniedRead) as { code: string; message: string }
    expect(deniedBody.code).toBe("not_found")
    expect(deniedBody.message).toBe("Post not found")
  })

  test("anonymous post create returns 400 when anonymous_scope is missing", async () => {
    const ctx = await createRouteTestContext()
    cleanup = ctx.cleanup

    const session = await exchangeJwt(ctx.env, "community-anonymous-validation")
    const namespaceVerificationId = await prepareVerifiedNamespace(ctx.env, session.accessToken)

    const communityCreate = await requestJson("http://pirate.test/communities", {
      display_name: "Pirate Anonymous Club",
      namespace: {
        namespace_verification_id: namespaceVerificationId,
      },
    }, ctx.env, session.accessToken)
    expect(communityCreate.status).toBe(202)
    const communityCreateBody = await json(communityCreate) as {
      community: { community_id: string }
    }

    const deniedPost = await requestJson(
      `http://pirate.test/communities/${communityCreateBody.community.community_id}/posts`,
      {
        post_type: "text",
        identity_mode: "anonymous",
        title: "Anonymous Without Scope",
        body: "Missing anonymous scope should fail validation.",
        idempotency_key: "post-key-anonymous-missing-scope",
      },
      ctx.env,
      session.accessToken,
    )

    expect(deniedPost.status).toBe(400)
    const deniedBody = await json(deniedPost) as { code: string; message: string }
    expect(deniedBody.code).toBe("bad_request")
    expect(deniedBody.message).toBe("anonymous_scope is required for anonymous posts")
  })

  test("link post create returns 400 when link_url is missing", async () => {
    const ctx = await createRouteTestContext()
    cleanup = ctx.cleanup

    const session = await exchangeJwt(ctx.env, "community-link-validation")
    const namespaceVerificationId = await prepareVerifiedNamespace(ctx.env, session.accessToken)

    const communityCreate = await requestJson("http://pirate.test/communities", {
      display_name: "Pirate Links Club",
      namespace: {
        namespace_verification_id: namespaceVerificationId,
      },
    }, ctx.env, session.accessToken)
    expect(communityCreate.status).toBe(202)
    const communityCreateBody = await json(communityCreate) as {
      community: { community_id: string }
    }

    const deniedPost = await requestJson(
      `http://pirate.test/communities/${communityCreateBody.community.community_id}/posts`,
      {
        post_type: "link",
        title: "Broken Link Post",
        body: "Missing link_url should fail validation.",
        idempotency_key: "post-key-link-missing-url",
      },
      ctx.env,
      session.accessToken,
    )

    expect(deniedPost.status).toBe(400)
    const deniedBody = await json(deniedPost) as { code: string; message: string }
    expect(deniedBody.code).toBe("bad_request")
    expect(deniedBody.message).toBe("link_url is required for link posts")
  })

  test("song post create returns 400 when identity_mode is anonymous", async () => {
    const ctx = await createRouteTestContext()
    cleanup = ctx.cleanup

    const session = await exchangeJwt(ctx.env, "community-song-anonymous-validation")
    const namespaceVerificationId = await prepareVerifiedNamespace(ctx.env, session.accessToken)

    const communityCreate = await requestJson("http://pirate.test/communities", {
      display_name: "Pirate Song Identity Club",
      namespace: {
        namespace_verification_id: namespaceVerificationId,
      },
    }, ctx.env, session.accessToken)
    expect(communityCreate.status).toBe(202)
    const communityCreateBody = await json(communityCreate) as {
      community: { community_id: string }
    }

    const deniedPost = await requestJson(
      `http://pirate.test/communities/${communityCreateBody.community.community_id}/posts`,
      {
        post_type: "song",
        identity_mode: "anonymous",
        anonymous_scope: "community_stable",
        title: "Anonymous Song",
        lyrics: "These lyrics should not matter because identity is invalid.",
        media_refs: [buildSongMediaRef("ipfs://song-anonymous-validation-audio")],
        idempotency_key: "post-key-song-anonymous-invalid",
      },
      ctx.env,
      session.accessToken,
    )

    expect(deniedPost.status).toBe(400)
    const deniedBody = await json(deniedPost) as { code: string; message: string }
    expect(deniedBody.code).toBe("bad_request")
    expect(deniedBody.message).toBe("song posts must use public identity")
  })

  test("song post create returns 400 when lyrics are missing", async () => {
    const ctx = await createRouteTestContext()
    cleanup = ctx.cleanup

    const session = await exchangeJwt(ctx.env, "community-song-lyrics-validation")
    const namespaceVerificationId = await prepareVerifiedNamespace(ctx.env, session.accessToken)

    const communityCreate = await requestJson("http://pirate.test/communities", {
      display_name: "Pirate Song Lyrics Club",
      namespace: {
        namespace_verification_id: namespaceVerificationId,
      },
    }, ctx.env, session.accessToken)
    expect(communityCreate.status).toBe(202)
    const communityCreateBody = await json(communityCreate) as {
      community: { community_id: string }
    }

    const deniedPost = await requestJson(
      `http://pirate.test/communities/${communityCreateBody.community.community_id}/posts`,
      {
        post_type: "song",
        identity_mode: "public",
        title: "Song Without Lyrics",
        media_refs: [buildSongMediaRef("ipfs://song-missing-lyrics-audio")],
        idempotency_key: "post-key-song-missing-lyrics",
      },
      ctx.env,
      session.accessToken,
    )

    expect(deniedPost.status).toBe(400)
    const deniedBody = await json(deniedPost) as { code: string; message: string }
    expect(deniedBody.code).toBe("bad_request")
    expect(deniedBody.message).toBe("lyrics are required for song posts")
  })

  test("song post create returns 400 when audio media_refs are missing", async () => {
    const ctx = await createRouteTestContext()
    cleanup = ctx.cleanup

    const session = await exchangeJwt(ctx.env, "community-song-media-validation")
    const namespaceVerificationId = await prepareVerifiedNamespace(ctx.env, session.accessToken)

    const communityCreate = await requestJson("http://pirate.test/communities", {
      display_name: "Pirate Song Media Club",
      namespace: {
        namespace_verification_id: namespaceVerificationId,
      },
    }, ctx.env, session.accessToken)
    expect(communityCreate.status).toBe(202)
    const communityCreateBody = await json(communityCreate) as {
      community: { community_id: string }
    }

    const deniedPost = await requestJson(
      `http://pirate.test/communities/${communityCreateBody.community.community_id}/posts`,
      {
        post_type: "song",
        identity_mode: "public",
        title: "Song Without Audio",
        lyrics: "Lyrics exist but audio refs are missing.",
        media_refs: [],
        idempotency_key: "post-key-song-missing-media",
      },
      ctx.env,
      session.accessToken,
    )

    expect(deniedPost.status).toBe(400)
    const deniedBody = await json(deniedPost) as { code: string; message: string }
    expect(deniedBody.code).toBe("bad_request")
    expect(deniedBody.message).toBe("song posts require at least one audio media_ref")
  })

  test("song remix create returns 400 when rights_basis is not derivative", async () => {
    const ctx = await createRouteTestContext()
    cleanup = ctx.cleanup

    const session = await exchangeJwt(ctx.env, "community-song-remix-validation")
    const namespaceVerificationId = await prepareVerifiedNamespace(ctx.env, session.accessToken)

    const communityCreate = await requestJson("http://pirate.test/communities", {
      display_name: "Pirate Song Remix Club",
      namespace: {
        namespace_verification_id: namespaceVerificationId,
      },
    }, ctx.env, session.accessToken)
    expect(communityCreate.status).toBe(202)
    const communityCreateBody = await json(communityCreate) as {
      community: { community_id: string }
    }

    const deniedPost = await requestJson(
      `http://pirate.test/communities/${communityCreateBody.community.community_id}/posts`,
      {
        post_type: "song",
        identity_mode: "public",
        song_mode: "remix",
        rights_basis: "original",
        title: "Invalid Remix Basis",
        lyrics: "Remix lyrics",
        media_refs: [buildSongMediaRef("ipfs://song-remix-invalid-basis-audio")],
        idempotency_key: "post-key-song-remix-invalid-basis",
      },
      ctx.env,
      session.accessToken,
    )

    expect(deniedPost.status).toBe(400)
    const deniedBody = await json(deniedPost) as { code: string; message: string }
    expect(deniedBody.code).toBe("bad_request")
    expect(deniedBody.message).toBe("song remix posts must use rights_basis = derivative")
  })

  test("song post create and read derive lyrics and media refs from a registered bundle", async () => {
    const ctx = await createRouteTestContext()
    cleanup = ctx.cleanup

    const session = await exchangeJwt(ctx.env, "community-song-happy-path")
    const namespaceVerificationId = await prepareVerifiedNamespace(ctx.env, session.accessToken)

    const communityCreate = await requestJson("http://pirate.test/communities", {
      display_name: "Pirate Song Club",
      namespace: {
        namespace_verification_id: namespaceVerificationId,
      },
    }, ctx.env, session.accessToken)
    expect(communityCreate.status).toBe(202)
    const communityCreateBody = await json(communityCreate) as {
      community: { community_id: string }
    }

    const lyrics = "Sailing on a clean mainline song path."
    const uploadedPrimaryAudio = await createCompletedSongArtifactUpload({
      env: ctx.env,
      accessToken: session.accessToken,
      communityId: communityCreateBody.community.community_id,
      artifactKind: "primary_audio",
      mimeType: "audio/mpeg",
      filename: "song-happy-path.mp3",
      bytes: buildUploadBytes("song-happy-path-audio"),
    })
    const bundleCreate = await requestJson(
      `http://pirate.test/communities/${communityCreateBody.community.community_id}/song-artifacts`,
      {
        primary_audio: {
          ...buildSongMediaRef(uploadedPrimaryAudio.storage_ref),
          size_bytes: uploadedPrimaryAudio.size_bytes ?? 1024,
          content_hash: uploadedPrimaryAudio.content_hash ?? buildSongMediaRef(uploadedPrimaryAudio.storage_ref).content_hash,
        },
        lyrics,
      },
      ctx.env,
      session.accessToken,
    )
    expect(bundleCreate.status).toBe(201)
    const bundleCreateBody = await json(bundleCreate) as {
      song_artifact_bundle_id: string
    }

    const createSong = await requestJson(
      `http://pirate.test/communities/${communityCreateBody.community.community_id}/posts`,
      {
        post_type: "song",
        identity_mode: "public",
        song_mode: "original",
        rights_basis: "original",
        title: "Pirate Song",
        caption: "First executable song post.",
        song_artifact_bundle_id: bundleCreateBody.song_artifact_bundle_id,
        idempotency_key: "post-key-song-happy-path",
      },
      ctx.env,
      session.accessToken,
    )

    expect(createSong.status).toBe(201)
    const createSongBody = await json(createSong) as {
      post_id: string
      community_id: string
      post_type: string
      identity_mode: string
      song_mode: string | null
      rights_basis: string | null
      song_artifact_bundle_id: string | null
      asset_id: string | null
      status: string
      lyrics: string | null
      media_refs?: Array<{ storage_ref: string }>
    }
    expect(createSongBody.community_id).toBe(communityCreateBody.community.community_id)
    expect(createSongBody.post_type).toBe("song")
    expect(createSongBody.identity_mode).toBe("public")
    expect(createSongBody.song_mode).toBe("original")
    expect(createSongBody.rights_basis).toBe("original")
    expect(createSongBody.song_artifact_bundle_id).toBe(bundleCreateBody.song_artifact_bundle_id)
    expect(createSongBody.asset_id).toMatch(/^ast_/)
    expect(createSongBody.status).toBe("published")
    expect(createSongBody.lyrics).toBe(lyrics)
    expect(createSongBody.media_refs?.[0]?.storage_ref).toBe(uploadedPrimaryAudio.storage_ref)

    const assetRow = await readAssetRow({
      communityDbRoot: ctx.communityDbRoot,
      communityId: communityCreateBody.community.community_id,
      assetId: createSongBody.asset_id!,
    })
    expect(assetRow?.asset_id).toBe(createSongBody.asset_id)
    expect(assetRow?.source_post_id).toBe(createSongBody.post_id)
    expect(assetRow?.song_artifact_bundle_id).toBe(bundleCreateBody.song_artifact_bundle_id)
    expect(assetRow?.asset_kind).toBe("song_audio")
    expect(assetRow?.rights_basis).toBe("original")
    expect(assetRow?.access_mode).toBe("public")
    expect(assetRow?.primary_content_ref).toBe(uploadedPrimaryAudio.storage_ref)
    expect(assetRow?.publication_status).toBe("draft")
    expect(assetRow?.story_status).toBe("none")
    expect(assetRow?.locked_delivery_status).toBe("none")

    const replaySong = await requestJson(
      `http://pirate.test/communities/${communityCreateBody.community.community_id}/posts`,
      {
        post_type: "song",
        identity_mode: "public",
        song_mode: "original",
        rights_basis: "original",
        title: "Pirate Song",
        caption: "First executable song post.",
        song_artifact_bundle_id: bundleCreateBody.song_artifact_bundle_id,
        idempotency_key: "post-key-song-happy-path",
      },
      ctx.env,
      session.accessToken,
    )
    expect(replaySong.status).toBe(201)
    const replaySongBody = await json(replaySong) as {
      post_id: string
      song_artifact_bundle_id: string | null
    }
    expect(replaySongBody.post_id).toBe(createSongBody.post_id)
    expect(replaySongBody.song_artifact_bundle_id).toBe(bundleCreateBody.song_artifact_bundle_id)

    const secondSong = await requestJson(
      `http://pirate.test/communities/${communityCreateBody.community.community_id}/posts`,
      {
        post_type: "song",
        identity_mode: "public",
        song_mode: "original",
        rights_basis: "original",
        title: "Pirate Song Again",
        caption: "A second publish attempt should fail.",
        song_artifact_bundle_id: bundleCreateBody.song_artifact_bundle_id,
        idempotency_key: "post-key-song-happy-path-second-attempt",
      },
      ctx.env,
      session.accessToken,
    )
    expect(secondSong.status).toBe(400)
    const secondSongBody = await json(secondSong) as { code: string; message: string }
    expect(secondSongBody.code).toBe("bad_request")
    expect(secondSongBody.message).toBe("Song artifact bundle has already been used")

    const readSong = await app.request(
      `http://pirate.test/posts/${createSongBody.post_id}`,
      {
        headers: {
          authorization: `Bearer ${session.accessToken}`,
        },
      },
      ctx.env,
    )

    expect(readSong.status).toBe(200)
    const readSongBody = await json(readSong) as {
      post: {
        post_id: string
        community_id: string
        post_type: string
        song_mode: string | null
        rights_basis: string | null
        song_artifact_bundle_id: string | null
        lyrics: string | null
        media_refs?: Array<{ storage_ref: string }>
      }
    }
    expect(readSongBody.post.post_id).toBe(createSongBody.post_id)
    expect(readSongBody.post.community_id).toBe(communityCreateBody.community.community_id)
    expect(readSongBody.post.post_type).toBe("song")
    expect(readSongBody.post.song_mode).toBe("original")
    expect(readSongBody.post.rights_basis).toBe("original")
    expect(readSongBody.post.song_artifact_bundle_id).toBe(bundleCreateBody.song_artifact_bundle_id)
    expect(readSongBody.post.lyrics).toBe(lyrics)
    expect(readSongBody.post.media_refs?.[0]?.storage_ref).toBe(uploadedPrimaryAudio.storage_ref)

    const bundleRead = await app.request(
      `http://pirate.test/communities/${communityCreateBody.community.community_id}/song-artifacts/${bundleCreateBody.song_artifact_bundle_id}`,
      {
        headers: {
          authorization: `Bearer ${session.accessToken}`,
        },
      },
      ctx.env,
    )
    expect(bundleRead.status).toBe(200)
    const bundleReadBody = await json(bundleRead) as {
      status: string
      song_artifact_bundle_id: string
      preview_status: string
      translation_status: string
      alignment_status: string
      moderation_status: string
    }
    expect(bundleReadBody.song_artifact_bundle_id).toBe(bundleCreateBody.song_artifact_bundle_id)
    expect(bundleReadBody.status).toBe("consumed")
    expect(bundleReadBody.preview_status).toBe("pending")
    expect(bundleReadBody.translation_status).toBe("pending")
   expect(bundleReadBody.alignment_status).toBe("pending")
    expect(bundleReadBody.moderation_status).toBe("pending")
  })

  test("locked song post create uses preview media and asset reads redact the full payload ref", async () => {
    const ctx = await createRouteTestContext()
    cleanup = ctx.cleanup

    const session = await exchangeJwt(ctx.env, "community-song-locked-path")
    const namespaceVerificationId = await prepareVerifiedNamespace(ctx.env, session.accessToken, "PirateSongLockedRoot")

    const communityCreate = await requestJson("http://pirate.test/communities", {
      display_name: "Pirate Locked Song Club",
      namespace: {
        namespace_verification_id: namespaceVerificationId,
      },
    }, ctx.env, session.accessToken)
    expect(communityCreate.status).toBe(202)
    const communityCreateBody = await json(communityCreate) as {
      community: { community_id: string }
    }

    const uploadedPrimaryAudio = await createCompletedSongArtifactUpload({
      env: ctx.env,
      accessToken: session.accessToken,
      communityId: communityCreateBody.community.community_id,
      artifactKind: "primary_audio",
      mimeType: "audio/mpeg",
      filename: "song-locked-path.mp3",
      bytes: buildUploadBytes("song-locked-path-audio"),
    })
    const uploadedPreviewAudio = await createCompletedSongArtifactUpload({
      env: ctx.env,
      accessToken: session.accessToken,
      communityId: communityCreateBody.community.community_id,
      artifactKind: "preview_audio",
      mimeType: "audio/mpeg",
      filename: "song-locked-preview.mp3",
      bytes: buildUploadBytes("song-locked-preview-audio"),
    })
    const uploadedCoverArt = await createCompletedSongArtifactUpload({
      env: ctx.env,
      accessToken: session.accessToken,
      communityId: communityCreateBody.community.community_id,
      artifactKind: "cover_art",
      mimeType: "image/png",
      filename: "song-locked-cover.png",
      bytes: buildUploadBytes("song-locked-cover-art"),
    })
    const uploadedCanvasVideo = await createCompletedSongArtifactUpload({
      env: ctx.env,
      accessToken: session.accessToken,
      communityId: communityCreateBody.community.community_id,
      artifactKind: "canvas_video",
      mimeType: "video/mp4",
      filename: "song-locked-canvas.mp4",
      bytes: buildUploadBytes("song-locked-canvas-video"),
    })

    const bundleCreate = await requestJson(
      `http://pirate.test/communities/${communityCreateBody.community.community_id}/song-artifacts`,
      {
        primary_audio: {
          ...buildSongMediaRef(uploadedPrimaryAudio.storage_ref),
          size_bytes: uploadedPrimaryAudio.size_bytes ?? 1024,
          content_hash: uploadedPrimaryAudio.content_hash ?? buildSongMediaRef(uploadedPrimaryAudio.storage_ref).content_hash,
        },
        preview_audio: {
          ...buildSongMediaRef(uploadedPreviewAudio.storage_ref),
          size_bytes: uploadedPreviewAudio.size_bytes ?? 1024,
          content_hash: uploadedPreviewAudio.content_hash ?? buildSongMediaRef(uploadedPreviewAudio.storage_ref).content_hash,
        },
        cover_art: {
          storage_ref: uploadedCoverArt.storage_ref,
          mime_type: "image/png",
          size_bytes: uploadedCoverArt.size_bytes,
          content_hash: uploadedCoverArt.content_hash,
          width: 1200,
          height: 1200,
        },
        canvas_video: {
          storage_ref: uploadedCanvasVideo.storage_ref,
          mime_type: "video/mp4",
          size_bytes: uploadedCanvasVideo.size_bytes,
          content_hash: uploadedCanvasVideo.content_hash,
          duration_ms: 8000,
          width: 1080,
          height: 1920,
        },
        lyrics: "Locked song path lyrics",
      },
      ctx.env,
      session.accessToken,
    )
    expect(bundleCreate.status).toBe(201)
    const bundleCreateBody = await json(bundleCreate) as { song_artifact_bundle_id: string }

    const createSong = await requestJson(
      `http://pirate.test/communities/${communityCreateBody.community.community_id}/posts`,
      {
        post_type: "song",
        identity_mode: "public",
        song_mode: "original",
        rights_basis: "original",
        access_mode: "locked",
        title: "Locked Pirate Song",
        song_artifact_bundle_id: bundleCreateBody.song_artifact_bundle_id,
        idempotency_key: "post-key-song-locked-path",
      },
      ctx.env,
      session.accessToken,
    )
    expect(createSong.status).toBe(201)
    const createSongBody = await json(createSong) as {
      asset_id: string | null
      media_refs?: Array<{ storage_ref: string }>
    }
    expect(createSongBody.asset_id).toMatch(/^ast_/)
    expect(createSongBody.media_refs?.[0]?.storage_ref).toBe(uploadedPreviewAudio.storage_ref)

    const assetRow = await readAssetRow({
      communityDbRoot: ctx.communityDbRoot,
      communityId: communityCreateBody.community.community_id,
      assetId: createSongBody.asset_id!,
    })
    expect(assetRow?.access_mode).toBe("locked")
    expect(assetRow?.primary_content_ref).toBe(uploadedPrimaryAudio.storage_ref)
    expect(assetRow?.locked_delivery_status).toBe("none")
    expect(JSON.parse(assetRow?.preview_audio_json || "{}").storage_ref).toBe(uploadedPreviewAudio.storage_ref)
    expect(JSON.parse(assetRow?.cover_art_json || "{}").storage_ref).toBe(uploadedCoverArt.storage_ref)
    expect(JSON.parse(assetRow?.canvas_video_json || "{}").storage_ref).toBe(uploadedCanvasVideo.storage_ref)

    const readAsset = await app.request(
      `http://pirate.test/communities/${communityCreateBody.community.community_id}/assets/${createSongBody.asset_id}`,
      {
        headers: {
          authorization: `Bearer ${session.accessToken}`,
        },
      },
      ctx.env,
    )
    expect(readAsset.status).toBe(200)
    const readAssetBody = await json(readAsset) as {
      asset_id: string
      access_mode: string
      primary_content_ref: string | null
      primary_content_hash: string | null
      preview_audio: { storage_ref: string } | null
      cover_art: { storage_ref: string } | null
      canvas_video: { storage_ref: string } | null
      locked_delivery_status: string
    }
    expect(readAssetBody.asset_id).toBe(createSongBody.asset_id)
    expect(readAssetBody.access_mode).toBe("locked")
    expect(readAssetBody.primary_content_ref).toBeNull()
    expect(readAssetBody.primary_content_hash).toBeNull()
    expect(readAssetBody.preview_audio?.storage_ref).toBe(uploadedPreviewAudio.storage_ref)
    expect(readAssetBody.cover_art?.storage_ref).toBe(uploadedCoverArt.storage_ref)
    expect(readAssetBody.canvas_video?.storage_ref).toBe(uploadedCanvasVideo.storage_ref)
    expect(readAssetBody.locked_delivery_status).toBe("none")
  })

  test("public song asset access returns the direct asset payload ref", async () => {
    const ctx = await createRouteTestContext()
    cleanup = ctx.cleanup

    const session = await exchangeJwt(ctx.env, "community-song-asset-access-public")
    const namespaceVerificationId = await prepareVerifiedNamespace(ctx.env, session.accessToken, "PirateSongAssetAccessPublic")

    const communityCreate = await requestJson("http://pirate.test/communities", {
      display_name: "Pirate Public Asset Access Club",
      namespace: {
        namespace_verification_id: namespaceVerificationId,
      },
    }, ctx.env, session.accessToken)
    expect(communityCreate.status).toBe(202)
    const communityCreateBody = await json(communityCreate) as {
      community: { community_id: string }
    }

    const uploadedPrimaryAudio = await createCompletedSongArtifactUpload({
      env: ctx.env,
      accessToken: session.accessToken,
      communityId: communityCreateBody.community.community_id,
      artifactKind: "primary_audio",
      mimeType: "audio/mpeg",
      filename: "public-access.mp3",
      bytes: buildUploadBytes("public-access-audio"),
    })

    const bundleCreate = await requestJson(
      `http://pirate.test/communities/${communityCreateBody.community.community_id}/song-artifacts`,
      {
        primary_audio: {
          ...buildSongMediaRef(uploadedPrimaryAudio.storage_ref),
          size_bytes: uploadedPrimaryAudio.size_bytes ?? 1024,
          content_hash: uploadedPrimaryAudio.content_hash ?? buildSongMediaRef(uploadedPrimaryAudio.storage_ref).content_hash,
        },
        lyrics: "Public song access lyrics",
      },
      ctx.env,
      session.accessToken,
    )
    expect(bundleCreate.status).toBe(201)
    const bundleCreateBody = await json(bundleCreate) as { song_artifact_bundle_id: string }

    const createSong = await requestJson(
      `http://pirate.test/communities/${communityCreateBody.community.community_id}/posts`,
      {
        post_type: "song",
        identity_mode: "public",
        song_mode: "original",
        rights_basis: "original",
        title: "Public Access Song",
        song_artifact_bundle_id: bundleCreateBody.song_artifact_bundle_id,
        idempotency_key: "post-key-song-public-access",
      },
      ctx.env,
      session.accessToken,
    )
    expect(createSong.status).toBe(201)
    const createSongBody = await json(createSong) as {
      asset_id: string | null
    }
    expect(createSongBody.asset_id).toMatch(/^ast_/)

    const accessResponse = await app.request(
      `http://pirate.test/communities/${communityCreateBody.community.community_id}/assets/${createSongBody.asset_id}/access`,
      {
        headers: {
          authorization: `Bearer ${session.accessToken}`,
        },
      },
      ctx.env,
    )
    expect(accessResponse.status).toBe(200)
    const accessBody = await json(accessResponse) as {
      asset_id: string
      access_mode: string
      access_granted: boolean
      decision_reason: string
      delivery_kind: string | null
      delivery_ref: string | null
    }
    expect(accessBody.asset_id).toBe(createSongBody.asset_id)
    expect(accessBody.access_mode).toBe("public")
    expect(accessBody.access_granted).toBe(true)
    expect(accessBody.decision_reason).toBe("public")
    expect(accessBody.delivery_kind).toBe("primary_content_ref")
    expect(accessBody.delivery_ref).toBe(uploadedPrimaryAudio.storage_ref)
  })

  test("locked song asset access grants creators and buyers, denies unpaid members, and hides moderated posts", async () => {
    const ctx = await createRouteTestContext()
    cleanup = ctx.cleanup
    ctx.env.INTERNAL_JOB_RUNNER_TOKEN = "internal-song-job-token"

    const creator = await exchangeJwt(ctx.env, "community-song-asset-access-creator")
    const buyer = await exchangeJwt(ctx.env, "community-song-asset-access-buyer")
    const member = await exchangeJwt(ctx.env, "community-song-asset-access-member")
    const namespaceVerificationId = await prepareVerifiedNamespace(ctx.env, creator.accessToken, "PirateSongAssetAccessLocked")

    const communityCreate = await requestJson("http://pirate.test/communities", {
      display_name: "Pirate Locked Asset Access Club",
      namespace: {
        namespace_verification_id: namespaceVerificationId,
      },
    }, ctx.env, creator.accessToken)
    expect(communityCreate.status).toBe(202)
    const communityCreateBody = await json(communityCreate) as {
      community: { community_id: string }
    }

    await addCommunityMember(ctx.communityDbRoot, communityCreateBody.community.community_id, member.userId)

    const uploadedPrimaryAudio = await createCompletedSongArtifactUpload({
      env: ctx.env,
      accessToken: creator.accessToken,
      communityId: communityCreateBody.community.community_id,
      artifactKind: "primary_audio",
      mimeType: "audio/mpeg",
      filename: "locked-access.mp3",
      bytes: buildUploadBytes("locked-access-audio"),
    })
    const uploadedPreviewAudio = await createCompletedSongArtifactUpload({
      env: ctx.env,
      accessToken: creator.accessToken,
      communityId: communityCreateBody.community.community_id,
      artifactKind: "preview_audio",
      mimeType: "audio/mpeg",
      filename: "locked-access-preview.mp3",
      bytes: buildUploadBytes("locked-access-preview-audio"),
    })

    const bundleCreate = await requestJson(
      `http://pirate.test/communities/${communityCreateBody.community.community_id}/song-artifacts`,
      {
        primary_audio: {
          ...buildSongMediaRef(uploadedPrimaryAudio.storage_ref),
          size_bytes: uploadedPrimaryAudio.size_bytes ?? 1024,
          content_hash: uploadedPrimaryAudio.content_hash ?? buildSongMediaRef(uploadedPrimaryAudio.storage_ref).content_hash,
        },
        preview_audio: {
          ...buildSongMediaRef(uploadedPreviewAudio.storage_ref),
          size_bytes: uploadedPreviewAudio.size_bytes ?? 1024,
          content_hash: uploadedPreviewAudio.content_hash ?? buildSongMediaRef(uploadedPreviewAudio.storage_ref).content_hash,
        },
        lyrics: "Locked asset access lyrics",
      },
      ctx.env,
      creator.accessToken,
    )
    expect(bundleCreate.status).toBe(201)
    const bundleCreateBody = await json(bundleCreate) as { song_artifact_bundle_id: string }

    const createSong = await requestJson(
      `http://pirate.test/communities/${communityCreateBody.community.community_id}/posts`,
      {
        post_type: "song",
        identity_mode: "public",
        song_mode: "original",
        rights_basis: "original",
        access_mode: "locked",
        title: "Locked Access Song",
        song_artifact_bundle_id: bundleCreateBody.song_artifact_bundle_id,
        idempotency_key: "post-key-song-locked-access",
      },
      ctx.env,
      creator.accessToken,
    )
    expect(createSong.status).toBe(201)
    const createSongBody = await json(createSong) as {
      asset_id: string | null
    }
    expect(createSongBody.asset_id).toMatch(/^ast_/)

    const lockedDeliveryDrain = await app.request(
      "http://pirate.test/jobs/internal/song-locked-deliveries/drain?limit=1",
      {
        method: "POST",
        headers: {
          authorization: "Bearer internal-song-job-token",
        },
      },
      ctx.env,
    )
    expect(lockedDeliveryDrain.status).toBe(200)

    const assetRow = await readAssetRow({
      communityDbRoot: ctx.communityDbRoot,
      communityId: communityCreateBody.community.community_id,
      assetId: createSongBody.asset_id!,
    })
    expect(assetRow?.locked_delivery_status).toBe("ready")
    expect(assetRow?.locked_delivery_ref).toMatch(/^pirate-cdr:\/\//)

    const creatorAccess = await app.request(
      `http://pirate.test/communities/${communityCreateBody.community.community_id}/assets/${createSongBody.asset_id}/access`,
      {
        headers: {
          authorization: `Bearer ${creator.accessToken}`,
        },
      },
      ctx.env,
    )
    expect(creatorAccess.status).toBe(200)
    const creatorAccessBody = await json(creatorAccess) as {
      access_granted: boolean
      decision_reason: string
      delivery_kind: string | null
      delivery_ref: string | null
    }
    expect(creatorAccessBody.access_granted).toBe(true)
    expect(creatorAccessBody.decision_reason).toBe("creator")
    expect(creatorAccessBody.delivery_kind).toBe("locked_delivery_ref")
    expect(creatorAccessBody.delivery_ref).toBe(assetRow?.locked_delivery_ref)

    const unpaidMemberAccess = await app.request(
      `http://pirate.test/communities/${communityCreateBody.community.community_id}/assets/${createSongBody.asset_id}/access`,
      {
        headers: {
          authorization: `Bearer ${member.accessToken}`,
        },
      },
      ctx.env,
    )
    expect(unpaidMemberAccess.status).toBe(200)
    const unpaidMemberAccessBody = await json(unpaidMemberAccess) as {
      access_granted: boolean
      decision_reason: string
      delivery_kind: string | null
      delivery_ref: string | null
    }
    expect(unpaidMemberAccessBody.access_granted).toBe(false)
    expect(unpaidMemberAccessBody.decision_reason).toBe("purchase_required")
    expect(unpaidMemberAccessBody.delivery_kind).toBeNull()
    expect(unpaidMemberAccessBody.delivery_ref).toBeNull()

    await setPrimaryWalletAttachment(
      ctx.env,
      buyer.userId,
      "0x2222222222222222222222222222222222222222",
    )
    await insertCommunityListing({
      communityDbRoot: ctx.communityDbRoot,
      communityId: communityCreateBody.community.community_id,
      listingId: "lst_locked_access_1",
      createdByUserId: creator.userId,
      assetId: createSongBody.asset_id!,
      priceUsd: "7.00",
    })

    const quoteResponse = await requestJson(
      `http://pirate.test/communities/${communityCreateBody.community.community_id}/purchase-quotes`,
      {
        listing_id: "lst_locked_access_1",
        client_estimated_slippage_bps: 0,
        client_estimated_hop_count: 0,
      },
      ctx.env,
      buyer.accessToken,
    )
    expect(quoteResponse.status).toBe(200)
    const quoteBody = await json(quoteResponse) as { quote_id: string }

    const settlementResponse = await requestJson(
      `http://pirate.test/communities/${communityCreateBody.community.community_id}/purchase-settlements`,
      {
        quote_id: quoteBody.quote_id,
        settlement_wallet_attachment_id: `wal_${buyer.userId}`,
        settlement_tx_ref: "story:0xlockedaccess1",
      },
      ctx.env,
      buyer.accessToken,
    )
    expect(settlementResponse.status).toBe(200)

    const buyerAccess = await app.request(
      `http://pirate.test/communities/${communityCreateBody.community.community_id}/assets/${createSongBody.asset_id}/access`,
      {
        headers: {
          authorization: `Bearer ${buyer.accessToken}`,
        },
      },
      ctx.env,
    )
    expect(buyerAccess.status).toBe(200)
    const buyerAccessBody = await json(buyerAccess) as {
      access_granted: boolean
      decision_reason: string
      delivery_kind: string | null
      delivery_ref: string | null
    }
    expect(buyerAccessBody.access_granted).toBe(true)
    expect(buyerAccessBody.decision_reason).toBe("purchase_entitlement")
    expect(buyerAccessBody.delivery_kind).toBe("locked_delivery_ref")
    expect(buyerAccessBody.delivery_ref).toBe(assetRow?.locked_delivery_ref)

    const buyerDownload = await app.request(
      `http://pirate.test/communities/${communityCreateBody.community.community_id}/assets/${createSongBody.asset_id}/download`,
      {
        headers: {
          authorization: `Bearer ${buyer.accessToken}`,
        },
      },
      ctx.env,
    )
    expect(buyerDownload.status).toBe(200)
    expect(buyerDownload.headers.get("content-type")).toBe("application/octet-stream")
    expect(buyerDownload.headers.get("content-disposition")).toContain(`${createSongBody.asset_id}.bin`)
    expect(new TextDecoder().decode(await buyerDownload.arrayBuffer())).toBe("locked-access-audio")

    await setPostStatus({
      communityDbRoot: ctx.communityDbRoot,
      communityId: communityCreateBody.community.community_id,
      postId: assetRow!.source_post_id,
      status: "hidden",
      analysisState: "blocked",
    })

    const hiddenBuyerAccess = await app.request(
      `http://pirate.test/communities/${communityCreateBody.community.community_id}/assets/${createSongBody.asset_id}/access`,
      {
        headers: {
          authorization: `Bearer ${buyer.accessToken}`,
        },
      },
      ctx.env,
    )
    expect(hiddenBuyerAccess.status).toBe(404)
  })

  test("locked song buyer download uses the configured CDR adapter read path with a Lit access proof", async () => {
    const originalFetch = globalThis.fetch
    let cdrReadBody: Record<string, unknown> | null = null
    let litRequestBody: Record<string, unknown> | null = null
    let recoveredContentKeyBase64 = ""
    globalThis.fetch = (async (input, init) => {
      const url = typeof input === "string" ? input : input instanceof URL ? input.toString() : input.url
      if (url === "https://api.dev.litprotocol.com/core/v1/lit_action") {
        litRequestBody = JSON.parse(String(init?.body || "{}")) as Record<string, unknown>
        return new Response(JSON.stringify({
          response: JSON.stringify({
            signerAddress: "0x2125952f22ad971df5645e31a613fe42dcc42c48",
            signature: `0x${"11".repeat(32)}${"22".repeat(32)}1b`,
          }),
        }), {
          headers: { "content-type": "application/json" },
        })
      }
      if (url === "https://rpc.ankr.com/story_aeneid_testnet") {
        const body = JSON.parse(String(init?.body || "{}")) as { method?: string }
        if (body.method === "eth_call") {
          return new Response(JSON.stringify({
            result: `0x${"ab".repeat(32)}`,
          }), {
            headers: { "content-type": "application/json" },
          })
        }
      }
      if (url === "https://cdr.test/v1/locked-assets/write") {
        return new Response(JSON.stringify({
          delivery_ref: "cdr://vaults/77/assets/locked-cdr-read",
        }), {
          headers: { "content-type": "application/json" },
        })
      }
      if (url === "https://cdr.test/v1/locked-assets/read") {
        cdrReadBody = JSON.parse(String(init?.body || "{}")) as Record<string, unknown>
        return new Response(JSON.stringify({
          recovery_payload: {
            content_key_base64: recoveredContentKeyBase64,
          },
        }), {
          headers: { "content-type": "application/json" },
        })
      }
      return originalFetch(input as never, init)
    }) as typeof globalThis.fetch

    try {
      const ctx = await createRouteTestContext({
        STORY_CDR_API_BASE_URL: "https://cdr.test",
        STORY_CDR_API_KEY: "cdr-api-key",
        LIT_CHIPOTLE_ACCESS_CONTROLLER_API_KEY: "lit-access-key",
      })
      cleanup = ctx.cleanup
      ctx.env.INTERNAL_JOB_RUNNER_TOKEN = "internal-song-job-token"

      const creator = await exchangeJwt(ctx.env, "community-song-cdr-read-creator")
      const buyer = await exchangeJwt(ctx.env, "community-song-cdr-read-buyer")
      const namespaceVerificationId = await prepareVerifiedNamespace(ctx.env, creator.accessToken, "PirateSongCdrReadRoot")

      const communityCreate = await requestJson("http://pirate.test/communities", {
        display_name: "Pirate Song CDR Read Club",
        namespace: {
          namespace_verification_id: namespaceVerificationId,
        },
      }, ctx.env, creator.accessToken)
      expect(communityCreate.status).toBe(202)
      const communityCreateBody = await json(communityCreate) as {
        community: { community_id: string }
      }

      await setPrimaryWalletAttachment(
        ctx.env,
        buyer.userId,
        "0x3333333333333333333333333333333333333333",
      )

      const uploadedPrimaryAudio = await createCompletedSongArtifactUpload({
        env: ctx.env,
        accessToken: creator.accessToken,
        communityId: communityCreateBody.community.community_id,
        artifactKind: "primary_audio",
        mimeType: "audio/mpeg",
        filename: "locked-cdr-read.mp3",
        bytes: buildUploadBytes("locked-cdr-read-audio"),
      })
      const uploadedPreviewAudio = await createCompletedSongArtifactUpload({
        env: ctx.env,
        accessToken: creator.accessToken,
        communityId: communityCreateBody.community.community_id,
        artifactKind: "preview_audio",
        mimeType: "audio/mpeg",
        filename: "locked-cdr-read-preview.mp3",
        bytes: buildUploadBytes("locked-cdr-read-preview-audio"),
      })

      const bundleCreate = await requestJson(
        `http://pirate.test/communities/${communityCreateBody.community.community_id}/song-artifacts`,
        {
          primary_audio: {
            ...buildSongMediaRef(uploadedPrimaryAudio.storage_ref),
            size_bytes: uploadedPrimaryAudio.size_bytes ?? 1024,
            content_hash: uploadedPrimaryAudio.content_hash ?? buildSongMediaRef(uploadedPrimaryAudio.storage_ref).content_hash,
          },
          preview_audio: {
            ...buildSongMediaRef(uploadedPreviewAudio.storage_ref),
            size_bytes: uploadedPreviewAudio.size_bytes ?? 1024,
            content_hash: uploadedPreviewAudio.content_hash ?? buildSongMediaRef(uploadedPreviewAudio.storage_ref).content_hash,
          },
          lyrics: "CDR read lyrics",
        },
        ctx.env,
        creator.accessToken,
      )
      expect(bundleCreate.status).toBe(201)
      const bundleCreateBody = await json(bundleCreate) as { song_artifact_bundle_id: string }

      const createSong = await requestJson(
        `http://pirate.test/communities/${communityCreateBody.community.community_id}/posts`,
        {
          post_type: "song",
          identity_mode: "public",
          song_mode: "original",
          rights_basis: "original",
          access_mode: "locked",
          title: "Locked CDR Read Song",
          song_artifact_bundle_id: bundleCreateBody.song_artifact_bundle_id,
          idempotency_key: "post-key-song-cdr-read",
        },
        ctx.env,
        creator.accessToken,
      )
      expect(createSong.status).toBe(201)
      const createSongBody = await json(createSong) as { asset_id: string }

      const lockedDeliveryDrain = await app.request(
        "http://pirate.test/jobs/internal/song-locked-deliveries/drain?limit=1",
        {
          method: "POST",
          headers: {
            authorization: "Bearer internal-song-job-token",
          },
        },
        ctx.env,
      )
      expect(lockedDeliveryDrain.status).toBe(200)

      const assetRow = await readAssetRow({
        communityDbRoot: ctx.communityDbRoot,
        communityId: communityCreateBody.community.community_id,
        assetId: createSongBody.asset_id,
      })
      const lockedPayload = JSON.parse(String(assetRow?.locked_delivery_payload_json || "{}")) as {
        content_key_base64?: string
      }
      recoveredContentKeyBase64 = String(lockedPayload.content_key_base64 || "")
      expect(recoveredContentKeyBase64).not.toBe("")

      await insertCommunityListing({
        communityDbRoot: ctx.communityDbRoot,
        communityId: communityCreateBody.community.community_id,
        listingId: "lst_cdr_read_1",
        createdByUserId: creator.userId,
        assetId: createSongBody.asset_id,
        priceUsd: "7.00",
      })

      const quoteResponse = await requestJson(
        `http://pirate.test/communities/${communityCreateBody.community.community_id}/purchase-quotes`,
        {
          listing_id: "lst_cdr_read_1",
          client_estimated_slippage_bps: 0,
          client_estimated_hop_count: 0,
        },
        ctx.env,
        buyer.accessToken,
      )
      expect(quoteResponse.status).toBe(200)
      const quoteBody = await json(quoteResponse) as { quote_id: string }

      const settlementResponse = await requestJson(
        `http://pirate.test/communities/${communityCreateBody.community.community_id}/purchase-settlements`,
        {
          quote_id: quoteBody.quote_id,
          settlement_wallet_attachment_id: `wal_${buyer.userId}`,
          settlement_tx_ref: "story:0xcdrread1",
        },
        ctx.env,
        buyer.accessToken,
      )
      expect(settlementResponse.status).toBe(200)

      const buyerDownload = await app.request(
        `http://pirate.test/communities/${communityCreateBody.community.community_id}/assets/${createSongBody.asset_id}/download`,
        {
          headers: {
            authorization: `Bearer ${buyer.accessToken}`,
          },
        },
        ctx.env,
      )
      expect(buyerDownload.status).toBe(200)
      expect(new TextDecoder().decode(await buyerDownload.arrayBuffer())).toBe("locked-cdr-read-audio")
      const typedCdrReadBody = cdrReadBody as {
        delivery_ref?: unknown
        access_proof?: { scope?: unknown }
      } | null
      const typedLitRequestBody = litRequestBody as {
        code?: unknown
        js_params?: Record<string, unknown>
      } | null
      expect(typedCdrReadBody?.delivery_ref).toBe(assetRow?.locked_delivery_ref)
      expect(typedCdrReadBody?.access_proof?.scope).toBe("asset.share")
      expect(typeof typedLitRequestBody?.code).toBe("string")
      expect(typedLitRequestBody?.js_params).toMatchObject({
        expectedSignerAddress: "0x2125952f22ad971df5645e31a613fe42dcc42c48",
      })
    } finally {
      globalThis.fetch = originalFetch
    }
  })

  test("locked song asset CDR manifest returns token-gated client download inputs for an entitled buyer", async () => {
    const ctx = await createRouteTestContext({
      INTERNAL_JOB_RUNNER_TOKEN: "internal-song-job-token",
    })
    cleanup = ctx.cleanup

    const creator = await exchangeJwt(ctx.env, "community-song-cdr-manifest-creator")
    const buyer = await exchangeJwt(ctx.env, "community-song-cdr-manifest-buyer")
    const namespaceVerificationId = await prepareVerifiedNamespace(ctx.env, creator.accessToken, "PirateSongCdrManifestRoot")

    const communityCreate = await requestJson("http://pirate.test/communities", {
      display_name: "Pirate Song CDR Manifest Club",
      namespace: {
        namespace_verification_id: namespaceVerificationId,
      },
    }, ctx.env, creator.accessToken)
    expect(communityCreate.status).toBe(202)
    const communityCreateBody = await json(communityCreate) as {
      community: { community_id: string }
    }

    await setPrimaryWalletAttachment(
      ctx.env,
      creator.userId,
      "0x4444444444444444444444444444444444444444",
    )
    await setPrimaryWalletAttachment(
      ctx.env,
      buyer.userId,
      "0x5555555555555555555555555555555555555555",
    )

    const uploadedPrimaryAudio = await createCompletedSongArtifactUpload({
      env: ctx.env,
      accessToken: creator.accessToken,
      communityId: communityCreateBody.community.community_id,
      artifactKind: "primary_audio",
      mimeType: "audio/mpeg",
      filename: "locked-cdr-manifest.mp3",
      bytes: buildUploadBytes("locked-cdr-manifest-audio"),
    })
    const uploadedPreviewAudio = await createCompletedSongArtifactUpload({
      env: ctx.env,
      accessToken: creator.accessToken,
      communityId: communityCreateBody.community.community_id,
      artifactKind: "preview_audio",
      mimeType: "audio/mpeg",
      filename: "locked-cdr-manifest-preview.mp3",
      bytes: buildUploadBytes("locked-cdr-manifest-preview-audio"),
    })
    const uploadedCanvasVideo = await createCompletedSongArtifactUpload({
      env: ctx.env,
      accessToken: creator.accessToken,
      communityId: communityCreateBody.community.community_id,
      artifactKind: "canvas_video",
      mimeType: "video/mp4",
      filename: "locked-cdr-manifest-canvas.mp4",
      bytes: buildUploadBytes("locked-cdr-manifest-canvas-video"),
    })

    const bundleCreate = await requestJson(
      `http://pirate.test/communities/${communityCreateBody.community.community_id}/song-artifacts`,
      {
        primary_audio: {
          ...buildSongMediaRef(uploadedPrimaryAudio.storage_ref),
          size_bytes: uploadedPrimaryAudio.size_bytes ?? 1024,
          content_hash: uploadedPrimaryAudio.content_hash ?? buildSongMediaRef(uploadedPrimaryAudio.storage_ref).content_hash,
        },
        preview_audio: {
          ...buildSongMediaRef(uploadedPreviewAudio.storage_ref),
          size_bytes: uploadedPreviewAudio.size_bytes ?? 1024,
          content_hash: uploadedPreviewAudio.content_hash ?? buildSongMediaRef(uploadedPreviewAudio.storage_ref).content_hash,
        },
        canvas_video: {
          ...buildSongMediaRef(uploadedCanvasVideo.storage_ref),
          mime_type: "video/mp4",
          size_bytes: uploadedCanvasVideo.size_bytes ?? 1024,
          content_hash: uploadedCanvasVideo.content_hash ?? buildSongMediaRef(uploadedCanvasVideo.storage_ref).content_hash,
          width: 720,
          height: 1280,
          duration_ms: 3_000,
        },
        lyrics: "CDR manifest lyrics",
      },
      ctx.env,
      creator.accessToken,
    )
    expect(bundleCreate.status).toBe(201)
    const bundleCreateBody = await json(bundleCreate) as { song_artifact_bundle_id: string }

    const createSong = await requestJson(
      `http://pirate.test/communities/${communityCreateBody.community.community_id}/posts`,
      {
        post_type: "song",
        identity_mode: "public",
        song_mode: "original",
        rights_basis: "original",
        access_mode: "locked",
        title: "Locked CDR Manifest Song",
        song_artifact_bundle_id: bundleCreateBody.song_artifact_bundle_id,
        idempotency_key: "post-key-song-cdr-manifest",
      },
      ctx.env,
      creator.accessToken,
    )
    expect(createSong.status).toBe(201)
    const createSongBody = await json(createSong) as { asset_id: string }

    const lockedDeliveryDrain = await app.request(
      "http://pirate.test/jobs/internal/song-locked-deliveries/drain?limit=1",
      {
        method: "POST",
        headers: {
          authorization: "Bearer internal-song-job-token",
        },
      },
      ctx.env,
    )
    expect(lockedDeliveryDrain.status).toBe(200)

    await setAssetCdrFields({
      communityDbRoot: ctx.communityDbRoot,
      communityId: communityCreateBody.community.community_id,
      assetId: createSongBody.asset_id,
      vaultUuid: 77,
      encryptedCid: "bafybeicdrmanifestcid",
    })

    const readAssetResponse = await app.request(
      `http://pirate.test/communities/${communityCreateBody.community.community_id}/assets/${createSongBody.asset_id}`,
      {
        headers: {
          authorization: `Bearer ${creator.accessToken}`,
        },
      },
      ctx.env,
    )
    expect(readAssetResponse.status).toBe(200)
    const readAssetBody = await json(readAssetResponse) as {
      primary_content_ref: string | null
      preview_audio: { storage_ref: string } | null
      canvas_video: { storage_ref: string } | null
      locked_delivery_status: string
    }
    expect(readAssetBody.primary_content_ref).toBeNull()
    expect(readAssetBody.preview_audio?.storage_ref).toBe(uploadedPreviewAudio.storage_ref)
    expect(readAssetBody.canvas_video?.storage_ref).toBe(uploadedCanvasVideo.storage_ref)
    expect(readAssetBody.locked_delivery_status).toBe("ready")

    await insertCommunityListing({
      communityDbRoot: ctx.communityDbRoot,
      communityId: communityCreateBody.community.community_id,
      listingId: "lst_cdr_manifest_1",
      createdByUserId: creator.userId,
      assetId: createSongBody.asset_id,
      priceUsd: "7.00",
    })

    const quoteResponse = await requestJson(
      `http://pirate.test/communities/${communityCreateBody.community.community_id}/purchase-quotes`,
      {
        listing_id: "lst_cdr_manifest_1",
        client_estimated_slippage_bps: 0,
        client_estimated_hop_count: 0,
      },
      ctx.env,
      buyer.accessToken,
    )
    expect(quoteResponse.status).toBe(200)
    const quoteBody = await json(quoteResponse) as { quote_id: string }

    const settlementResponse = await requestJson(
      `http://pirate.test/communities/${communityCreateBody.community.community_id}/purchase-settlements`,
      {
        quote_id: quoteBody.quote_id,
        settlement_wallet_attachment_id: `wal_${buyer.userId}`,
        settlement_tx_ref: "story:0xcdrmanifest1",
      },
      ctx.env,
      buyer.accessToken,
    )
    expect(settlementResponse.status).toBe(200)

    const manifestResponse = await app.request(
      `http://pirate.test/communities/${communityCreateBody.community.community_id}/assets/${createSongBody.asset_id}/cdr-manifest?wallet_attachment_id=wal_${buyer.userId}`,
      {
        headers: {
          authorization: `Bearer ${buyer.accessToken}`,
        },
      },
      ctx.env,
    )
    expect(manifestResponse.status).toBe(200)
    const manifestBody = await json(manifestResponse) as {
      asset_id: string
      encrypted_cid: string
      vault_uuid: number
      rpc_url: string
      gateway_base_url: string
      signer_family: string | null
      scope: string | null
      access_aux_data: string
      caller_address: string
    } & Record<string, unknown>
    expect(manifestBody.asset_id).toBe(createSongBody.asset_id)
    expect(manifestBody.encrypted_cid).toBe("bafybeicdrmanifestcid")
    expect(manifestBody.vault_uuid).toBe(77)
    expect(manifestBody.rpc_url).toBe("https://rpc.ankr.com/story_aeneid_testnet")
    expect(manifestBody.gateway_base_url).toBe("https://psc.myfilebase.com/ipfs")
    expect(manifestBody.signer_family).toBeNull()
    expect(manifestBody.scope).toBeNull()
    expect(manifestBody.access_aux_data).toBe("0x")
    expect(manifestBody.caller_address).toBe("0x5555555555555555555555555555555555555555")
    expect("canvas_video" in manifestBody).toBe(false)
  })

  test("locked song backend download fails explicitly for SDK-backed CDR assets", async () => {
    const ctx = await createRouteTestContext({
      INTERNAL_JOB_RUNNER_TOKEN: "internal-song-job-token",
    })
    cleanup = ctx.cleanup

    const creator = await exchangeJwt(ctx.env, "community-song-cdr-sdk-download-creator")
    const buyer = await exchangeJwt(ctx.env, "community-song-cdr-sdk-download-buyer")
    const namespaceVerificationId = await prepareVerifiedNamespace(ctx.env, creator.accessToken, "PirateSongCdrSdkDownloadRoot")

    const communityCreate = await requestJson("http://pirate.test/communities", {
      display_name: "Pirate Song CDR SDK Download Club",
      namespace: {
        namespace_verification_id: namespaceVerificationId,
      },
    }, ctx.env, creator.accessToken)
    expect(communityCreate.status).toBe(202)
    const communityCreateBody = await json(communityCreate) as { community: { community_id: string } }

    await setPrimaryWalletAttachment(ctx.env, buyer.userId, "0x6666666666666666666666666666666666666666")

    const uploadedPrimaryAudio = await createCompletedSongArtifactUpload({
      env: ctx.env,
      accessToken: creator.accessToken,
      communityId: communityCreateBody.community.community_id,
      artifactKind: "primary_audio",
      mimeType: "audio/mpeg",
      filename: "locked-cdr-sdk-download.mp3",
      bytes: buildUploadBytes("locked-cdr-sdk-download-audio"),
    })
    const uploadedPreviewAudio = await createCompletedSongArtifactUpload({
      env: ctx.env,
      accessToken: creator.accessToken,
      communityId: communityCreateBody.community.community_id,
      artifactKind: "preview_audio",
      mimeType: "audio/mpeg",
      filename: "locked-cdr-sdk-download-preview.mp3",
      bytes: buildUploadBytes("locked-cdr-sdk-download-preview-audio"),
    })

    const bundleCreate = await requestJson(
      `http://pirate.test/communities/${communityCreateBody.community.community_id}/song-artifacts`,
      {
        primary_audio: {
          ...buildSongMediaRef(uploadedPrimaryAudio.storage_ref),
          size_bytes: uploadedPrimaryAudio.size_bytes ?? 1024,
          content_hash: uploadedPrimaryAudio.content_hash ?? buildSongMediaRef(uploadedPrimaryAudio.storage_ref).content_hash,
        },
        preview_audio: {
          ...buildSongMediaRef(uploadedPreviewAudio.storage_ref),
          size_bytes: uploadedPreviewAudio.size_bytes ?? 1024,
          content_hash: uploadedPreviewAudio.content_hash ?? buildSongMediaRef(uploadedPreviewAudio.storage_ref).content_hash,
        },
        lyrics: "CDR SDK backend download lyrics",
      },
      ctx.env,
      creator.accessToken,
    )
    expect(bundleCreate.status).toBe(201)
    const bundleCreateBody = await json(bundleCreate) as { song_artifact_bundle_id: string }

    const createSong = await requestJson(
      `http://pirate.test/communities/${communityCreateBody.community.community_id}/posts`,
      {
        post_type: "song",
        identity_mode: "public",
        song_mode: "original",
        rights_basis: "original",
        access_mode: "locked",
        title: "Locked CDR SDK Download Song",
        song_artifact_bundle_id: bundleCreateBody.song_artifact_bundle_id,
        idempotency_key: "post-key-song-cdr-sdk-download",
      },
      ctx.env,
      creator.accessToken,
    )
    expect(createSong.status).toBe(201)
    const createSongBody = await json(createSong) as { asset_id: string }

    const lockedDeliveryDrain = await app.request(
      "http://pirate.test/jobs/internal/song-locked-deliveries/drain?limit=1",
      {
        method: "POST",
        headers: {
          authorization: "Bearer internal-song-job-token",
        },
      },
      ctx.env,
    )
    expect(lockedDeliveryDrain.status).toBe(200)

    await setAssetCdrFields({
      communityDbRoot: ctx.communityDbRoot,
      communityId: communityCreateBody.community.community_id,
      assetId: createSongBody.asset_id,
      vaultUuid: 88,
      encryptedCid: "bafybeicdrsdkdownloadcid",
      clearLocalPayload: true,
    })

    await insertCommunityListing({
      communityDbRoot: ctx.communityDbRoot,
      communityId: communityCreateBody.community.community_id,
      listingId: "lst_cdr_sdk_download_1",
      createdByUserId: creator.userId,
      assetId: createSongBody.asset_id,
      priceUsd: "7.00",
    })

    const quoteResponse = await requestJson(
      `http://pirate.test/communities/${communityCreateBody.community.community_id}/purchase-quotes`,
      {
        listing_id: "lst_cdr_sdk_download_1",
        client_estimated_slippage_bps: 0,
        client_estimated_hop_count: 0,
      },
      ctx.env,
      buyer.accessToken,
    )
    expect(quoteResponse.status).toBe(200)
    const quoteBody = await json(quoteResponse) as { quote_id: string }

    const settlementResponse = await requestJson(
      `http://pirate.test/communities/${communityCreateBody.community.community_id}/purchase-settlements`,
      {
        quote_id: quoteBody.quote_id,
        settlement_wallet_attachment_id: `wal_${buyer.userId}`,
        settlement_tx_ref: "story:0xcdrsdkdownload1",
      },
      ctx.env,
      buyer.accessToken,
    )
    expect(settlementResponse.status).toBe(200)

    const buyerDownload = await app.request(
      `http://pirate.test/communities/${communityCreateBody.community.community_id}/assets/${createSongBody.asset_id}/download`,
      {
        headers: {
          authorization: `Bearer ${buyer.accessToken}`,
        },
      },
      ctx.env,
    )
    expect(buyerDownload.status).toBe(400)
    expect(await buyerDownload.text()).toContain("CDR manifest flow")
  })

  test("locked song buyer download fails cleanly when the configured CDR adapter read payload is invalid", async () => {
    const originalFetch = globalThis.fetch
    globalThis.fetch = (async (input, init) => {
      const url = typeof input === "string" ? input : input instanceof URL ? input.toString() : input.url
      if (url === "https://api.dev.litprotocol.com/core/v1/lit_action") {
        return new Response(JSON.stringify({
          response: JSON.stringify({
            signerAddress: "0x2125952f22ad971df5645e31a613fe42dcc42c48",
            signature: `0x${"11".repeat(32)}${"22".repeat(32)}1b`,
          }),
        }), {
          headers: { "content-type": "application/json" },
        })
      }
      if (url === "https://rpc.ankr.com/story_aeneid_testnet") {
        const body = JSON.parse(String(init?.body || "{}")) as { method?: string }
        if (body.method === "eth_call") {
          return new Response(JSON.stringify({
            result: `0x${"ab".repeat(32)}`,
          }), {
            headers: { "content-type": "application/json" },
          })
        }
      }
      if (url === "https://cdr.test/v1/locked-assets/write") {
        return new Response(JSON.stringify({
          delivery_ref: "cdr://vaults/77/assets/locked-cdr-read-invalid",
        }), {
          headers: { "content-type": "application/json" },
        })
      }
      if (url === "https://cdr.test/v1/locked-assets/read") {
        return new Response(JSON.stringify({
          recovery_payload: {},
        }), {
          headers: { "content-type": "application/json" },
        })
      }
      return originalFetch(input as never, init)
    }) as typeof globalThis.fetch

    try {
      const ctx = await createRouteTestContext({
        STORY_CDR_API_BASE_URL: "https://cdr.test",
        STORY_CDR_API_KEY: "cdr-api-key",
        LIT_CHIPOTLE_ACCESS_CONTROLLER_API_KEY: "lit-access-key",
      })
      cleanup = ctx.cleanup
      ctx.env.INTERNAL_JOB_RUNNER_TOKEN = "internal-song-job-token"

      const creator = await exchangeJwt(ctx.env, "community-song-cdr-read-invalid-creator")
      const buyer = await exchangeJwt(ctx.env, "community-song-cdr-read-invalid-buyer")
      const namespaceVerificationId = await prepareVerifiedNamespace(ctx.env, creator.accessToken, "PirateSongCdrReadInvalidRoot")

      const communityCreate = await requestJson("http://pirate.test/communities", {
        display_name: "Pirate Song CDR Invalid Read Club",
        namespace: {
          namespace_verification_id: namespaceVerificationId,
        },
      }, ctx.env, creator.accessToken)
      expect(communityCreate.status).toBe(202)
      const communityCreateBody = await json(communityCreate) as {
        community: { community_id: string }
      }

      await setPrimaryWalletAttachment(
        ctx.env,
        buyer.userId,
        "0x3333333333333333333333333333333333333333",
      )

      const uploadedPrimaryAudio = await createCompletedSongArtifactUpload({
        env: ctx.env,
        accessToken: creator.accessToken,
        communityId: communityCreateBody.community.community_id,
        artifactKind: "primary_audio",
        mimeType: "audio/mpeg",
        filename: "locked-cdr-read-invalid.mp3",
        bytes: buildUploadBytes("locked-cdr-read-invalid-audio"),
      })
      const uploadedPreviewAudio = await createCompletedSongArtifactUpload({
        env: ctx.env,
        accessToken: creator.accessToken,
        communityId: communityCreateBody.community.community_id,
        artifactKind: "preview_audio",
        mimeType: "audio/mpeg",
        filename: "locked-cdr-read-invalid-preview.mp3",
        bytes: buildUploadBytes("locked-cdr-read-invalid-preview-audio"),
      })

      const bundleCreate = await requestJson(
        `http://pirate.test/communities/${communityCreateBody.community.community_id}/song-artifacts`,
        {
          primary_audio: {
            ...buildSongMediaRef(uploadedPrimaryAudio.storage_ref),
            size_bytes: uploadedPrimaryAudio.size_bytes ?? 1024,
            content_hash: uploadedPrimaryAudio.content_hash ?? buildSongMediaRef(uploadedPrimaryAudio.storage_ref).content_hash,
          },
          preview_audio: {
            ...buildSongMediaRef(uploadedPreviewAudio.storage_ref),
            size_bytes: uploadedPreviewAudio.size_bytes ?? 1024,
            content_hash: uploadedPreviewAudio.content_hash ?? buildSongMediaRef(uploadedPreviewAudio.storage_ref).content_hash,
          },
          lyrics: "CDR invalid read lyrics",
        },
        ctx.env,
        creator.accessToken,
      )
      expect(bundleCreate.status).toBe(201)
      const bundleCreateBody = await json(bundleCreate) as { song_artifact_bundle_id: string }

      const createSong = await requestJson(
        `http://pirate.test/communities/${communityCreateBody.community.community_id}/posts`,
        {
          post_type: "song",
          identity_mode: "public",
          song_mode: "original",
          rights_basis: "original",
          access_mode: "locked",
          title: "Locked CDR Invalid Read Song",
          song_artifact_bundle_id: bundleCreateBody.song_artifact_bundle_id,
          idempotency_key: "post-key-song-cdr-read-invalid",
        },
        ctx.env,
        creator.accessToken,
      )
      expect(createSong.status).toBe(201)
      const createSongBody = await json(createSong) as { asset_id: string }

      const lockedDeliveryDrain = await app.request(
        "http://pirate.test/jobs/internal/song-locked-deliveries/drain?limit=1",
        {
          method: "POST",
          headers: {
            authorization: "Bearer internal-song-job-token",
          },
        },
        ctx.env,
      )
      expect(lockedDeliveryDrain.status).toBe(200)

      await insertCommunityListing({
        communityDbRoot: ctx.communityDbRoot,
        communityId: communityCreateBody.community.community_id,
        listingId: "lst_cdr_read_invalid_1",
        createdByUserId: creator.userId,
        assetId: createSongBody.asset_id,
        priceUsd: "7.00",
      })

      const quoteResponse = await requestJson(
        `http://pirate.test/communities/${communityCreateBody.community.community_id}/purchase-quotes`,
        {
          listing_id: "lst_cdr_read_invalid_1",
          client_estimated_slippage_bps: 0,
          client_estimated_hop_count: 0,
        },
        ctx.env,
        buyer.accessToken,
      )
      expect(quoteResponse.status).toBe(200)
      const quoteBody = await json(quoteResponse) as { quote_id: string }

      const settlementResponse = await requestJson(
        `http://pirate.test/communities/${communityCreateBody.community.community_id}/purchase-settlements`,
        {
          quote_id: quoteBody.quote_id,
          settlement_wallet_attachment_id: `wal_${buyer.userId}`,
          settlement_tx_ref: "story:0xcdrreadinvalid1",
        },
        ctx.env,
        buyer.accessToken,
      )
      expect(settlementResponse.status).toBe(200)

      const buyerDownload = await app.request(
        `http://pirate.test/communities/${communityCreateBody.community.community_id}/assets/${createSongBody.asset_id}/download`,
        {
          headers: {
            authorization: `Bearer ${buyer.accessToken}`,
          },
        },
        ctx.env,
      )
      expect(buyerDownload.status).toBe(500)
      expect(await buyerDownload.text()).toContain("story_cdr_read_content_key_missing")
    } finally {
      globalThis.fetch = originalFetch
    }
  })

  test("locked song purchase settlement executes Story settlement via Lit and unlocks buyer download", async () => {
    const originalFetch = globalThis.fetch
    let litRequestBody: Record<string, unknown> | null = null
    globalThis.fetch = (async (input, init) => {
      const url = typeof input === "string" ? input : input instanceof URL ? input.toString() : input.url
      if (url === "https://api.dev.litprotocol.com/core/v1/lit_action") {
        litRequestBody = JSON.parse(String(init?.body || "{}")) as Record<string, unknown>
        return new Response(JSON.stringify({
          response: JSON.stringify({
            signerAddress: "0xfB1E0bbE209C1B75f8E365F3055bfF4b0a24702B",
            serializedTx: "0xfeedbeef",
          }),
        }), {
          headers: { "content-type": "application/json" },
        })
      }
      if (url === "https://rpc.ankr.com/story_aeneid_testnet") {
        const body = JSON.parse(String(init?.body || "{}")) as { method?: string }
        if (body.method === "eth_call") {
          return new Response(JSON.stringify({
            result: `0x${"00".repeat(32)}`,
          }), {
            headers: { "content-type": "application/json" },
          })
        }
        if (body.method === "eth_getTransactionCount") {
          return new Response(JSON.stringify({
            result: "0x05",
          }), {
            headers: { "content-type": "application/json" },
          })
        }
        if (body.method === "eth_sendRawTransaction") {
          return new Response(JSON.stringify({
            result: "0x9999999999999999999999999999999999999999999999999999999999999999",
          }), {
            headers: { "content-type": "application/json" },
          })
        }
        if (body.method === "eth_getTransactionReceipt") {
          return new Response(JSON.stringify({
            result: {
              status: "0x1",
            },
          }), {
            headers: { "content-type": "application/json" },
          })
        }
      }

      return originalFetch(input as never, init)
    }) as typeof globalThis.fetch

    try {
      const ctx = await createRouteTestContext({
        LIT_CHIPOTLE_STORY_SETTLEMENT_API_KEY: "lit-settlement-key",
      })
      cleanup = ctx.cleanup
      ctx.env.INTERNAL_JOB_RUNNER_TOKEN = "internal-song-job-token"

      const creator = await exchangeJwt(ctx.env, "community-song-asset-story-settlement-creator")
      const buyer = await exchangeJwt(ctx.env, "community-song-asset-story-settlement-buyer")
      const namespaceVerificationId = await prepareVerifiedNamespace(ctx.env, creator.accessToken, "PirateSongAssetStorySettlement")

      const communityCreate = await requestJson("http://pirate.test/communities", {
        display_name: "Pirate Story Settlement Club",
        namespace: {
          namespace_verification_id: namespaceVerificationId,
        },
      }, ctx.env, creator.accessToken)
      expect(communityCreate.status).toBe(202)
      const communityCreateBody = await json(communityCreate) as {
        community: { community_id: string }
      }

      await setPrimaryWalletAttachment(
        ctx.env,
        creator.userId,
        "0x1111111111111111111111111111111111111111",
      )
      await setPrimaryWalletAttachment(
        ctx.env,
        buyer.userId,
        "0x2222222222222222222222222222222222222222",
      )

      const uploadedPrimaryAudio = await createCompletedSongArtifactUpload({
        env: ctx.env,
        accessToken: creator.accessToken,
        communityId: communityCreateBody.community.community_id,
        artifactKind: "primary_audio",
        mimeType: "audio/mpeg",
        filename: "story-settlement.mp3",
        bytes: buildUploadBytes("story-settlement-audio"),
      })
      const uploadedPreviewAudio = await createCompletedSongArtifactUpload({
        env: ctx.env,
        accessToken: creator.accessToken,
        communityId: communityCreateBody.community.community_id,
        artifactKind: "preview_audio",
        mimeType: "audio/mpeg",
        filename: "story-settlement-preview.mp3",
        bytes: buildUploadBytes("story-settlement-preview-audio"),
      })

      const bundleCreate = await requestJson(
        `http://pirate.test/communities/${communityCreateBody.community.community_id}/song-artifacts`,
        {
          primary_audio: {
            ...buildSongMediaRef(uploadedPrimaryAudio.storage_ref),
            size_bytes: uploadedPrimaryAudio.size_bytes ?? 1024,
            content_hash: uploadedPrimaryAudio.content_hash ?? buildSongMediaRef(uploadedPrimaryAudio.storage_ref).content_hash,
          },
          preview_audio: {
            ...buildSongMediaRef(uploadedPreviewAudio.storage_ref),
            size_bytes: uploadedPreviewAudio.size_bytes ?? 1024,
            content_hash: uploadedPreviewAudio.content_hash ?? buildSongMediaRef(uploadedPreviewAudio.storage_ref).content_hash,
          },
          lyrics: "Story settlement lyrics",
        },
        ctx.env,
        creator.accessToken,
      )
      expect(bundleCreate.status).toBe(201)
      const bundleCreateBody = await json(bundleCreate) as { song_artifact_bundle_id: string }

      const createSong = await requestJson(
        `http://pirate.test/communities/${communityCreateBody.community.community_id}/posts`,
        {
          post_type: "song",
          identity_mode: "public",
          song_mode: "original",
          rights_basis: "original",
          access_mode: "locked",
          title: "Story Settlement Song",
          song_artifact_bundle_id: bundleCreateBody.song_artifact_bundle_id,
          idempotency_key: "post-key-song-story-settlement",
        },
        ctx.env,
        creator.accessToken,
      )
      expect(createSong.status).toBe(201)
      const createSongBody = await json(createSong) as {
        asset_id: string | null
      }
      expect(createSongBody.asset_id).toMatch(/^ast_/)

      const lockedDeliveryDrain = await app.request(
        "http://pirate.test/jobs/internal/song-locked-deliveries/drain?limit=1",
        {
          method: "POST",
          headers: {
            authorization: "Bearer internal-song-job-token",
          },
        },
        ctx.env,
      )
      expect(lockedDeliveryDrain.status).toBe(200)

      const assetRow = await readAssetRow({
        communityDbRoot: ctx.communityDbRoot,
        communityId: communityCreateBody.community.community_id,
        assetId: createSongBody.asset_id!,
      })
      expect(assetRow?.locked_delivery_status).toBe("ready")
      expect(assetRow?.story_entitlement_token_id).toMatch(/^\d+$/)

      await insertCommunityListing({
        communityDbRoot: ctx.communityDbRoot,
        communityId: communityCreateBody.community.community_id,
        listingId: "lst_story_settlement_1",
        createdByUserId: creator.userId,
        assetId: createSongBody.asset_id!,
        priceUsd: "7.00",
      })

      const quoteResponse = await requestJson(
        `http://pirate.test/communities/${communityCreateBody.community.community_id}/purchase-quotes`,
        {
          listing_id: "lst_story_settlement_1",
          client_estimated_slippage_bps: 0,
          client_estimated_hop_count: 0,
          destination_settlement_amount_atomic: "7000000000000000000",
          destination_settlement_decimals: 18,
        },
        ctx.env,
        buyer.accessToken,
      )
      expect(quoteResponse.status).toBe(200)
      const quoteBody = await json(quoteResponse) as {
        quote_id: string
        destination_settlement_amount_atomic?: string | null
        destination_settlement_decimals?: number | null
      }
      expect(quoteBody.destination_settlement_amount_atomic).toBe("7000000000000000000")
      expect(quoteBody.destination_settlement_decimals).toBe(18)

      const settlementResponse = await requestJson(
        `http://pirate.test/communities/${communityCreateBody.community.community_id}/purchase-settlements`,
        {
          quote_id: quoteBody.quote_id,
          settlement_wallet_attachment_id: `wal_${buyer.userId}`,
        },
        ctx.env,
        buyer.accessToken,
      )
      expect(settlementResponse.status).toBe(200)
      const settlementBody = await json(settlementResponse) as {
        settlement_tx_ref: string
      }
      expect(settlementBody.settlement_tx_ref).toBe("0x9999999999999999999999999999999999999999999999999999999999999999")

      const buyerDownload = await app.request(
        `http://pirate.test/communities/${communityCreateBody.community.community_id}/assets/${createSongBody.asset_id}/download`,
        {
          headers: {
            authorization: `Bearer ${buyer.accessToken}`,
          },
        },
        ctx.env,
      )
      expect(buyerDownload.status).toBe(200)
      expect(new TextDecoder().decode(await buyerDownload.arrayBuffer())).toBe("story-settlement-audio")

      const typedLitRequestBody = litRequestBody as {
        code?: unknown
        js_params?: Record<string, unknown>
      } | null
      expect(typeof typedLitRequestBody?.code).toBe("string")
      expect(typedLitRequestBody?.js_params).toMatchObject({
        expectedSignerAddress: "0xfb1e0bbe209c1b75f8e365f3055bff4b0a24702b",
      })
      const unsignedTx = (typedLitRequestBody?.js_params as { unsignedTx?: Record<string, unknown> } | undefined)?.unsignedTx
      expect(unsignedTx?.to).toBe("0xFECcC2cF8C9946E1384eF5733B509ac70677c5bd")
      expect(unsignedTx?.value).toBe("7000000000000000000")
    } finally {
      globalThis.fetch = originalFetch
    }
  })

  test("locked song asset access proof issues a Lit-backed signed access package for entitled buyers", async () => {
    const originalFetch = globalThis.fetch
    let litRequestBody: Record<string, unknown> | null = null
    globalThis.fetch = (async (input, init) => {
      const url = typeof input === "string" ? input : input instanceof URL ? input.toString() : input.url
      if (url === "https://rpc.ankr.com/story_aeneid_testnet") {
        const body = JSON.parse(String(init?.body || "{}")) as { method?: string }
        if (body.method === "eth_call") {
          return new Response(JSON.stringify({
            result: `0x${"44".repeat(32)}`,
          }), {
            headers: { "content-type": "application/json" },
          })
        }
      }
      if (url === "https://api.dev.litprotocol.com/core/v1/lit_action") {
        litRequestBody = JSON.parse(String(init?.body || "{}")) as Record<string, unknown>
        return new Response(JSON.stringify({
          response: JSON.stringify({
            signerAddress: "0x2125952f22Ad971df5645E31a613fe42DCC42c48",
            signature: `0x${"11".repeat(32)}${"22".repeat(32)}1b`,
          }),
        }), {
          headers: { "content-type": "application/json" },
        })
      }

      return originalFetch(input as never, init)
    }) as typeof globalThis.fetch

    try {
      const ctx = await createRouteTestContext({
        INTERNAL_JOB_RUNNER_TOKEN: "internal-song-job-token",
        LIT_CHIPOTLE_ACCESS_CONTROLLER_API_KEY: "lit-access-key",
      })
      cleanup = ctx.cleanup

      const creator = await exchangeJwt(ctx.env, "community-song-asset-proof-creator")
      const buyer = await exchangeJwt(ctx.env, "community-song-asset-proof-buyer")
      const namespaceVerificationId = await prepareVerifiedNamespace(ctx.env, creator.accessToken, "PirateSongAssetProofLocked")

      const communityCreate = await requestJson("http://pirate.test/communities", {
        display_name: "Pirate Locked Asset Proof Club",
        namespace: {
          namespace_verification_id: namespaceVerificationId,
        },
      }, ctx.env, creator.accessToken)
      expect(communityCreate.status).toBe(202)
      const communityCreateBody = await json(communityCreate) as {
        community: { community_id: string }
      }

      const uploadedPrimaryAudio = await createCompletedSongArtifactUpload({
        env: ctx.env,
        accessToken: creator.accessToken,
        communityId: communityCreateBody.community.community_id,
        artifactKind: "primary_audio",
        mimeType: "audio/mpeg",
        filename: "locked-proof.mp3",
        bytes: buildUploadBytes("locked-proof-audio"),
      })
      const uploadedPreviewAudio = await createCompletedSongArtifactUpload({
        env: ctx.env,
        accessToken: creator.accessToken,
        communityId: communityCreateBody.community.community_id,
        artifactKind: "preview_audio",
        mimeType: "audio/mpeg",
        filename: "locked-proof-preview.mp3",
        bytes: buildUploadBytes("locked-proof-preview-audio"),
      })

      const bundleCreate = await requestJson(
        `http://pirate.test/communities/${communityCreateBody.community.community_id}/song-artifacts`,
        {
          primary_audio: {
            ...buildSongMediaRef(uploadedPrimaryAudio.storage_ref),
            size_bytes: uploadedPrimaryAudio.size_bytes ?? 1024,
            content_hash: uploadedPrimaryAudio.content_hash ?? buildSongMediaRef(uploadedPrimaryAudio.storage_ref).content_hash,
          },
          preview_audio: {
            ...buildSongMediaRef(uploadedPreviewAudio.storage_ref),
            size_bytes: uploadedPreviewAudio.size_bytes ?? 1024,
            content_hash: uploadedPreviewAudio.content_hash ?? buildSongMediaRef(uploadedPreviewAudio.storage_ref).content_hash,
          },
          lyrics: "Locked asset proof lyrics",
        },
        ctx.env,
        creator.accessToken,
      )
      expect(bundleCreate.status).toBe(201)
      const bundleCreateBody = await json(bundleCreate) as { song_artifact_bundle_id: string }

      const createSong = await requestJson(
        `http://pirate.test/communities/${communityCreateBody.community.community_id}/posts`,
        {
          post_type: "song",
          identity_mode: "public",
          song_mode: "original",
          rights_basis: "original",
          access_mode: "locked",
          title: "Locked Proof Song",
          song_artifact_bundle_id: bundleCreateBody.song_artifact_bundle_id,
          idempotency_key: "post-key-song-locked-proof",
        },
        ctx.env,
        creator.accessToken,
      )
      expect(createSong.status).toBe(201)
      const createSongBody = await json(createSong) as {
        asset_id: string | null
      }
      expect(createSongBody.asset_id).toMatch(/^ast_/)

      const deliveryDrain = await app.request(
        "http://pirate.test/jobs/internal/song-locked-deliveries/drain?limit=1",
        {
          method: "POST",
          headers: {
            authorization: "Bearer internal-song-job-token",
          },
        },
        ctx.env,
      )
      expect(deliveryDrain.status).toBe(200)

      await setPrimaryWalletAttachment(
        ctx.env,
        buyer.userId,
        "0x3333333333333333333333333333333333333333",
      )
      await insertCommunityListing({
        communityDbRoot: ctx.communityDbRoot,
        communityId: communityCreateBody.community.community_id,
        listingId: "lst_locked_proof_1",
        createdByUserId: creator.userId,
        assetId: createSongBody.asset_id!,
        priceUsd: "9.00",
      })

      const quoteResponse = await requestJson(
        `http://pirate.test/communities/${communityCreateBody.community.community_id}/purchase-quotes`,
        {
          listing_id: "lst_locked_proof_1",
          client_estimated_slippage_bps: 0,
          client_estimated_hop_count: 0,
        },
        ctx.env,
        buyer.accessToken,
      )
      expect(quoteResponse.status).toBe(200)
      const quoteBody = await json(quoteResponse) as { quote_id: string }

      const settlementResponse = await requestJson(
        `http://pirate.test/communities/${communityCreateBody.community.community_id}/purchase-settlements`,
        {
          quote_id: quoteBody.quote_id,
          settlement_wallet_attachment_id: `wal_${buyer.userId}`,
          settlement_tx_ref: "story:0xlockedproof1",
        },
        ctx.env,
        buyer.accessToken,
      )
      expect(settlementResponse.status).toBe(200)

      const proofResponse = await app.request(
        `http://pirate.test/communities/${communityCreateBody.community.community_id}/assets/${createSongBody.asset_id}/access-proof?wallet_attachment_id=wal_${buyer.userId}`,
        {
          headers: {
            authorization: `Bearer ${buyer.accessToken}`,
          },
        },
        ctx.env,
      )
      expect(proofResponse.status).toBe(200)
      const proofBody = await json(proofResponse) as {
        asset_id: string
        access_mode: string
        decision_reason: string
        wallet_attachment_id: string
        caller_address: string
        signer_family: string
        signer_address: string
        verifier_contract: string
        scope: string
        digest: string
        condition_data: string
        access_aux_data: string
        signature: string
        delivery_ref: string
        proof: {
          scope: string
          caller: string
        }
      }
      expect(proofBody.asset_id).toBe(createSongBody.asset_id)
      expect(proofBody.access_mode).toBe("locked")
      expect(proofBody.decision_reason).toBe("purchase_entitlement")
      expect(proofBody.wallet_attachment_id).toBe(`wal_${buyer.userId}`)
      expect(proofBody.caller_address).toBe("0x3333333333333333333333333333333333333333")
      expect(proofBody.signer_family).toBe("story-access-controller")
      expect(proofBody.signer_address).toBe("0x2125952f22ad971df5645e31a613fe42dcc42c48")
      expect(proofBody.verifier_contract).toBe("0x82c30cf9524ad83c8a67e6b855d9c286c89586b3")
      expect(proofBody.scope).toBe("asset.share")
      expect(proofBody.proof.scope).toBe("asset.share")
      expect(proofBody.proof.caller).toBe("0x3333333333333333333333333333333333333333")
      expect(proofBody.digest).toMatch(/^0x[a-f0-9]{64}$/)
      expect(proofBody.condition_data).toMatch(/^0x[a-f0-9]+$/)
      expect(proofBody.access_aux_data).toMatch(/^0x[a-f0-9]+$/)
      expect(proofBody.signature).toBe(`0x${"11".repeat(32)}${"22".repeat(32)}1b`)
      expect(proofBody.delivery_ref).toMatch(/^pirate-cdr:\/\//)

      const typedLitRequestBody = litRequestBody as {
        code?: unknown
        js_params?: Record<string, unknown>
      } | null
      expect(typeof typedLitRequestBody?.code).toBe("string")
      expect(typedLitRequestBody?.js_params).toMatchObject({
        expectedSignerAddress: "0x2125952f22ad971df5645e31a613fe42dcc42c48",
      })
    } finally {
      globalThis.fetch = originalFetch
    }
  })

  test("song artifact bundle create rejects invalid cover ratio, canvas ratio, and preview duration", async () => {
    const ctx = await createRouteTestContext()
    cleanup = ctx.cleanup

    const session = await exchangeJwt(ctx.env, "community-song-bundle-geometry-validation")
    const namespaceVerificationId = await prepareVerifiedNamespace(ctx.env, session.accessToken, "PirateSongBundleGeometryRoot")

    const communityCreate = await requestJson("http://pirate.test/communities", {
      display_name: "Pirate Song Geometry Club",
      namespace: {
        namespace_verification_id: namespaceVerificationId,
      },
    }, ctx.env, session.accessToken)
    expect(communityCreate.status).toBe(202)
    const communityCreateBody = await json(communityCreate) as {
      community: { community_id: string }
    }

    const uploadedPrimaryAudio = await createCompletedSongArtifactUpload({
      env: ctx.env,
      accessToken: session.accessToken,
      communityId: communityCreateBody.community.community_id,
      artifactKind: "primary_audio",
      mimeType: "audio/mpeg",
      filename: "geometry-primary.mp3",
      bytes: buildUploadBytes("geometry-primary-audio"),
    })
    const uploadedPreviewAudio = await createCompletedSongArtifactUpload({
      env: ctx.env,
      accessToken: session.accessToken,
      communityId: communityCreateBody.community.community_id,
      artifactKind: "preview_audio",
      mimeType: "audio/mpeg",
      filename: "geometry-preview.mp3",
      bytes: buildUploadBytes("geometry-preview-audio"),
    })
    const uploadedCoverArt = await createCompletedSongArtifactUpload({
      env: ctx.env,
      accessToken: session.accessToken,
      communityId: communityCreateBody.community.community_id,
      artifactKind: "cover_art",
      mimeType: "image/png",
      filename: "geometry-cover.png",
      bytes: buildUploadBytes("geometry-cover-art"),
    })
    const uploadedCanvasVideo = await createCompletedSongArtifactUpload({
      env: ctx.env,
      accessToken: session.accessToken,
      communityId: communityCreateBody.community.community_id,
      artifactKind: "canvas_video",
      mimeType: "video/mp4",
      filename: "geometry-canvas.mp4",
      bytes: buildUploadBytes("geometry-canvas-video"),
    })

    const invalidCover = await requestJson(
      `http://pirate.test/communities/${communityCreateBody.community.community_id}/song-artifacts`,
      {
        primary_audio: buildSongMediaRef(uploadedPrimaryAudio.storage_ref),
        lyrics: "Geometry validation lyrics",
        cover_art: {
          storage_ref: uploadedCoverArt.storage_ref,
          mime_type: "image/png",
          size_bytes: uploadedCoverArt.size_bytes ?? 1024,
          content_hash: uploadedCoverArt.content_hash ?? "sha256:cover",
          width: 1200,
          height: 1000,
        },
      },
      ctx.env,
      session.accessToken,
    )
    expect(invalidCover.status).toBe(400)

    const invalidCanvas = await requestJson(
      `http://pirate.test/communities/${communityCreateBody.community.community_id}/song-artifacts`,
      {
        primary_audio: buildSongMediaRef(uploadedPrimaryAudio.storage_ref),
        lyrics: "Geometry validation lyrics",
        canvas_video: {
          storage_ref: uploadedCanvasVideo.storage_ref,
          mime_type: "video/mp4",
          size_bytes: uploadedCanvasVideo.size_bytes ?? 1024,
          content_hash: uploadedCanvasVideo.content_hash ?? "sha256:canvas",
          width: 1000,
          height: 1000,
          duration_ms: 8000,
        },
      },
      ctx.env,
      session.accessToken,
    )
    expect(invalidCanvas.status).toBe(400)

    const invalidPreview = await requestJson(
      `http://pirate.test/communities/${communityCreateBody.community.community_id}/song-artifacts`,
      {
        primary_audio: buildSongMediaRef(uploadedPrimaryAudio.storage_ref),
        lyrics: "Geometry validation lyrics",
        preview_audio: buildSongMediaRef(uploadedPreviewAudio.storage_ref, {
          duration_ms: 30_001,
        }),
      },
      ctx.env,
      session.accessToken,
    )
    expect(invalidPreview.status).toBe(400)

    const invalidPreviewWindow = await requestJson(
      `http://pirate.test/communities/${communityCreateBody.community.community_id}/song-artifacts`,
      {
        primary_audio: buildSongMediaRef(uploadedPrimaryAudio.storage_ref, {
          duration_ms: 20_000,
        }),
        lyrics: "Geometry validation lyrics",
        preview_window: {
          start_ms: 10_000,
          duration_ms: 15_000,
        },
      },
      ctx.env,
      session.accessToken,
    )
    expect(invalidPreviewWindow.status).toBe(400)

    const invalidPreviewWindowCombo = await requestJson(
      `http://pirate.test/communities/${communityCreateBody.community.community_id}/song-artifacts`,
      {
        primary_audio: buildSongMediaRef(uploadedPrimaryAudio.storage_ref, {
          duration_ms: 20_000,
        }),
        lyrics: "Geometry validation lyrics",
        preview_audio: buildSongMediaRef(uploadedPreviewAudio.storage_ref, {
          duration_ms: 20_000,
        }),
        preview_window: {
          start_ms: 0,
          duration_ms: 20_000,
        },
      },
      ctx.env,
      session.accessToken,
    )
    expect(invalidPreviewWindowCombo.status).toBe(400)
  })

  test("locked song post create waits for preview drain before using a derived 30s preview window from long primary audio", async () => {
    const ctx = await createRouteTestContext({
      INTERNAL_JOB_RUNNER_TOKEN: "internal-song-job-token",
    })
    cleanup = ctx.cleanup

    const session = await exchangeJwt(ctx.env, "community-song-locked-preview-required")
    const namespaceVerificationId = await prepareVerifiedNamespace(ctx.env, session.accessToken, "PirateSongLockedPreviewRoot")

    const communityCreate = await requestJson("http://pirate.test/communities", {
      display_name: "Pirate Locked Auto Preview Club",
      namespace: {
        namespace_verification_id: namespaceVerificationId,
      },
    }, ctx.env, session.accessToken)
    expect(communityCreate.status).toBe(202)
    const communityCreateBody = await json(communityCreate) as {
      community: { community_id: string }
    }

    const uploadedPrimaryAudio = await createCompletedSongArtifactUpload({
      env: ctx.env,
      accessToken: session.accessToken,
      communityId: communityCreateBody.community.community_id,
      artifactKind: "primary_audio",
      mimeType: "audio/wav",
      filename: "locked-auto-preview.wav",
      bytes: buildWavBytes(45_000),
    })

    const bundleCreate = await requestJson(
      `http://pirate.test/communities/${communityCreateBody.community.community_id}/song-artifacts`,
      {
        primary_audio: buildSongMediaRef(uploadedPrimaryAudio.storage_ref, {
          mime_type: "audio/wav",
          duration_ms: 45_000,
        }),
        preview_window: {
          start_ms: 5_000,
          duration_ms: 30_000,
        },
        lyrics: "Locked auto preview lyrics",
      },
      ctx.env,
      session.accessToken,
    )
    expect(bundleCreate.status).toBe(201)
    const bundleCreateBody = await json(bundleCreate) as { song_artifact_bundle_id: string; preview_status: string }
    expect(bundleCreateBody.preview_status).toBe("pending")

    const createSongBeforePreview = await requestJson(
      `http://pirate.test/communities/${communityCreateBody.community.community_id}/posts`,
      {
        post_type: "song",
        identity_mode: "public",
        song_mode: "original",
        rights_basis: "original",
        access_mode: "locked",
        title: "Locked Auto Preview Song",
        song_artifact_bundle_id: bundleCreateBody.song_artifact_bundle_id,
        idempotency_key: "post-key-song-locked-auto-preview",
      },
      ctx.env,
      session.accessToken,
    )
    expect(createSongBeforePreview.status).toBe(400)
    const createSongBeforePreviewBody = await json(createSongBeforePreview) as { message: string }
    expect(createSongBeforePreviewBody.message).toBe("locked song preview is not ready")

    const previewDrain = await app.request(
      "http://pirate.test/jobs/internal/song-previews/drain?limit=1",
      {
        method: "POST",
        headers: {
          authorization: "Bearer internal-song-job-token",
        },
      },
      ctx.env,
    )
    expect(previewDrain.status).toBe(200)
    const previewDrainBody = await json(previewDrain) as {
      claimed_count: number
      preview_completed_count: number
      preview_failed_count: number
    }
    expect(previewDrainBody.claimed_count).toBe(1)
    expect(previewDrainBody.preview_completed_count).toBe(1)
    expect(previewDrainBody.preview_failed_count).toBe(0)

    const createSong = await requestJson(
      `http://pirate.test/communities/${communityCreateBody.community.community_id}/posts`,
      {
        post_type: "song",
        identity_mode: "public",
        song_mode: "original",
        rights_basis: "original",
        access_mode: "locked",
        title: "Locked Auto Preview Song",
        song_artifact_bundle_id: bundleCreateBody.song_artifact_bundle_id,
        idempotency_key: "post-key-song-locked-auto-preview",
      },
      ctx.env,
      session.accessToken,
    )
    expect(createSong.status).toBe(201)
    const createSongBody = await json(createSong) as {
      asset_id: string | null
      media_refs?: Array<{ storage_ref: string; clip_start_ms?: number | null; clip_duration_ms?: number | null }>
    }
    expect(createSongBody.asset_id).toMatch(/^ast_/)
    expect(createSongBody.media_refs?.[0]?.storage_ref).not.toBe(uploadedPrimaryAudio.storage_ref)
    expect(createSongBody.media_refs?.[0]?.storage_ref).toMatch(/^ipfs:\/\/local-song-artifact-upload\//)
    expect(createSongBody.media_refs?.[0]?.clip_start_ms).toBe(5_000)
    expect(createSongBody.media_refs?.[0]?.clip_duration_ms).toBe(30_000)

    const readAsset = await app.request(
      `http://pirate.test/communities/${communityCreateBody.community.community_id}/assets/${createSongBody.asset_id}`,
      {
        headers: {
          authorization: `Bearer ${session.accessToken}`,
        },
      },
      ctx.env,
    )
    expect(readAsset.status).toBe(200)
    const readAssetBody = await json(readAsset) as {
      preview_audio: { storage_ref: string; clip_start_ms?: number | null; clip_duration_ms?: number | null } | null
    }
    expect(readAssetBody.preview_audio?.storage_ref).not.toBe(uploadedPrimaryAudio.storage_ref)
    expect(readAssetBody.preview_audio?.storage_ref).toMatch(/^ipfs:\/\/local-song-artifact-upload\//)
    expect(readAssetBody.preview_audio?.clip_start_ms).toBe(5_000)
    expect(readAssetBody.preview_audio?.clip_duration_ms).toBe(30_000)
  })

  test("locked song post create waits for preview drain before deriving a separate preview file from short primary audio", async () => {
    const ctx = await createRouteTestContext({
      INTERNAL_JOB_RUNNER_TOKEN: "internal-song-job-token",
    })
    cleanup = ctx.cleanup

    const session = await exchangeJwt(ctx.env, "community-song-locked-short-primary-preview")
    const namespaceVerificationId = await prepareVerifiedNamespace(ctx.env, session.accessToken, "PirateSongLockedShortPreviewRoot")

    const communityCreate = await requestJson("http://pirate.test/communities", {
      display_name: "Pirate Locked Short Song Club",
      namespace: {
        namespace_verification_id: namespaceVerificationId,
      },
    }, ctx.env, session.accessToken)
    expect(communityCreate.status).toBe(202)
    const communityCreateBody = await json(communityCreate) as {
      community: { community_id: string }
    }

    const uploadedPrimaryAudio = await createCompletedSongArtifactUpload({
      env: ctx.env,
      accessToken: session.accessToken,
      communityId: communityCreateBody.community.community_id,
      artifactKind: "primary_audio",
      mimeType: "audio/wav",
      filename: "locked-short-primary.wav",
      bytes: buildWavBytes(25_000),
    })

    const bundleCreate = await requestJson(
      `http://pirate.test/communities/${communityCreateBody.community.community_id}/song-artifacts`,
      {
        primary_audio: buildSongMediaRef(uploadedPrimaryAudio.storage_ref, {
          mime_type: "audio/wav",
          duration_ms: 25_000,
        }),
        lyrics: "Locked short primary preview lyrics",
      },
      ctx.env,
      session.accessToken,
    )
    expect(bundleCreate.status).toBe(201)
    const bundleCreateBody = await json(bundleCreate) as { song_artifact_bundle_id: string; preview_status: string }
    expect(bundleCreateBody.preview_status).toBe("pending")

    const createSongBeforePreview = await requestJson(
      `http://pirate.test/communities/${communityCreateBody.community.community_id}/posts`,
      {
        post_type: "song",
        identity_mode: "public",
        song_mode: "original",
        rights_basis: "original",
        access_mode: "locked",
        title: "Locked Short Primary Song",
        song_artifact_bundle_id: bundleCreateBody.song_artifact_bundle_id,
        idempotency_key: "post-key-song-locked-short-primary-preview",
      },
      ctx.env,
      session.accessToken,
    )
    expect(createSongBeforePreview.status).toBe(400)

    const previewDrain = await app.request(
      "http://pirate.test/jobs/internal/song-previews/drain?limit=1",
      {
        method: "POST",
        headers: {
          authorization: "Bearer internal-song-job-token",
        },
      },
      ctx.env,
    )
    expect(previewDrain.status).toBe(200)

    const createSong = await requestJson(
      `http://pirate.test/communities/${communityCreateBody.community.community_id}/posts`,
      {
        post_type: "song",
        identity_mode: "public",
        song_mode: "original",
        rights_basis: "original",
        access_mode: "locked",
        title: "Locked Short Primary Song",
        song_artifact_bundle_id: bundleCreateBody.song_artifact_bundle_id,
        idempotency_key: "post-key-song-locked-short-primary-preview",
      },
      ctx.env,
      session.accessToken,
    )
    expect(createSong.status).toBe(201)
    const createSongBody = await json(createSong) as {
      asset_id: string | null
      media_refs?: Array<{ storage_ref: string; clip_start_ms?: number | null; clip_duration_ms?: number | null }>
    }
    expect(createSongBody.asset_id).toMatch(/^ast_/)
    expect(createSongBody.media_refs?.[0]?.storage_ref).not.toBe(uploadedPrimaryAudio.storage_ref)
    expect(createSongBody.media_refs?.[0]?.storage_ref).toMatch(/^ipfs:\/\/local-song-artifact-upload\//)
    expect(createSongBody.media_refs?.[0]?.clip_start_ms).toBe(0)
    expect(createSongBody.media_refs?.[0]?.clip_duration_ms).toBe(25_000)

    const readAsset = await app.request(
      `http://pirate.test/communities/${communityCreateBody.community.community_id}/assets/${createSongBody.asset_id}`,
      {
        headers: {
          authorization: `Bearer ${session.accessToken}`,
        },
      },
      ctx.env,
    )
    expect(readAsset.status).toBe(200)
    const readAssetBody = await json(readAsset) as {
      preview_audio: { storage_ref: string; clip_start_ms?: number | null; clip_duration_ms?: number | null } | null
    }
    expect(readAssetBody.preview_audio?.storage_ref).not.toBe(uploadedPrimaryAudio.storage_ref)
    expect(readAssetBody.preview_audio?.storage_ref).toMatch(/^ipfs:\/\/local-song-artifact-upload\//)
    expect(readAssetBody.preview_audio?.clip_start_ms).toBe(0)
    expect(readAssetBody.preview_audio?.clip_duration_ms).toBe(25_000)
  })

  test("locked song post create rejects bundles without preview audio when primary duration is missing", async () => {
    const ctx = await createRouteTestContext()
    cleanup = ctx.cleanup

    const session = await exchangeJwt(ctx.env, "community-song-locked-missing-duration-preview")
    const namespaceVerificationId = await prepareVerifiedNamespace(ctx.env, session.accessToken, "PirateSongLockedMissingDurationRoot")

    const communityCreate = await requestJson("http://pirate.test/communities", {
      display_name: "Pirate Locked Missing Duration Club",
      namespace: {
        namespace_verification_id: namespaceVerificationId,
      },
    }, ctx.env, session.accessToken)
    expect(communityCreate.status).toBe(202)
    const communityCreateBody = await json(communityCreate) as {
      community: { community_id: string }
    }

    const uploadedPrimaryAudio = await createCompletedSongArtifactUpload({
      env: ctx.env,
      accessToken: session.accessToken,
      communityId: communityCreateBody.community.community_id,
      artifactKind: "primary_audio",
      mimeType: "audio/mpeg",
      filename: "locked-missing-duration.mp3",
      bytes: buildUploadBytes("locked-missing-duration-audio"),
    })

    const bundleCreate = await requestJson(
      `http://pirate.test/communities/${communityCreateBody.community.community_id}/song-artifacts`,
      {
        primary_audio: buildSongMediaRef(uploadedPrimaryAudio.storage_ref, {
          duration_ms: null,
        }),
        lyrics: "Locked missing duration lyrics",
      },
      ctx.env,
      session.accessToken,
    )
    expect(bundleCreate.status).toBe(201)
    const bundleCreateBody = await json(bundleCreate) as { song_artifact_bundle_id: string }

    const createSong = await requestJson(
      `http://pirate.test/communities/${communityCreateBody.community.community_id}/posts`,
      {
        post_type: "song",
        identity_mode: "public",
        song_mode: "original",
        rights_basis: "original",
        access_mode: "locked",
        title: "Locked Missing Duration Song",
        song_artifact_bundle_id: bundleCreateBody.song_artifact_bundle_id,
        idempotency_key: "post-key-song-locked-missing-duration-preview",
      },
      ctx.env,
      session.accessToken,
    )
    expect(createSong.status).toBe(400)
  })

  test("song artifact upload create and content upload persist canonical metadata", async () => {
    const ctx = await createRouteTestContext()
    cleanup = ctx.cleanup

    const session = await exchangeJwt(ctx.env, "community-song-artifact-upload")
    const namespaceVerificationId = await prepareVerifiedNamespace(ctx.env, session.accessToken)

    const communityCreate = await requestJson("http://pirate.test/communities", {
      display_name: "Pirate Song Upload Club",
      namespace: {
        namespace_verification_id: namespaceVerificationId,
      },
    }, ctx.env, session.accessToken)
    expect(communityCreate.status).toBe(202)
    const communityCreateBody = await json(communityCreate) as {
      community: { community_id: string }
    }

    const bytes = buildUploadBytes("song-artifact-upload-primary-audio")
    const upload = await createCompletedSongArtifactUpload({
      env: ctx.env,
      accessToken: session.accessToken,
      communityId: communityCreateBody.community.community_id,
      artifactKind: "primary_audio",
      mimeType: "audio/mpeg",
      filename: "primary-audio.mp3",
      bytes,
    })

    expect(upload.community_id).toBe(communityCreateBody.community.community_id)
    expect(upload.uploader_user_id).toBe(session.userId)
    expect(upload.artifact_kind).toBe("primary_audio")
    expect(upload.storage_ref).toMatch(new RegExp(upload.song_artifact_upload_id))
    expect(upload.storage_provider).toBe("local_stub")
    expect(upload.storage_bucket).toBeNull()
    expect(upload.storage_object_key).toBeNull()
    expect(upload.storage_endpoint).toBeNull()
    expect(upload.gateway_url).toBeNull()
    expect(upload.upload_url).toBe(`/communities/${communityCreateBody.community.community_id}/song-artifact-uploads/${upload.song_artifact_upload_id}/content`)
  })

  test("song artifact bundle create and read persist normalized bundle fields", async () => {
    const ctx = await createRouteTestContext()
    cleanup = ctx.cleanup

    const session = await exchangeJwt(ctx.env, "community-song-artifact-bundle")
    const namespaceVerificationId = await prepareVerifiedNamespace(ctx.env, session.accessToken)

    const communityCreate = await requestJson("http://pirate.test/communities", {
      display_name: "Pirate Song Bundle Club",
      namespace: {
        namespace_verification_id: namespaceVerificationId,
      },
    }, ctx.env, session.accessToken)
    expect(communityCreate.status).toBe(202)
    const communityCreateBody = await json(communityCreate) as {
      community: { community_id: string }
    }

    const lyrics = "Sailing on a registered audio plus lyrics bundle."
    const uploadedPrimaryAudio = await createCompletedSongArtifactUpload({
      env: ctx.env,
      accessToken: session.accessToken,
      communityId: communityCreateBody.community.community_id,
      artifactKind: "primary_audio",
      mimeType: "audio/mpeg",
      filename: "bundle-primary-audio.mp3",
      bytes: buildUploadBytes("song-artifact-bundle-primary-audio"),
    })
    const uploadedCoverArt = await createCompletedSongArtifactUpload({
      env: ctx.env,
      accessToken: session.accessToken,
      communityId: communityCreateBody.community.community_id,
      artifactKind: "cover_art",
      mimeType: "image/png",
      filename: "bundle-cover-art.png",
      bytes: buildUploadBytes("song-artifact-bundle-cover-art"),
    })
    const bundleCreate = await requestJson(
      `http://pirate.test/communities/${communityCreateBody.community.community_id}/song-artifacts`,
      {
        primary_audio: {
          ...buildSongMediaRef(uploadedPrimaryAudio.storage_ref),
          size_bytes: uploadedPrimaryAudio.size_bytes ?? 1024,
          content_hash: uploadedPrimaryAudio.content_hash ?? buildSongMediaRef(uploadedPrimaryAudio.storage_ref).content_hash,
        },
        lyrics,
        cover_art: {
          storage_ref: uploadedCoverArt.storage_ref,
          mime_type: "image/png",
          size_bytes: uploadedCoverArt.size_bytes ?? 2048,
          content_hash: uploadedCoverArt.content_hash ?? "sha256:song-artifact-bundle-cover",
          width: 1000,
          height: 1000,
        },
      },
      ctx.env,
      session.accessToken,
    )

    expect(bundleCreate.status).toBe(201)
    const bundleCreateBody = await json(bundleCreate) as {
      song_artifact_bundle_id: string
      community_id: string
      creator_user_id: string
      status: string
      lyrics: string
      lyrics_sha256: string
      media_refs: Array<{ storage_ref: string }>
      primary_audio: { storage_ref: string }
      cover_art: { storage_ref: string } | null
      preview_status: string
      translation_status: string
      alignment_status: string
      moderation_status: string
    }
    expect(bundleCreateBody.community_id).toBe(communityCreateBody.community.community_id)
    expect(bundleCreateBody.creator_user_id).toBe(session.userId)
    expect(bundleCreateBody.status).toBe("ready")
    expect(bundleCreateBody.lyrics).toBe(lyrics)
    expect(bundleCreateBody.lyrics_sha256).toBe(`0x${createHash("sha256").update(lyrics).digest("hex")}`)
    expect(bundleCreateBody.primary_audio.storage_ref).toBe(uploadedPrimaryAudio.storage_ref)
    expect(bundleCreateBody.media_refs[0]?.storage_ref).toBe(uploadedPrimaryAudio.storage_ref)
    expect(bundleCreateBody.cover_art?.storage_ref).toBe(uploadedCoverArt.storage_ref)
    expect(bundleCreateBody.preview_status).toBe("pending")
    expect(bundleCreateBody.translation_status).toBe("pending")
    expect(bundleCreateBody.alignment_status).toBe("pending")
    expect(bundleCreateBody.moderation_status).toBe("pending")

    const bundleRead = await app.request(
      `http://pirate.test/communities/${communityCreateBody.community.community_id}/song-artifacts/${bundleCreateBody.song_artifact_bundle_id}`,
      {
        headers: {
          authorization: `Bearer ${session.accessToken}`,
        },
      },
      ctx.env,
    )
    expect(bundleRead.status).toBe(200)
    const bundleReadBody = await json(bundleRead) as {
      song_artifact_bundle_id: string
      status: string
      lyrics: string
      lyrics_sha256: string
      primary_audio: { storage_ref: string }
      media_refs: Array<{ storage_ref: string }>
      preview_status: string
      translation_status: string
      alignment_status: string
      moderation_status: string
    }
    expect(bundleReadBody.song_artifact_bundle_id).toBe(bundleCreateBody.song_artifact_bundle_id)
    expect(bundleReadBody.status).toBe("ready")
    expect(bundleReadBody.lyrics).toBe(lyrics)
    expect(bundleReadBody.lyrics_sha256).toBe(bundleCreateBody.lyrics_sha256)
    expect(bundleReadBody.primary_audio.storage_ref).toBe(uploadedPrimaryAudio.storage_ref)
    expect(bundleReadBody.media_refs[0]?.storage_ref).toBe(uploadedPrimaryAudio.storage_ref)
    expect(bundleReadBody.preview_status).toBe("pending")
    expect(bundleReadBody.translation_status).toBe("pending")
    expect(bundleReadBody.alignment_status).toBe("pending")
    expect(bundleReadBody.moderation_status).toBe("pending")
  })

  test("song artifact bundle create returns 400 when primary_audio mime type is invalid", async () => {
    const ctx = await createRouteTestContext()
    cleanup = ctx.cleanup

    const session = await exchangeJwt(ctx.env, "community-song-artifact-invalid-mime")
    const namespaceVerificationId = await prepareVerifiedNamespace(ctx.env, session.accessToken)

    const communityCreate = await requestJson("http://pirate.test/communities", {
      display_name: "Pirate Song Bundle Validation Club",
      namespace: {
        namespace_verification_id: namespaceVerificationId,
      },
    }, ctx.env, session.accessToken)
    expect(communityCreate.status).toBe(202)
    const communityCreateBody = await json(communityCreate) as {
      community: { community_id: string }
    }

    const bundleCreate = await requestJson(
      `http://pirate.test/communities/${communityCreateBody.community.community_id}/song-artifacts`,
      {
        primary_audio: {
          storage_ref: "ipfs://song-artifact-invalid-primary",
          mime_type: "image/png",
        },
        lyrics: "Invalid mime type should fail.",
      },
      ctx.env,
      session.accessToken,
    )

    expect(bundleCreate.status).toBe(400)
    const deniedBody = await json(bundleCreate) as { code: string; message: string }
    expect(deniedBody.code).toBe("bad_request")
    expect(deniedBody.message).toBe("primary_audio.mime_type must be audio/*")
  }, 10_000)

  test("song post create returns 400 when artifact bundle is still draft", async () => {
    const ctx = await createRouteTestContext()
    cleanup = ctx.cleanup

    const session = await exchangeJwt(ctx.env, "community-song-draft-bundle-validation")
    const namespaceVerificationId = await prepareVerifiedNamespace(ctx.env, session.accessToken)

    const communityCreate = await requestJson("http://pirate.test/communities", {
      display_name: "Pirate Song Draft Bundle Club",
      namespace: {
        namespace_verification_id: namespaceVerificationId,
      },
    }, ctx.env, session.accessToken)
    expect(communityCreate.status).toBe(202)
    const communityCreateBody = await json(communityCreate) as {
      community: { community_id: string }
    }

    const bundleRepository = getControlPlaneSongArtifactBundleRepository(ctx.env)
    const lyrics = "This bundle has not reached ready yet."
    const draftBundle = await bundleRepository.createSongArtifactBundle({
      communityId: communityCreateBody.community.community_id,
      creatorUserId: session.userId,
      body: {
        primary_audio: buildSongMediaRef("ipfs://song-draft-bundle-audio"),
        lyrics,
      },
      lyricsSha256: `0x${createHash("sha256").update(lyrics).digest("hex")}`,
      createdAt: new Date().toISOString(),
    })
    expect(draftBundle.status).toBe("draft")

    const deniedPost = await requestJson(
      `http://pirate.test/communities/${communityCreateBody.community.community_id}/posts`,
      {
        post_type: "song",
        identity_mode: "public",
        song_mode: "original",
        rights_basis: "original",
        title: "Draft Bundle Song",
        song_artifact_bundle_id: draftBundle.song_artifact_bundle_id,
        idempotency_key: "post-key-song-draft-bundle",
      },
      ctx.env,
      session.accessToken,
    )

    expect(deniedPost.status).toBe(400)
    const deniedBody = await json(deniedPost) as { code: string; message: string }
    expect(deniedBody.code).toBe("bad_request")
    expect(deniedBody.message).toBe("Song artifact bundle is not ready")
  })

  test("song post ACR match is held until upstream refs are attached, then publishes and consumes the bundle", async () => {
    const ctx = await createRouteTestContext({
      ACRCLOUD_ENABLED: "1",
      ACR_ACCESS_KEY: "test-access-key",
      ACR_SECRET_KEY: "test-secret-key",
    })
    cleanup = ctx.cleanup

    const session = await exchangeJwt(ctx.env, "community-song-acr-held-attach")
    const namespaceVerificationId = await prepareVerifiedNamespace(ctx.env, session.accessToken, "PirateSongAcrAttachRoot")

    const communityCreate = await requestJson("http://pirate.test/communities", {
      display_name: "Pirate Song ACR Attach Club",
      namespace: {
        namespace_verification_id: namespaceVerificationId,
      },
    }, ctx.env, session.accessToken)
    expect(communityCreate.status).toBe(202)
    const communityCreateBody = await json(communityCreate) as {
      community: { community_id: string }
    }

    const bundleRepository = getControlPlaneSongArtifactBundleRepository(ctx.env)

    await withMockedAcrcloudIdentify([
      {
        status: { code: 0 },
        metadata: {},
      },
      {
        status: { code: 0 },
        metadata: {
          music: [
            {
              title: "Matched Track",
              artists: [{ name: "Pirate Rights Holder" }],
            },
          ],
        },
      },
    ], async () => {
      const uploadedUpstreamAudio = await createCompletedSongArtifactUpload({
        env: ctx.env,
        accessToken: session.accessToken,
        communityId: communityCreateBody.community.community_id,
        artifactKind: "primary_audio",
        mimeType: "audio/mpeg",
        filename: "upstream.mp3",
        bytes: buildUploadBytes("upstream-audio"),
      })

      const upstreamBundleCreate = await requestJson(
        `http://pirate.test/communities/${communityCreateBody.community.community_id}/song-artifacts`,
        {
          primary_audio: {
            ...buildSongMediaRef(uploadedUpstreamAudio.storage_ref),
            size_bytes: uploadedUpstreamAudio.size_bytes ?? 1024,
            content_hash: uploadedUpstreamAudio.content_hash,
          },
          lyrics: "Upstream rights holder lyrics",
        },
        ctx.env,
        session.accessToken,
      )
      expect(upstreamBundleCreate.status).toBe(201)
      const upstreamBundleBody = await json(upstreamBundleCreate) as { song_artifact_bundle_id: string }

      const upstreamPostCreate = await requestJson(
        `http://pirate.test/communities/${communityCreateBody.community.community_id}/posts`,
        {
          post_type: "song",
          identity_mode: "public",
          song_mode: "original",
          rights_basis: "original",
          title: "Upstream Original Song",
          song_artifact_bundle_id: upstreamBundleBody.song_artifact_bundle_id,
          idempotency_key: "post-key-upstream-original-song",
        },
        ctx.env,
        session.accessToken,
      )
      expect(upstreamPostCreate.status).toBe(201)
      const upstreamPostBody = await json(upstreamPostCreate) as { asset_id: string | null }
      expect(upstreamPostBody.asset_id).toMatch(/^ast_/)

      const uploadedHeldAudio = await createCompletedSongArtifactUpload({
        env: ctx.env,
        accessToken: session.accessToken,
        communityId: communityCreateBody.community.community_id,
        artifactKind: "primary_audio",
        mimeType: "audio/mpeg",
        filename: "held.mp3",
        bytes: buildUploadBytes("held-audio"),
      })

      const heldBundleCreate = await requestJson(
        `http://pirate.test/communities/${communityCreateBody.community.community_id}/song-artifacts`,
        {
          primary_audio: {
            ...buildSongMediaRef(uploadedHeldAudio.storage_ref),
            size_bytes: uploadedHeldAudio.size_bytes ?? 1024,
            content_hash: uploadedHeldAudio.content_hash,
          },
          lyrics: "Held derivative lyrics",
        },
        ctx.env,
        session.accessToken,
      )
      expect(heldBundleCreate.status).toBe(201)
      const heldBundleBody = await json(heldBundleCreate) as { song_artifact_bundle_id: string }

      const heldPostCreate = await requestJson(
        `http://pirate.test/communities/${communityCreateBody.community.community_id}/posts`,
        {
          post_type: "song",
          identity_mode: "public",
          song_mode: "original",
          rights_basis: "original",
          title: "Held Match Song",
          song_artifact_bundle_id: heldBundleBody.song_artifact_bundle_id,
          idempotency_key: "post-key-held-match-song",
        },
        ctx.env,
        session.accessToken,
      )
      expect(heldPostCreate.status).toBe(202)
      const heldPostBody = await json(heldPostCreate) as {
        post_id: string
        asset_id: string | null
        status: string
        analysis_state: string
        analysis_result_ref: string | null
      }
      expect(heldPostBody.status).toBe("draft")
      expect(heldPostBody.analysis_state).toBe("allow_with_required_reference")
      expect(heldPostBody.asset_id).toMatch(/^ast_/)
      expect(heldPostBody.analysis_result_ref).toMatch(/^mar_/)

      const heldBundleBeforeAttach = await bundleRepository.getSongArtifactBundleById(heldBundleBody.song_artifact_bundle_id)
      expect(heldBundleBeforeAttach?.status).toBe("consuming")

      const attachResponse = await requestJson(
        `http://pirate.test/communities/${communityCreateBody.community.community_id}/posts/${heldPostBody.post_id}/upstream-refs`,
        {
          upstream_asset_refs: [upstreamPostBody.asset_id],
        },
        ctx.env,
        session.accessToken,
        "PATCH",
      )
      expect(attachResponse.status).toBe(200)
      const attachedBody = await json(attachResponse) as {
        post_id: string
        asset_id: string | null
        status: string
        analysis_state: string
      }
      expect(attachedBody.post_id).toBe(heldPostBody.post_id)
      expect(attachedBody.status).toBe("published")
      expect(attachedBody.analysis_state).toBe("allow")

      const heldBundleAfterAttach = await bundleRepository.getSongArtifactBundleById(heldBundleBody.song_artifact_bundle_id)
      expect(heldBundleAfterAttach?.status).toBe("consumed")

      const heldAsset = await readAssetRow({
        communityDbRoot: ctx.communityDbRoot,
        communityId: communityCreateBody.community.community_id,
        assetId: heldPostBody.asset_id!,
      })
      expect(heldAsset?.rights_basis).toBe("derivative")

      const analysisRow = await readMediaAnalysisRow({
        communityDbRoot: ctx.communityDbRoot,
        communityId: communityCreateBody.community.community_id,
        analysisResultId: heldPostBody.analysis_result_ref!,
      })
      expect(analysisRow?.outcome).toBe("allow")
      expect(analysisRow?.acrcloud_music_match_json).toMatch(/Matched Track/)
      expect(analysisRow?.resolved_at == null).toBe(false)

      const derivativeLinkCount = await countDerivativeLinks({
        communityDbRoot: ctx.communityDbRoot,
        communityId: communityCreateBody.community.community_id,
        assetId: heldPostBody.asset_id!,
      })
      expect(derivativeLinkCount).toBe(1)
    })
  })

  test("abandoning a held publish draft deletes the draft and releases the bundle back to ready", async () => {
    const ctx = await createRouteTestContext({
      ACRCLOUD_ENABLED: "1",
      ACR_ACCESS_KEY: "test-access-key",
      ACR_SECRET_KEY: "test-secret-key",
    })
    cleanup = ctx.cleanup

    const session = await exchangeJwt(ctx.env, "community-song-acr-held-abandon")
    const namespaceVerificationId = await prepareVerifiedNamespace(ctx.env, session.accessToken, "PirateSongAcrAbandonRoot")

    const communityCreate = await requestJson("http://pirate.test/communities", {
      display_name: "Pirate Song ACR Abandon Club",
      namespace: {
        namespace_verification_id: namespaceVerificationId,
      },
    }, ctx.env, session.accessToken)
    expect(communityCreate.status).toBe(202)
    const communityCreateBody = await json(communityCreate) as {
      community: { community_id: string }
    }

    const uploadedHeldAudio = await createCompletedSongArtifactUpload({
      env: ctx.env,
      accessToken: session.accessToken,
      communityId: communityCreateBody.community.community_id,
      artifactKind: "primary_audio",
      mimeType: "audio/mpeg",
      filename: "held-abandon.mp3",
      bytes: buildUploadBytes("held-abandon-audio"),
    })

    const heldBundleCreate = await requestJson(
      `http://pirate.test/communities/${communityCreateBody.community.community_id}/song-artifacts`,
      {
        primary_audio: {
          ...buildSongMediaRef(uploadedHeldAudio.storage_ref),
          size_bytes: uploadedHeldAudio.size_bytes ?? 1024,
          content_hash: uploadedHeldAudio.content_hash,
        },
        lyrics: "Held derivative lyrics for abandon",
      },
      ctx.env,
      session.accessToken,
    )
    expect(heldBundleCreate.status).toBe(201)
    const heldBundleBody = await json(heldBundleCreate) as { song_artifact_bundle_id: string }

    const bundleRepository = getControlPlaneSongArtifactBundleRepository(ctx.env)

    await withMockedAcrcloudIdentify([
      {
        status: { code: 0 },
        metadata: {
          music: [{ title: "Held Draft Match" }],
        },
      },
    ], async () => {
      const heldPostCreate = await requestJson(
        `http://pirate.test/communities/${communityCreateBody.community.community_id}/posts`,
        {
          post_type: "song",
          identity_mode: "public",
          song_mode: "original",
          rights_basis: "original",
          title: "Held Match Song To Abandon",
          song_artifact_bundle_id: heldBundleBody.song_artifact_bundle_id,
          idempotency_key: "post-key-held-match-song-abandon",
        },
        ctx.env,
        session.accessToken,
      )
      expect(heldPostCreate.status).toBe(202)
      const heldPostBody = await json(heldPostCreate) as {
        post_id: string
        asset_id: string | null
        status: string
      }
      expect(heldPostBody.status).toBe("draft")

      expect(await readProjectionStatus({ client: ctx.client, postId: heldPostBody.post_id })).toBe("draft")
      expect((await bundleRepository.getSongArtifactBundleById(heldBundleBody.song_artifact_bundle_id))?.status).toBe("consuming")

      const abandonResponse = await app.request(
        `http://pirate.test/communities/${communityCreateBody.community.community_id}/posts/${heldPostBody.post_id}/publish-hold`,
        {
          method: "DELETE",
          headers: {
            authorization: `Bearer ${session.accessToken}`,
          },
        },
        ctx.env,
      )
      expect(abandonResponse.status).toBe(204)

      expect((await bundleRepository.getSongArtifactBundleById(heldBundleBody.song_artifact_bundle_id))?.status).toBe("ready")
      expect(await readProjectionStatus({ client: ctx.client, postId: heldPostBody.post_id })).toBeNull()

      const readDeletedPost = await app.request(
        `http://pirate.test/posts/${heldPostBody.post_id}`,
        {
          headers: {
            authorization: `Bearer ${session.accessToken}`,
          },
        },
        ctx.env,
      )
      expect(readDeletedPost.status).toBe(404)

      const deletedAsset = await readAssetRow({
        communityDbRoot: ctx.communityDbRoot,
        communityId: communityCreateBody.community.community_id,
        assetId: heldPostBody.asset_id!,
      })
      expect(deletedAsset).toBeNull()
    })
  })

  test("createRightsReviewCase is idempotent for the same open ACR trigger", async () => {
    const ctx = await createRouteTestContext()
    cleanup = ctx.cleanup

    const session = await exchangeJwt(ctx.env, "community-rights-review-idempotent")
    const namespaceVerificationId = await prepareVerifiedNamespace(ctx.env, session.accessToken, "PirateRightsReviewIdempotentRoot")

    const communityCreate = await requestJson("http://pirate.test/communities", {
      display_name: "Pirate Rights Review Idempotent Club",
      namespace: {
        namespace_verification_id: namespaceVerificationId,
      },
    }, ctx.env, session.accessToken)
    expect(communityCreate.status).toBe(202)
    const communityCreateBody = await json(communityCreate) as {
      community: { community_id: string }
    }

    const client = createClient({
      url: buildLocalCommunityDbUrl(ctx.communityDbRoot, communityCreateBody.community.community_id),
    })
    try {
      const firstId = await createRightsReviewCase({
        client,
        communityId: communityCreateBody.community.community_id,
        subjectType: "asset",
        subjectId: "ast_idempotent_1",
        triggerSource: "acrcloud_match",
        analysisResultRef: "mar_idempotent_1",
        createdAt: new Date().toISOString(),
      })
      const secondId = await createRightsReviewCase({
        client,
        communityId: communityCreateBody.community.community_id,
        subjectType: "asset",
        subjectId: "ast_idempotent_1",
        triggerSource: "acrcloud_match",
        analysisResultRef: "mar_idempotent_1",
        createdAt: new Date().toISOString(),
      })

      expect(secondId).toBe(firstId)
      expect(await countRightsReviewCases({
        communityDbRoot: ctx.communityDbRoot,
        communityId: communityCreateBody.community.community_id,
        subjectId: "ast_idempotent_1",
      })).toBe(1)
    } finally {
      client.close()
    }
  })

  test("community create returns 400 for missing required fields", async () => {
    const ctx = await createRouteTestContext()
    cleanup = ctx.cleanup

    const session = await exchangeJwt(ctx.env, "community-invalid-create")

    const response = await requestJson("http://pirate.test/communities", {
      display_name: "",
      governance_mode: "multisig",
      namespace: {},
    }, ctx.env, session.accessToken)

    expect(response.status).toBe(400)
    const body = await json(response) as { code: string }
    expect(body.code).toBe("bad_request")
  })

  test("post create returns 400 when community_id is repeated in the body", async () => {
    const ctx = await createRouteTestContext()
    cleanup = ctx.cleanup

    const session = await exchangeJwt(ctx.env, "community-post-invalid-body")
    const namespaceVerificationId = await prepareVerifiedNamespace(ctx.env, session.accessToken)

    const communityCreate = await requestJson("http://pirate.test/communities", {
      display_name: "Pirate Test Club",
      namespace: {
        namespace_verification_id: namespaceVerificationId,
      },
    }, ctx.env, session.accessToken)
    expect(communityCreate.status).toBe(202)
    const communityCreateBody = await json(communityCreate) as {
      community: { community_id: string }
    }

    const response = await requestJson(
      `http://pirate.test/communities/${communityCreateBody.community.community_id}/posts`,
      {
        community_id: communityCreateBody.community.community_id,
        post_type: "text",
        idempotency_key: "post-key-duplicate-community-id",
      },
      ctx.env,
      session.accessToken,
    )

    expect(response.status).toBe(400)
    const body = await json(response) as { code: string }
    expect(body.code).toBe("bad_request")
  })

  test("community join requires a platform trust credential even for open communities", async () => {
    const ctx = await createRouteTestContext()
    cleanup = ctx.cleanup

    const verifiedCreator = await exchangeJwt(ctx.env, "community-join-creator")
    const namespaceVerificationId = await prepareVerifiedNamespace(ctx.env, verifiedCreator.accessToken)

    const communityCreate = await requestJson("http://pirate.test/communities", {
      display_name: "Pirate Join Club",
      namespace: {
        namespace_verification_id: namespaceVerificationId,
      },
      membership_mode: "open",
    }, ctx.env, verifiedCreator.accessToken)
    expect(communityCreate.status).toBe(202)
    const communityCreateBody = await json(communityCreate) as {
      community: { community_id: string }
    }

    const unverifiedUser = await exchangeJwt(ctx.env, "community-unverified-joiner")
    const deniedJoin = await app.request(
      `http://pirate.test/communities/${communityCreateBody.community.community_id}/join`,
      {
        method: "POST",
        headers: {
          authorization: `Bearer ${unverifiedUser.accessToken}`,
        },
      },
      ctx.env,
    )

    expect(deniedJoin.status).toBe(403)
    const deniedBody = await json(deniedJoin) as { code: string; message: string }
    expect(deniedBody.code).toBe("gate_failed")
    expect(deniedBody.message).toBe("A platform trust credential is required to join this community")

    const verifiedJoiner = await exchangeJwt(ctx.env, "community-verified-joiner")
    await completeUniqueHumanVerification(ctx.env, verifiedJoiner.accessToken)

    const allowedJoin = await app.request(
      `http://pirate.test/communities/${communityCreateBody.community.community_id}/join`,
      {
        method: "POST",
        headers: {
          authorization: `Bearer ${verifiedJoiner.accessToken}`,
        },
      },
      ctx.env,
    )

    expect(allowedJoin.status).toBe(200)
    const allowedBody = await json(allowedJoin) as { community_id: string; status: string }
    expect(allowedBody.community_id).toBe(communityCreateBody.community.community_id)
    expect(allowedBody.status).toBe("joined")
  })

  test("community join accepts a passport wallet score that passes the platform threshold", async () => {
    const ctx = await createRouteTestContext()
    cleanup = ctx.cleanup

    const verifiedCreator = await exchangeJwt(ctx.env, "community-wallet-score-creator")
    const namespaceVerificationId = await prepareVerifiedNamespace(ctx.env, verifiedCreator.accessToken)

    const communityCreate = await requestJson("http://pirate.test/communities", {
      display_name: "Pirate Wallet Score Club",
      namespace: {
        namespace_verification_id: namespaceVerificationId,
      },
      membership_mode: "open",
    }, ctx.env, verifiedCreator.accessToken)
    expect(communityCreate.status).toBe(202)
    const communityCreateBody = await json(communityCreate) as {
      community: { community_id: string }
    }

    const walletScoreJoiner = await exchangeJwt(ctx.env, "community-wallet-score-joiner")
    await setPassportWalletScore(ctx.env, walletScoreJoiner.userId, {
      score: 123.4,
      scoreThreshold: 20,
      passingScore: true,
    })

    const allowedJoin = await app.request(
      `http://pirate.test/communities/${communityCreateBody.community.community_id}/join`,
      {
        method: "POST",
        headers: {
          authorization: `Bearer ${walletScoreJoiner.accessToken}`,
        },
      },
      ctx.env,
    )

    expect(allowedJoin.status).toBe(200)
    const allowedBody = await json(allowedJoin) as { community_id: string; status: string }
    expect(allowedBody.community_id).toBe(communityCreateBody.community.community_id)
    expect(allowedBody.status).toBe("joined")

    const secondVerifiedJoiner = await exchangeJwt(ctx.env, "community-wallet-score-verified-joiner")
    await completeUniqueHumanVerification(ctx.env, secondVerifiedJoiner.accessToken)

    const secondJoin = await app.request(
      `http://pirate.test/communities/${communityCreateBody.community.community_id}/join`,
      {
        method: "POST",
        headers: {
          authorization: `Bearer ${secondVerifiedJoiner.accessToken}`,
        },
      },
      ctx.env,
    )

    expect(secondJoin.status).toBe(200)

    const communityGet = await app.request(
      `http://pirate.test/communities/${communityCreateBody.community.community_id}`,
      {
        headers: {
          authorization: `Bearer ${verifiedCreator.accessToken}`,
        },
      },
      ctx.env,
    )

    expect(communityGet.status).toBe(200)
    const communityGetBody = await json(communityGet) as {
      civic_scale_tier: string | null
      community_stage: string | null
      member_count: number | null
      qualified_member_count: number | null
    }
    expect(communityGetBody.community_stage).toBe("initial")
    expect(communityGetBody.civic_scale_tier).toBe("club")
    expect(communityGetBody.member_count).toBe(3)
    expect(communityGetBody.qualified_member_count).toBe(2)
  })

  test("gated community join enforces membership proof requirements", async () => {
    const ctx = await createRouteTestContext()
    cleanup = ctx.cleanup

    const verifiedCreator = await exchangeJwt(ctx.env, "community-gated-creator")
    const namespaceVerificationId = await prepareVerifiedNamespace(ctx.env, verifiedCreator.accessToken)

    const communityCreate = await requestJson("http://pirate.test/communities", {
      display_name: "Pirate Gated Club",
      namespace: {
        namespace_verification_id: namespaceVerificationId,
      },
      membership_mode: "gated",
      gate_rules: [
        {
          scope: "membership",
          gate_family: "identity_proof",
          gate_type: "unique_human",
          proof_requirements: [
            {
              proof_type: "unique_human",
              accepted_providers: ["self"],
            },
          ],
        },
      ],
    }, ctx.env, verifiedCreator.accessToken)
    expect(communityCreate.status).toBe(202)
    const communityCreateBody = await json(communityCreate) as {
      community: { community_id: string }
    }

    const veryJoiner = await exchangeJwt(ctx.env, "community-gated-very-joiner")
    await completeUniqueHumanVerification(ctx.env, veryJoiner.accessToken, "very")

    const deniedJoin = await app.request(
      `http://pirate.test/communities/${communityCreateBody.community.community_id}/join`,
      {
        method: "POST",
        headers: {
          authorization: `Bearer ${veryJoiner.accessToken}`,
        },
      },
      ctx.env,
    )

    expect(deniedJoin.status).toBe(403)
    const deniedBody = await json(deniedJoin) as { code: string; message: string }
    expect(deniedBody.code).toBe("gate_failed")
    expect(deniedBody.message).toBe("Community membership requirements are not satisfied")

    const selfJoiner = await exchangeJwt(ctx.env, "community-gated-self-joiner")
    await completeUniqueHumanVerification(ctx.env, selfJoiner.accessToken, "self")

    const allowedJoin = await app.request(
      `http://pirate.test/communities/${communityCreateBody.community.community_id}/join`,
      {
        method: "POST",
        headers: {
          authorization: `Bearer ${selfJoiner.accessToken}`,
        },
      },
      ctx.env,
    )

  expect(allowedJoin.status).toBe(200)
  const allowedBody = await json(allowedJoin) as { community_id: string; status: string }
  expect(allowedBody.community_id).toBe(communityCreateBody.community.community_id)
  expect(allowedBody.status).toBe("joined")
})

test("gated community join enforces Self nationality requirements", async () => {
  const ctx = await createRouteTestContext()
  cleanup = ctx.cleanup

  const creator = await exchangeJwt(ctx.env, "community-nationality-join-creator")
  const namespaceVerificationId = await prepareVerifiedNamespace(ctx.env, creator.accessToken)

  const communityCreate = await requestJson("http://pirate.test/communities", {
    display_name: "Pirate US Members",
    namespace: {
      namespace_verification_id: namespaceVerificationId,
    },
    membership_mode: "gated",
    gate_rules: [
      {
        scope: "membership",
        gate_family: "identity_proof",
        gate_type: "nationality",
        gate_config: {
          required_value: "US",
        },
        proof_requirements: [
          {
            proof_type: "nationality",
            accepted_providers: ["self"],
          },
        ],
      },
    ],
  }, ctx.env, creator.accessToken)
  expect(communityCreate.status).toBe(202)
  const communityCreateBody = await json(communityCreate) as {
    community: { community_id: string }
  }

  const deniedJoiner = await exchangeJwt(ctx.env, "community-nationality-join-ca")
  await setVerifiedUserNationality({
    client: ctx.client,
    userId: deniedJoiner.userId,
    countryCode: "CA",
  })

  const deniedJoin = await app.request(
    `http://pirate.test/communities/${communityCreateBody.community.community_id}/join`,
    {
      method: "POST",
      headers: {
        authorization: `Bearer ${deniedJoiner.accessToken}`,
      },
    },
    ctx.env,
  )

  expect(deniedJoin.status).toBe(403)
  const deniedBody = await json(deniedJoin) as {
    code: string
    message: string
    details?: {
      verification_policy?: {
        policy_id?: string
        provider?: string
        verification_intent?: string
      }
    }
  }
  expect(deniedBody.code).toBe("gate_failed")
  expect(deniedBody.message).toBe("Community membership requirements are not satisfied")
  expect(deniedBody.details?.verification_policy?.policy_id).toBe("policy_self_join_v1")
  expect(deniedBody.details?.verification_policy?.provider).toBe("self")
  expect(deniedBody.details?.verification_policy?.verification_intent).toBe("ucommunity_join")

  const allowedJoiner = await exchangeJwt(ctx.env, "community-nationality-join-us")
  await setVerifiedUserNationality({
    client: ctx.client,
    userId: allowedJoiner.userId,
    countryCode: "US",
  })

  const allowedJoin = await app.request(
    `http://pirate.test/communities/${communityCreateBody.community.community_id}/join`,
    {
      method: "POST",
      headers: {
        authorization: `Bearer ${allowedJoiner.accessToken}`,
      },
    },
    ctx.env,
  )

  expect(allowedJoin.status).toBe(200)
  const allowedBody = await json(allowedJoin) as { community_id: string; status: string }
  expect(allowedBody.community_id).toBe(communityCreateBody.community.community_id)
  expect(allowedBody.status).toBe("joined")
})

  test("community create rejects invalid accepted_providers combinations", async () => {
    const ctx = await createRouteTestContext()
    cleanup = ctx.cleanup

    const session = await exchangeJwt(ctx.env, "community-invalid-provider-creator")
    const namespaceVerificationId = await prepareVerifiedNamespace(ctx.env, session.accessToken)

    const invalidGenderProvider = await requestJson("http://pirate.test/communities", {
      display_name: "Invalid Gender Provider Club",
      namespace: {
        namespace_verification_id: namespaceVerificationId,
      },
      membership_mode: "gated",
      gate_rules: [
        {
          scope: "membership",
          gate_family: "identity_proof",
          gate_type: "gender",
          proof_requirements: [
            {
              proof_type: "gender",
              accepted_providers: ["passport"],
            },
          ],
        },
      ],
    }, ctx.env, session.accessToken)
    expect(invalidGenderProvider.status).toBe(400)
    const invalidGenderProviderBody = await json(invalidGenderProvider) as { code: string; message: string }
    expect(invalidGenderProviderBody.code).toBe("bad_request")
    expect(invalidGenderProviderBody.message).toMatch(/accepted_providers are invalid for gender/)

    const invalidWalletScoreProvider = await requestJson("http://pirate.test/communities", {
      display_name: "Invalid Wallet Provider Club",
      namespace: {
        namespace_verification_id: namespaceVerificationId,
      },
      membership_mode: "gated",
      gate_rules: [
        {
          scope: "membership",
          gate_family: "identity_proof",
          gate_type: "wallet_score",
          proof_requirements: [
            {
              proof_type: "wallet_score",
              accepted_providers: ["self"],
            },
          ],
        },
      ],
    }, ctx.env, session.accessToken)
    expect(invalidWalletScoreProvider.status).toBe(400)
    const invalidWalletScoreProviderBody = await json(invalidWalletScoreProvider) as { code: string; message: string }
    expect(invalidWalletScoreProviderBody.code).toBe("bad_request")
    expect(invalidWalletScoreProviderBody.message).toMatch(/accepted_providers are invalid for wallet_score/)
  })

  test("community money policy returns a default policy and persists explicit updates", async () => {
    const ctx = await createRouteTestContext()
    cleanup = ctx.cleanup

    const owner = await exchangeJwt(ctx.env, "community-money-policy-owner")
    const namespaceVerificationId = await prepareVerifiedNamespace(ctx.env, owner.accessToken)
    const communityCreate = await requestJson("http://pirate.test/communities", {
      display_name: "Pirate Treasury Club",
      namespace: {
        namespace_verification_id: namespaceVerificationId,
      },
    }, ctx.env, owner.accessToken)
    expect(communityCreate.status).toBe(202)
    const communityCreateBody = await json(communityCreate) as {
      community: { community_id: string }
    }

    const defaultPolicyResponse = await app.request(
      `http://pirate.test/communities/${communityCreateBody.community.community_id}/money-policy`,
      {
        headers: {
          authorization: `Bearer ${owner.accessToken}`,
        },
      },
      ctx.env,
    )
    expect(defaultPolicyResponse.status).toBe(200)
    const defaultPolicyBody = await json(defaultPolicyResponse) as {
      policy_origin: string
      funding_preference: string
      destination_settlement_token: string
      route_required: boolean
      approved_route_providers: string[] | null
    }
    expect(defaultPolicyBody.policy_origin).toBe("default")
    expect(defaultPolicyBody.funding_preference).toBe("USD")
    expect(defaultPolicyBody.destination_settlement_token).toBe("WIP")
    expect(defaultPolicyBody.route_required).toBe(false)
    expect(defaultPolicyBody.approved_route_providers).toBeNull()

    const updatedPolicyResponse = await requestJson(
      `http://pirate.test/communities/${communityCreateBody.community.community_id}/money-policy`,
      {
        funding_preference: "BTC",
        accepted_funding_assets: [
          {
            asset_symbol: "cBTC",
            chain_namespace: "eip155",
            chain_id: 5115,
            display_name: "Citrea cBTC",
          },
        ],
        accepted_source_chains: [
          {
            chain_namespace: "eip155",
            chain_id: 5115,
            display_name: "Citrea",
          },
        ],
        approved_route_providers: ["stargate"],
        destination_settlement_chain: {
          chain_namespace: "eip155",
          chain_id: null,
          display_name: "Story",
        },
        destination_settlement_token: "WIP",
        treasury_denomination: "WIP",
        max_slippage_bps: 150,
        quote_ttl_seconds: 180,
        route_required: true,
        route_status_policy: "fail",
        route_hop_tolerance: 1,
      },
      ctx.env,
      owner.accessToken,
      "PATCH",
    )
    expect(updatedPolicyResponse.status).toBe(200)
    const updatedPolicyBody = await json(updatedPolicyResponse) as {
      policy_origin: string
      funding_preference: string
      approved_route_providers: string[] | null
      route_required: boolean
      accepted_funding_assets: Array<{ asset_symbol: string }>
      accepted_source_chains: Array<{ display_name?: string | null }>
    }
    expect(updatedPolicyBody.policy_origin).toBe("explicit")
    expect(updatedPolicyBody.funding_preference).toBe("BTC")
    expect(updatedPolicyBody.route_required).toBe(true)
    expect(updatedPolicyBody.approved_route_providers).toEqual(["stargate"])
    expect(updatedPolicyBody.accepted_funding_assets[0]?.asset_symbol).toBe("cBTC")
    expect(updatedPolicyBody.accepted_source_chains[0]?.display_name).toBe("Citrea")

    const persistedPolicyResponse = await app.request(
      `http://pirate.test/communities/${communityCreateBody.community.community_id}/money-policy`,
      {
        headers: {
          authorization: `Bearer ${owner.accessToken}`,
        },
      },
      ctx.env,
    )
    expect(persistedPolicyResponse.status).toBe(200)
    const persistedPolicyBody = await json(persistedPolicyResponse) as {
      policy_origin: string
      funding_preference: string
      route_required: boolean
      approved_route_providers: string[] | null
    }
    expect(persistedPolicyBody.policy_origin).toBe("explicit")
    expect(persistedPolicyBody.funding_preference).toBe("BTC")
    expect(persistedPolicyBody.route_required).toBe(true)
    expect(persistedPolicyBody.approved_route_providers).toEqual(["stargate"])
  })

  test("community pricing policy returns a default policy and persists explicit updates", async () => {
    const ctx = await createRouteTestContext()
    cleanup = ctx.cleanup

    const owner = await exchangeJwt(ctx.env, "community-pricing-policy-owner")
    const namespaceVerificationId = await prepareVerifiedNamespace(ctx.env, owner.accessToken)
    const communityCreate = await requestJson("http://pirate.test/communities", {
      display_name: "Pirate Pricing Club",
      namespace: {
        namespace_verification_id: namespaceVerificationId,
      },
    }, ctx.env, owner.accessToken)
    expect(communityCreate.status).toBe(202)
    const communityCreateBody = await json(communityCreate) as {
      community: { community_id: string }
    }

    const defaultPolicyResponse = await app.request(
      `http://pirate.test/communities/${communityCreateBody.community.community_id}/pricing-policy`,
      {
        headers: {
          authorization: `Bearer ${owner.accessToken}`,
        },
      },
      ctx.env,
    )
    expect(defaultPolicyResponse.status).toBe(200)
    const defaultPolicyBody = await json(defaultPolicyResponse) as {
      policy_origin: string
      pricing_policy_version: string
      regional_pricing_enabled: boolean
      tiers: unknown[]
      country_assignments: unknown[]
    }
    expect(defaultPolicyBody.policy_origin).toBe("default")
    expect(defaultPolicyBody.pricing_policy_version).toBe("default")
    expect(defaultPolicyBody.regional_pricing_enabled).toBe(false)
    expect(defaultPolicyBody.tiers).toEqual([])
    expect(defaultPolicyBody.country_assignments).toEqual([])

    const updatedPolicyResponse = await requestJson(
      `http://pirate.test/communities/${communityCreateBody.community.community_id}/pricing-policy`,
      {
        regional_pricing_enabled: true,
        verification_provider_requirement: "self",
        default_tier_key: "regional_standard",
        tiers: [
          {
            tier_key: "regional_low",
            adjustment_type: "multiplier",
            adjustment_value: 0.5,
          },
          {
            tier_key: "regional_standard",
            adjustment_type: "multiplier",
            adjustment_value: 1,
          },
        ],
        country_assignments: [
          {
            country_code: "GE",
            tier_key: "regional_low",
          },
        ],
      },
      ctx.env,
      owner.accessToken,
      "PATCH",
    )
    expect(updatedPolicyResponse.status).toBe(200)
    const updatedPolicyBody = await json(updatedPolicyResponse) as {
      policy_origin: string
      regional_pricing_enabled: boolean
      verification_provider_requirement: string | null
      default_tier_key: string | null
      pricing_policy_version: string
      tiers: Array<{ tier_key: string }>
      country_assignments: Array<{ country_code: string; tier_key: string }>
    }
    expect(updatedPolicyBody.policy_origin).toBe("explicit")
    expect(updatedPolicyBody.regional_pricing_enabled).toBe(true)
    expect(updatedPolicyBody.verification_provider_requirement).toBe("self")
    expect(updatedPolicyBody.default_tier_key).toBe("regional_standard")
    expect(updatedPolicyBody.pricing_policy_version === "default").toBe(false)
    expect(updatedPolicyBody.tiers.map((tier) => tier.tier_key)).toEqual(["regional_low", "regional_standard"])
    expect(updatedPolicyBody.country_assignments).toEqual([{ country_code: "GE", tier_key: "regional_low" }])
  })

  test("community pricing policy patch returns 404 for a non-owner", async () => {
    const ctx = await createRouteTestContext()
    cleanup = ctx.cleanup

    const owner = await exchangeJwt(ctx.env, "community-pricing-policy-owner-authz")
    const namespaceVerificationId = await prepareVerifiedNamespace(ctx.env, owner.accessToken)
    const communityCreate = await requestJson("http://pirate.test/communities", {
      display_name: "Pirate Pricing Authz Club",
      namespace: {
        namespace_verification_id: namespaceVerificationId,
      },
    }, ctx.env, owner.accessToken)
    expect(communityCreate.status).toBe(202)
    const communityCreateBody = await json(communityCreate) as {
      community: { community_id: string }
    }

    const stranger = await exchangeJwt(ctx.env, "community-pricing-policy-non-owner")
    const deniedResponse = await requestJson(
      `http://pirate.test/communities/${communityCreateBody.community.community_id}/pricing-policy`,
      {
        regional_pricing_enabled: true,
        verification_provider_requirement: "self",
        default_tier_key: "regional_standard",
        tiers: [
          {
            tier_key: "regional_standard",
            adjustment_type: "multiplier",
            adjustment_value: 1,
          },
        ],
        country_assignments: [],
      },
      ctx.env,
      stranger.accessToken,
      "PATCH",
    )
    expect(deniedResponse.status).toBe(404)
    const deniedBody = await json(deniedResponse) as { code: string; message: string }
    expect(deniedBody.code).toBe("not_found")
    expect(deniedBody.message).toBe("Community not found")
  })

  test("community pricing policy rejects duplicate country assignments", async () => {
    const ctx = await createRouteTestContext()
    cleanup = ctx.cleanup

    const owner = await exchangeJwt(ctx.env, "community-pricing-policy-duplicate-country")
    const namespaceVerificationId = await prepareVerifiedNamespace(ctx.env, owner.accessToken)
    const communityCreate = await requestJson("http://pirate.test/communities", {
      display_name: "Pirate Duplicate Country Club",
      namespace: {
        namespace_verification_id: namespaceVerificationId,
      },
    }, ctx.env, owner.accessToken)
    expect(communityCreate.status).toBe(202)
    const communityCreateBody = await json(communityCreate) as {
      community: { community_id: string }
    }

    const deniedResponse = await requestJson(
      `http://pirate.test/communities/${communityCreateBody.community.community_id}/pricing-policy`,
      {
        regional_pricing_enabled: true,
        verification_provider_requirement: "self",
        default_tier_key: "regional_standard",
        tiers: [
          {
            tier_key: "regional_low",
            adjustment_type: "multiplier",
            adjustment_value: 0.5,
          },
          {
            tier_key: "regional_standard",
            adjustment_type: "multiplier",
            adjustment_value: 1,
          },
        ],
        country_assignments: [
          {
            country_code: "GE",
            tier_key: "regional_low",
          },
          {
            country_code: "ge",
            tier_key: "regional_standard",
          },
        ],
      },
      ctx.env,
      owner.accessToken,
      "PATCH",
    )
    expect(deniedResponse.status).toBe(403)
    const deniedBody = await json(deniedResponse) as { code: string; message: string }
    expect(deniedBody.code).toBe("eligibility_failed")
    expect(deniedBody.message).toBe("Duplicate country assignment: GE")
  })

  test("community purchase quote preflight returns the default direct settlement lane", async () => {
    const ctx = await createRouteTestContext()
    cleanup = ctx.cleanup

    const owner = await exchangeJwt(ctx.env, "community-purchase-quote-default-owner")
    const namespaceVerificationId = await prepareVerifiedNamespace(ctx.env, owner.accessToken)
    const communityCreate = await requestJson("http://pirate.test/communities", {
      display_name: "Pirate Quote Club",
      namespace: {
        namespace_verification_id: namespaceVerificationId,
      },
    }, ctx.env, owner.accessToken)
    expect(communityCreate.status).toBe(202)
    const communityCreateBody = await json(communityCreate) as {
      community: { community_id: string }
    }

    const quoteResponse = await requestJson(
      `http://pirate.test/communities/${communityCreateBody.community.community_id}/purchase-quote-preflight`,
      {
        client_estimated_slippage_bps: 0,
        client_estimated_hop_count: 0,
      },
      ctx.env,
      owner.accessToken,
    )
    expect(quoteResponse.status).toBe(200)
    const quoteBody = await json(quoteResponse) as {
      eligible: boolean
      funding_mode: string
      policy_origin: string
      funding_preference: string
      destination_settlement_token: string
      route_required: boolean
      quoted_at: string
      expires_at: string
    }
    expect(quoteBody.eligible).toBe(true)
    expect(quoteBody.funding_mode).toBe("direct")
    expect(quoteBody.policy_origin).toBe("default")
    expect(quoteBody.funding_preference).toBe("USD")
    expect(quoteBody.destination_settlement_token).toBe("WIP")
    expect(quoteBody.route_required).toBe(false)
    expect(Date.parse(quoteBody.expires_at) > Date.parse(quoteBody.quoted_at)).toBe(true)
  })

  test("community purchase quote preflight returns a routed lane when the money policy allows it", async () => {
    const ctx = await createRouteTestContext()
    cleanup = ctx.cleanup

    const owner = await exchangeJwt(ctx.env, "community-purchase-quote-routed-owner")
    const namespaceVerificationId = await prepareVerifiedNamespace(ctx.env, owner.accessToken)
    const communityCreate = await requestJson("http://pirate.test/communities", {
      display_name: "Pirate Routed Quote Club",
      namespace: {
        namespace_verification_id: namespaceVerificationId,
      },
    }, ctx.env, owner.accessToken)
    expect(communityCreate.status).toBe(202)
    const communityCreateBody = await json(communityCreate) as {
      community: { community_id: string }
    }

    const policyUpdate = await requestJson(
      `http://pirate.test/communities/${communityCreateBody.community.community_id}/money-policy`,
      {
        funding_preference: "BTC",
        accepted_funding_assets: [
          {
            asset_symbol: "cBTC",
            chain_namespace: "eip155",
            chain_id: 5115,
            display_name: "Citrea cBTC",
          },
        ],
        accepted_source_chains: [
          {
            chain_namespace: "eip155",
            chain_id: 5115,
            display_name: "Citrea",
          },
        ],
        approved_route_providers: ["stargate"],
        destination_settlement_chain: {
          chain_namespace: "eip155",
          chain_id: null,
          display_name: "Story",
        },
        destination_settlement_token: "WIP",
        treasury_denomination: "WIP",
        max_slippage_bps: 150,
        quote_ttl_seconds: 180,
        route_required: true,
        route_status_policy: "fail",
        route_hop_tolerance: 1,
      },
      ctx.env,
      owner.accessToken,
      "PATCH",
    )
    expect(policyUpdate.status).toBe(200)

    const quoteResponse = await requestJson(
      `http://pirate.test/communities/${communityCreateBody.community.community_id}/purchase-quote-preflight`,
      {
        funding_asset: {
          asset_symbol: "cBTC",
          chain_namespace: "eip155",
          chain_id: 5115,
          display_name: "Citrea cBTC",
        },
        source_chain: {
          chain_namespace: "eip155",
          chain_id: 5115,
          display_name: "Citrea",
        },
        route_provider: "stargate",
        client_estimated_slippage_bps: 100,
        client_estimated_hop_count: 1,
        client_route_valid_for_seconds: 180,
      },
      ctx.env,
      owner.accessToken,
    )
    expect(quoteResponse.status).toBe(200)
    const quoteBody = await json(quoteResponse) as {
      eligible: boolean
      funding_mode: string
      policy_origin: string
      funding_preference: string
      route_provider: string | null
      funding_asset: { asset_symbol: string } | null
      source_chain: { display_name?: string | null } | null
      destination_settlement_token: string
      route_required: boolean
    }
    expect(quoteBody.eligible).toBe(true)
    expect(quoteBody.funding_mode).toBe("routed")
    expect(quoteBody.policy_origin).toBe("explicit")
    expect(quoteBody.funding_preference).toBe("BTC")
    expect(quoteBody.route_provider).toBe("stargate")
    expect(quoteBody.funding_asset?.asset_symbol).toBe("cBTC")
    expect(quoteBody.source_chain?.display_name).toBe("Citrea")
    expect(quoteBody.destination_settlement_token).toBe("WIP")
    expect(quoteBody.route_required).toBe(true)
  })

  test("community purchase quote preflight fails closed when the requested route violates policy", async () => {
    const ctx = await createRouteTestContext()
    cleanup = ctx.cleanup

    const owner = await exchangeJwt(ctx.env, "community-purchase-quote-reject-owner")
    const namespaceVerificationId = await prepareVerifiedNamespace(ctx.env, owner.accessToken)
    const communityCreate = await requestJson("http://pirate.test/communities", {
      display_name: "Pirate Rejected Quote Club",
      namespace: {
        namespace_verification_id: namespaceVerificationId,
      },
    }, ctx.env, owner.accessToken)
    expect(communityCreate.status).toBe(202)
    const communityCreateBody = await json(communityCreate) as {
      community: { community_id: string }
    }

    const policyUpdate = await requestJson(
      `http://pirate.test/communities/${communityCreateBody.community.community_id}/money-policy`,
      {
        funding_preference: "BTC",
        accepted_funding_assets: [
          {
            asset_symbol: "cBTC",
            chain_namespace: "eip155",
            chain_id: 5115,
            display_name: "Citrea cBTC",
          },
        ],
        accepted_source_chains: [
          {
            chain_namespace: "eip155",
            chain_id: 5115,
            display_name: "Citrea",
          },
        ],
        approved_route_providers: ["stargate"],
        destination_settlement_chain: {
          chain_namespace: "eip155",
          chain_id: null,
          display_name: "Story",
        },
        destination_settlement_token: "WIP",
        treasury_denomination: "WIP",
        max_slippage_bps: 150,
        quote_ttl_seconds: 180,
        route_required: true,
        route_status_policy: "fail",
        route_hop_tolerance: 1,
      },
      ctx.env,
      owner.accessToken,
      "PATCH",
    )
    expect(policyUpdate.status).toBe(200)

    const deniedQuote = await requestJson(
      `http://pirate.test/communities/${communityCreateBody.community.community_id}/purchase-quote-preflight`,
      {
        funding_asset: {
          asset_symbol: "cBTC",
          chain_namespace: "eip155",
          chain_id: 5115,
          display_name: "Citrea cBTC",
        },
        source_chain: {
          chain_namespace: "eip155",
          chain_id: 5115,
          display_name: "Citrea",
        },
        route_provider: "across",
        client_estimated_slippage_bps: 200,
        client_estimated_hop_count: 2,
        client_route_valid_for_seconds: 60,
      },
      ctx.env,
      owner.accessToken,
    )
    expect(deniedQuote.status).toBe(403)
    const deniedQuoteBody = await json(deniedQuote) as { code: string; message: string }
    expect(deniedQuoteBody.code).toBe("eligibility_failed")
    expect(deniedQuoteBody.message).toMatch(/Route provider is not approved|Route slippage exceeds community policy/)
  })

  test("community purchase quotes price a direct asset listing at the authored base USD amount", async () => {
    const ctx = await createRouteTestContext()
    cleanup = ctx.cleanup

    const owner = await exchangeJwt(ctx.env, "community-purchase-quote-owner")
    const namespaceVerificationId = await prepareVerifiedNamespace(ctx.env, owner.accessToken)
    const communityCreate = await requestJson("http://pirate.test/communities", {
      display_name: "Pirate Purchase Quotes",
      namespace: {
        namespace_verification_id: namespaceVerificationId,
      },
    }, ctx.env, owner.accessToken)
    expect(communityCreate.status).toBe(202)
    const communityCreateBody = await json(communityCreate) as {
      community: { community_id: string }
    }
    await insertCommunityListing({
      communityDbRoot: ctx.communityDbRoot,
      communityId: communityCreateBody.community.community_id,
      listingId: "lst_song_asset_1",
      createdByUserId: owner.userId,
      assetId: "ast_song_1",
      priceUsd: "12.50",
    })

    const quoteResponse = await requestJson(
      `http://pirate.test/communities/${communityCreateBody.community.community_id}/purchase-quotes`,
      {
        listing_id: "lst_song_asset_1",
        client_estimated_slippage_bps: 0,
        client_estimated_hop_count: 0,
      },
      ctx.env,
      owner.accessToken,
    )
    expect(quoteResponse.status).toBe(200)
    const quoteBody = await json(quoteResponse) as {
      quote_id: string
      community_id: string
      listing_id: string
      buyer_user_id: string
      asset_id: string | null
      live_room_id: string | null
      base_price_usd: number
      final_price_usd: number
      funding_mode: string
      route_policy_compliant: boolean
      route_live_available: boolean | null
      destination_settlement_token: string
      pricing_tier: string | null
    }
    expect(quoteBody.quote_id).toMatch(/^qte_/)
    expect(quoteBody.community_id).toBe(communityCreateBody.community.community_id)
    expect(quoteBody.listing_id).toBe("lst_song_asset_1")
    expect(quoteBody.asset_id).toBe("ast_song_1")
    expect(quoteBody.live_room_id).toBeNull()
    expect(quoteBody.base_price_usd).toBe(12.5)
    expect(quoteBody.final_price_usd).toBe(12.5)
    expect(quoteBody.funding_mode).toBe("direct")
    expect(quoteBody.route_policy_compliant).toBe(true)
    expect(quoteBody.route_live_available).toBeNull()
    expect(quoteBody.destination_settlement_token).toBe("WIP")
    expect(quoteBody.pricing_tier).toBeNull()
    expect(quoteBody.buyer_user_id).toBe(owner.userId)
    const persistedQuote = await readPurchaseQuoteRow({
      communityDbRoot: ctx.communityDbRoot,
      communityId: communityCreateBody.community.community_id,
      quoteId: quoteBody.quote_id,
    })
    expect(persistedQuote?.status).toBe("active")
    expect(persistedQuote?.community_id).toBe(communityCreateBody.community.community_id)
    expect(persistedQuote?.listing_id).toBe("lst_song_asset_1")
    expect(persistedQuote?.buyer_user_id).toBe(owner.userId)
    expect(persistedQuote?.route_policy_compliant).toBe(1)
    expect(persistedQuote?.route_live_available).toBeNull()
    expect(persistedQuote?.policy_origin).toBe("default")
  })

  test("community purchase quotes support a routed live-room quote when the money policy allows it", async () => {
    const ctx = await createRouteTestContext()
    cleanup = ctx.cleanup

    const owner = await exchangeJwt(ctx.env, "community-purchase-quote-routed-live-owner")
    const namespaceVerificationId = await prepareVerifiedNamespace(ctx.env, owner.accessToken)
    const communityCreate = await requestJson("http://pirate.test/communities", {
      display_name: "Pirate Routed Purchase Quotes",
      namespace: {
        namespace_verification_id: namespaceVerificationId,
      },
    }, ctx.env, owner.accessToken)
    expect(communityCreate.status).toBe(202)
    const communityCreateBody = await json(communityCreate) as {
      community: { community_id: string }
    }
    await insertCommunityListing({
      communityDbRoot: ctx.communityDbRoot,
      communityId: communityCreateBody.community.community_id,
      listingId: "lst_live_room_1",
      createdByUserId: owner.userId,
      liveRoomId: "room_live_1",
      priceUsd: "8.00",
    })

    const policyUpdate = await requestJson(
      `http://pirate.test/communities/${communityCreateBody.community.community_id}/money-policy`,
      {
        funding_preference: "BTC",
        accepted_funding_assets: [
          {
            asset_symbol: "cBTC",
            chain_namespace: "eip155",
            chain_id: 5115,
            display_name: "Citrea cBTC",
          },
        ],
        accepted_source_chains: [
          {
            chain_namespace: "eip155",
            chain_id: 5115,
            display_name: "Citrea",
          },
        ],
        approved_route_providers: ["stargate"],
        destination_settlement_chain: {
          chain_namespace: "eip155",
          chain_id: null,
          display_name: "Story",
        },
        destination_settlement_token: "WIP",
        treasury_denomination: "WIP",
        max_slippage_bps: 150,
        quote_ttl_seconds: 180,
        route_required: true,
        route_status_policy: "fail",
        route_hop_tolerance: 1,
      },
      ctx.env,
      owner.accessToken,
      "PATCH",
    )
    expect(policyUpdate.status).toBe(200)

    const quoteResponse = await requestJson(
      `http://pirate.test/communities/${communityCreateBody.community.community_id}/purchase-quotes`,
      {
        listing_id: "lst_live_room_1",
        funding_asset: {
          asset_symbol: "cBTC",
          chain_namespace: "eip155",
          chain_id: 5115,
          display_name: "Citrea cBTC",
        },
        source_chain: {
          chain_namespace: "eip155",
          chain_id: 5115,
          display_name: "Citrea",
        },
        route_provider: "stargate",
        client_estimated_slippage_bps: 100,
        client_estimated_hop_count: 1,
        client_route_valid_for_seconds: 180,
      },
      ctx.env,
      owner.accessToken,
    )
    expect(quoteResponse.status).toBe(200)
    const quoteBody = await json(quoteResponse) as {
      quote_id: string
      listing_id: string
      live_room_id: string | null
      base_price_usd: number
      final_price_usd: number
      funding_mode: string
      route_policy_compliant: boolean
      route_live_available: boolean | null
      route_provider: string | null
      funding_asset: { asset_symbol: string } | null
      source_chain: { display_name?: string | null } | null
      policy_origin: string
      route_required: boolean
    }
    expect(quoteBody.listing_id).toBe("lst_live_room_1")
    expect(quoteBody.live_room_id).toBe("room_live_1")
    expect(quoteBody.base_price_usd).toBe(8)
    expect(quoteBody.final_price_usd).toBe(8)
    expect(quoteBody.funding_mode).toBe("routed")
    expect(quoteBody.route_policy_compliant).toBe(true)
    expect(quoteBody.route_live_available).toBeNull()
    expect(quoteBody.route_provider).toBe("stargate")
    expect(quoteBody.funding_asset?.asset_symbol).toBe("cBTC")
    expect(quoteBody.source_chain?.display_name).toBe("Citrea")
    expect(quoteBody.policy_origin).toBe("explicit")
    expect(quoteBody.route_required).toBe(true)
    const persistedQuote = await readPurchaseQuoteRow({
      communityDbRoot: ctx.communityDbRoot,
      communityId: communityCreateBody.community.community_id,
      quoteId: quoteBody.quote_id,
    })
    expect(persistedQuote?.policy_origin).toBe("explicit")
  })

  test("community purchase quotes apply community pricing policy for verified self nationality", async () => {
    const ctx = await createRouteTestContext()
    cleanup = ctx.cleanup

    const owner = await exchangeJwt(ctx.env, "community-pricing-quote-owner")
    await setVerifiedUserNationality({
      client: ctx.client,
      userId: owner.userId,
      countryCode: "GE",
    })

    const namespaceVerificationId = await prepareVerifiedNamespace(ctx.env, owner.accessToken)
    const communityCreate = await requestJson("http://pirate.test/communities", {
      display_name: "Pirate Regional Pricing Quotes",
      namespace: {
        namespace_verification_id: namespaceVerificationId,
      },
    }, ctx.env, owner.accessToken)
    expect(communityCreate.status).toBe(202)
    const communityCreateBody = await json(communityCreate) as {
      community: { community_id: string }
    }

    const pricingPolicyUpdate = await requestJson(
      `http://pirate.test/communities/${communityCreateBody.community.community_id}/pricing-policy`,
      {
        regional_pricing_enabled: true,
        verification_provider_requirement: "self",
        default_tier_key: "regional_standard",
        tiers: [
          {
            tier_key: "regional_low",
            adjustment_type: "multiplier",
            adjustment_value: 0.5,
          },
          {
            tier_key: "regional_standard",
            adjustment_type: "multiplier",
            adjustment_value: 1,
          },
        ],
        country_assignments: [
          {
            country_code: "GE",
            tier_key: "regional_low",
          },
        ],
      },
      ctx.env,
      owner.accessToken,
      "PATCH",
    )
    expect(pricingPolicyUpdate.status).toBe(200)

    await insertCommunityListing({
      communityDbRoot: ctx.communityDbRoot,
      communityId: communityCreateBody.community.community_id,
      listingId: "lst_song_asset_regional_1",
      createdByUserId: owner.userId,
      assetId: "ast_song_regional_1",
      priceUsd: "12.50",
      regionalPricingEnabled: true,
    })

    const quoteResponse = await requestJson(
      `http://pirate.test/communities/${communityCreateBody.community.community_id}/purchase-quotes`,
      {
        listing_id: "lst_song_asset_regional_1",
        client_estimated_slippage_bps: 0,
        client_estimated_hop_count: 0,
      },
      ctx.env,
      owner.accessToken,
    )
    expect(quoteResponse.status).toBe(200)
    const quoteBody = await json(quoteResponse) as {
      quote_id: string
      final_price_usd: number
      pricing_tier: string | null
      pricing_policy_version: string | null
      verification_snapshot_ref: string | null
    }
    expect(quoteBody.final_price_usd).toBe(6.25)
    expect(quoteBody.pricing_tier).toBe("regional_low")
    expect(quoteBody.pricing_policy_version == null).toBe(false)
    expect(quoteBody.verification_snapshot_ref).toMatch(/^vsr_/)

    const persistedQuote = await readPurchaseQuoteRow({
      communityDbRoot: ctx.communityDbRoot,
      communityId: communityCreateBody.community.community_id,
      quoteId: quoteBody.quote_id,
    })
    expect(persistedQuote?.pricing_tier).toBe("regional_low")
    expect(persistedQuote?.pricing_policy_version == null).toBe(false)
    expect(persistedQuote?.verification_snapshot_ref).toMatch(/^vsr_/)
  })

  test("community purchase quotes fall back to base price when nationality is not verified", async () => {
    const ctx = await createRouteTestContext()
    cleanup = ctx.cleanup

    const owner = await exchangeJwt(ctx.env, "community-pricing-quote-unverified-owner")
    const namespaceVerificationId = await prepareVerifiedNamespace(ctx.env, owner.accessToken)
    const communityCreate = await requestJson("http://pirate.test/communities", {
      display_name: "Pirate Regional Pricing Fallback Quotes",
      namespace: {
        namespace_verification_id: namespaceVerificationId,
      },
    }, ctx.env, owner.accessToken)
    expect(communityCreate.status).toBe(202)
    const communityCreateBody = await json(communityCreate) as {
      community: { community_id: string }
    }

    const pricingPolicyUpdate = await requestJson(
      `http://pirate.test/communities/${communityCreateBody.community.community_id}/pricing-policy`,
      {
        regional_pricing_enabled: true,
        verification_provider_requirement: "self",
        default_tier_key: "regional_standard",
        tiers: [
          {
            tier_key: "regional_low",
            adjustment_type: "multiplier",
            adjustment_value: 0.5,
          },
          {
            tier_key: "regional_standard",
            adjustment_type: "multiplier",
            adjustment_value: 1,
          },
        ],
        country_assignments: [
          {
            country_code: "GE",
            tier_key: "regional_low",
          },
        ],
      },
      ctx.env,
      owner.accessToken,
      "PATCH",
    )
    expect(pricingPolicyUpdate.status).toBe(200)

    await insertCommunityListing({
      communityDbRoot: ctx.communityDbRoot,
      communityId: communityCreateBody.community.community_id,
      listingId: "lst_song_asset_regional_unverified_1",
      createdByUserId: owner.userId,
      assetId: "ast_song_regional_unverified_1",
      priceUsd: "12.50",
      regionalPricingEnabled: true,
    })

    const quoteResponse = await requestJson(
      `http://pirate.test/communities/${communityCreateBody.community.community_id}/purchase-quotes`,
      {
        listing_id: "lst_song_asset_regional_unverified_1",
        client_estimated_slippage_bps: 0,
        client_estimated_hop_count: 0,
      },
      ctx.env,
      owner.accessToken,
    )
    expect(quoteResponse.status).toBe(200)
    const quoteBody = await json(quoteResponse) as {
      quote_id: string
      base_price_usd: number
      final_price_usd: number
      pricing_tier: string | null
      pricing_policy_version: string | null
      verification_snapshot_ref: string | null
    }
    expect(quoteBody.base_price_usd).toBe(12.5)
    expect(quoteBody.final_price_usd).toBe(12.5)
    expect(quoteBody.pricing_tier).toBeNull()
    expect(quoteBody.pricing_policy_version == null).toBe(false)
    expect(quoteBody.verification_snapshot_ref).toMatch(/^vsr_/)

    const persistedQuote = await readPurchaseQuoteRow({
      communityDbRoot: ctx.communityDbRoot,
      communityId: communityCreateBody.community.community_id,
      quoteId: quoteBody.quote_id,
    })
    expect(persistedQuote?.pricing_tier).toBeNull()
    expect(persistedQuote?.pricing_policy_version == null).toBe(false)
    expect(persistedQuote?.verification_snapshot_ref).toMatch(/^vsr_/)
  })

  test("community purchase quotes use default_tier_key when nationality has no explicit country assignment", async () => {
    const ctx = await createRouteTestContext()
    cleanup = ctx.cleanup

    const owner = await exchangeJwt(ctx.env, "community-pricing-quote-default-tier-owner")
    await setVerifiedUserNationality({
      client: ctx.client,
      userId: owner.userId,
      countryCode: "TR",
    })

    const namespaceVerificationId = await prepareVerifiedNamespace(ctx.env, owner.accessToken)
    const communityCreate = await requestJson("http://pirate.test/communities", {
      display_name: "Pirate Default Tier Quotes",
      namespace: {
        namespace_verification_id: namespaceVerificationId,
      },
    }, ctx.env, owner.accessToken)
    expect(communityCreate.status).toBe(202)
    const communityCreateBody = await json(communityCreate) as {
      community: { community_id: string }
    }

    const pricingPolicyUpdate = await requestJson(
      `http://pirate.test/communities/${communityCreateBody.community.community_id}/pricing-policy`,
      {
        regional_pricing_enabled: true,
        verification_provider_requirement: "self",
        default_tier_key: "regional_standard",
        tiers: [
          {
            tier_key: "regional_low",
            adjustment_type: "multiplier",
            adjustment_value: 0.5,
          },
          {
            tier_key: "regional_standard",
            adjustment_type: "fixed_price_usd",
            adjustment_value: 9,
          },
        ],
        country_assignments: [
          {
            country_code: "GE",
            tier_key: "regional_low",
          },
        ],
      },
      ctx.env,
      owner.accessToken,
      "PATCH",
    )
    expect(pricingPolicyUpdate.status).toBe(200)

    await insertCommunityListing({
      communityDbRoot: ctx.communityDbRoot,
      communityId: communityCreateBody.community.community_id,
      listingId: "lst_song_asset_regional_default_tier_1",
      createdByUserId: owner.userId,
      assetId: "ast_song_regional_default_tier_1",
      priceUsd: "12.50",
      regionalPricingEnabled: true,
    })

    const quoteResponse = await requestJson(
      `http://pirate.test/communities/${communityCreateBody.community.community_id}/purchase-quotes`,
      {
        listing_id: "lst_song_asset_regional_default_tier_1",
        client_estimated_slippage_bps: 0,
        client_estimated_hop_count: 0,
      },
      ctx.env,
      owner.accessToken,
    )
    expect(quoteResponse.status).toBe(200)
    const quoteBody = await json(quoteResponse) as {
      quote_id: string
      final_price_usd: number
      pricing_tier: string | null
      pricing_policy_version: string | null
      verification_snapshot_ref: string | null
    }
    expect(quoteBody.final_price_usd).toBe(9)
    expect(quoteBody.pricing_tier).toBe("regional_standard")
    expect(quoteBody.pricing_policy_version == null).toBe(false)
    expect(quoteBody.verification_snapshot_ref).toMatch(/^vsr_/)

    const persistedQuote = await readPurchaseQuoteRow({
      communityDbRoot: ctx.communityDbRoot,
      communityId: communityCreateBody.community.community_id,
      quoteId: quoteBody.quote_id,
    })
    expect(persistedQuote?.pricing_tier).toBe("regional_standard")
    expect(persistedQuote?.pricing_policy_version == null).toBe(false)
    expect(persistedQuote?.verification_snapshot_ref).toMatch(/^vsr_/)
  })

  test("community purchase quotes reject listings that are not currently sellable", async () => {
    const ctx = await createRouteTestContext()
    cleanup = ctx.cleanup

    const owner = await exchangeJwt(ctx.env, "community-purchase-quote-paused-owner")
    const namespaceVerificationId = await prepareVerifiedNamespace(ctx.env, owner.accessToken)
    const communityCreate = await requestJson("http://pirate.test/communities", {
      display_name: "Pirate Paused Listings",
      namespace: {
        namespace_verification_id: namespaceVerificationId,
      },
    }, ctx.env, owner.accessToken)
    expect(communityCreate.status).toBe(202)
    const communityCreateBody = await json(communityCreate) as {
      community: { community_id: string }
    }
    await insertCommunityListing({
      communityDbRoot: ctx.communityDbRoot,
      communityId: communityCreateBody.community.community_id,
      listingId: "lst_paused_1",
      createdByUserId: owner.userId,
      assetId: "ast_song_1",
      status: "paused",
      priceUsd: "5.00",
    })

    const deniedQuote = await requestJson(
      `http://pirate.test/communities/${communityCreateBody.community.community_id}/purchase-quotes`,
      {
        listing_id: "lst_paused_1",
        client_estimated_slippage_bps: 0,
        client_estimated_hop_count: 0,
      },
      ctx.env,
      owner.accessToken,
    )
    expect(deniedQuote.status).toBe(403)
    const deniedQuoteBody = await json(deniedQuote) as { code: string; message: string }
    expect(deniedQuoteBody.code).toBe("eligibility_failed")
    expect(deniedQuoteBody.message).toMatch(/Listing is not available for purchase/)
  })

  test("community purchase quotes do not cross community boundaries for listing lookup", async () => {
    const ctx = await createRouteTestContext()
    cleanup = ctx.cleanup

    const ownerA = await exchangeJwt(ctx.env, "community-purchase-quote-cross-a")
    const ownerB = await exchangeJwt(ctx.env, "community-purchase-quote-cross-b")

    const namespaceVerificationA = await prepareVerifiedNamespace(ctx.env, ownerA.accessToken)
    const communityCreateA = await requestJson("http://pirate.test/communities", {
      display_name: "Pirate Quote Community A",
      namespace: {
        namespace_verification_id: namespaceVerificationA,
      },
    }, ctx.env, ownerA.accessToken)
    expect(communityCreateA.status).toBe(202)
    const communityA = await json(communityCreateA) as { community: { community_id: string } }

    const namespaceVerificationB = await prepareVerifiedNamespace(ctx.env, ownerB.accessToken)
    const communityCreateB = await requestJson("http://pirate.test/communities", {
      display_name: "Pirate Quote Community B",
      namespace: {
        namespace_verification_id: namespaceVerificationB,
      },
    }, ctx.env, ownerB.accessToken)
    expect(communityCreateB.status).toBe(202)
    const communityB = await json(communityCreateB) as { community: { community_id: string } }

    await insertCommunityListing({
      communityDbRoot: ctx.communityDbRoot,
      communityId: communityA.community.community_id,
      listingId: "lst_cross_boundary_1",
      createdByUserId: ownerA.userId,
      assetId: "ast_cross_boundary_1",
      priceUsd: "9.00",
    })

    const deniedQuote = await requestJson(
      `http://pirate.test/communities/${communityB.community.community_id}/purchase-quotes`,
      {
        listing_id: "lst_cross_boundary_1",
        client_estimated_slippage_bps: 0,
        client_estimated_hop_count: 0,
      },
      ctx.env,
      ownerB.accessToken,
    )
    expect(deniedQuote.status).toBe(404)
    const deniedQuoteBody = await json(deniedQuote) as { code: string; message: string }
    expect(deniedQuoteBody.code).toBe("not_found")
    expect(deniedQuoteBody.message).toMatch(/Listing not found/)
  })

  test("stored purchase quotes round-trip policy origin and remain community scoped", async () => {
    const ctx = await createRouteTestContext()
    cleanup = ctx.cleanup

    const owner = await exchangeJwt(ctx.env, "community-purchase-quote-readback-owner")
    const namespaceVerificationId = await prepareVerifiedNamespace(ctx.env, owner.accessToken)
    const communityCreate = await requestJson("http://pirate.test/communities", {
      display_name: "Pirate Quote Readback",
      namespace: {
        namespace_verification_id: namespaceVerificationId,
      },
    }, ctx.env, owner.accessToken)
    expect(communityCreate.status).toBe(202)
    const communityCreateBody = await json(communityCreate) as {
      community: { community_id: string }
    }
    await insertCommunityListing({
      communityDbRoot: ctx.communityDbRoot,
      communityId: communityCreateBody.community.community_id,
      listingId: "lst_quote_readback_1",
      createdByUserId: owner.userId,
      assetId: "ast_quote_readback_1",
      priceUsd: "7.25",
    })

    const quoteResponse = await requestJson(
      `http://pirate.test/communities/${communityCreateBody.community.community_id}/purchase-quotes`,
      {
        listing_id: "lst_quote_readback_1",
        client_estimated_slippage_bps: 0,
        client_estimated_hop_count: 0,
      },
      ctx.env,
      owner.accessToken,
    )
    expect(quoteResponse.status).toBe(200)
    const quoteBody = await json(quoteResponse) as {
      quote_id: string
      policy_origin: string
    }

    const client = createClient({
      url: buildLocalCommunityDbUrl(ctx.communityDbRoot, communityCreateBody.community.community_id),
    })
    try {
      const storedQuote = await getCommunityPurchaseQuoteById({
        client,
        communityId: communityCreateBody.community.community_id,
        quoteId: quoteBody.quote_id,
      })
      expect(storedQuote?.policy_origin).toBe("default")

      const wrongCommunityQuote = await getCommunityPurchaseQuoteById({
        client,
        communityId: "com_wrong_scope",
        quoteId: quoteBody.quote_id,
      })
      expect(wrongCommunityQuote).toBeNull()
    } finally {
      client.close()
    }
  })

  test("community owners can create, list, read, and update listings", async () => {
    const ctx = await createRouteTestContext()
    cleanup = ctx.cleanup

    const owner = await exchangeJwt(ctx.env, "community-listing-owner")
    const namespaceVerificationId = await prepareVerifiedNamespace(ctx.env, owner.accessToken)
    const communityCreate = await requestJson("http://pirate.test/communities", {
      display_name: "Pirate Listing Admin",
      namespace: {
        namespace_verification_id: namespaceVerificationId,
      },
    }, ctx.env, owner.accessToken)
    expect(communityCreate.status).toBe(202)
    const communityCreateBody = await json(communityCreate) as {
      community: { community_id: string }
    }

    const createListing = await requestJson(
      `http://pirate.test/communities/${communityCreateBody.community.community_id}/listings`,
      {
        asset_id: "ast_listing_admin_1",
        price_usd: 14.5,
        regional_pricing_enabled: true,
        status: "draft",
      },
      ctx.env,
      owner.accessToken,
    )
    expect(createListing.status).toBe(201)
    const createdListing = await json(createListing) as {
      listing_id: string
      asset_id: string | null
      status: string
      price_usd: number
      regional_pricing_enabled: boolean
    }
    expect(createdListing.listing_id).toMatch(/^lst_/)
    expect(createdListing.asset_id).toBe("ast_listing_admin_1")
    expect(createdListing.status).toBe("draft")
    expect(createdListing.price_usd).toBe(14.5)
    expect(createdListing.regional_pricing_enabled).toBe(true)

    const listListings = await app.request(
      `http://pirate.test/communities/${communityCreateBody.community.community_id}/listings`,
      {
        headers: {
          authorization: `Bearer ${owner.accessToken}`,
        },
      },
      ctx.env,
    )
    expect(listListings.status).toBe(200)
    const listingsBody = await json(listListings) as {
      items: Array<{ listing_id: string; status: string }>
    }
    expect(listingsBody.items).toHaveLength(1)
    expect(listingsBody.items[0]?.listing_id).toBe(createdListing.listing_id)
    expect(listingsBody.items[0]?.status).toBe("draft")

    const getListing = await app.request(
      `http://pirate.test/communities/${communityCreateBody.community.community_id}/listings/${createdListing.listing_id}`,
      {
        headers: {
          authorization: `Bearer ${owner.accessToken}`,
        },
      },
      ctx.env,
    )
    expect(getListing.status).toBe(200)

    const updateListing = await requestJson(
      `http://pirate.test/communities/${communityCreateBody.community.community_id}/listings/${createdListing.listing_id}`,
      {
        price_usd: 19.25,
        status: "active",
        regional_pricing_enabled: false,
      },
      ctx.env,
      owner.accessToken,
      "PATCH",
    )
    expect(updateListing.status).toBe(200)
    const updatedListing = await json(updateListing) as {
      listing_id: string
      status: string
      price_usd: number
      regional_pricing_enabled: boolean
    }
    expect(updatedListing.listing_id).toBe(createdListing.listing_id)
    expect(updatedListing.status).toBe("active")
    expect(updatedListing.price_usd).toBe(19.25)
    expect(updatedListing.regional_pricing_enabled).toBe(false)
  })

  test("community purchase settlement consumes an active quote and creates purchase records", async () => {
    const ctx = await createRouteTestContext()
    cleanup = ctx.cleanup

    const buyer = await exchangeJwt(ctx.env, "community-purchase-settlement-buyer")
    const namespaceVerificationId = await prepareVerifiedNamespace(ctx.env, buyer.accessToken)
    const communityCreate = await requestJson("http://pirate.test/communities", {
      display_name: "Pirate Purchase Settlement",
      namespace: {
        namespace_verification_id: namespaceVerificationId,
      },
    }, ctx.env, buyer.accessToken)
    expect(communityCreate.status).toBe(202)
    const communityCreateBody = await json(communityCreate) as {
      community: { community_id: string }
    }
    await setPrimaryWalletAttachment(
      ctx.env,
      buyer.userId,
      "0x1111111111111111111111111111111111111111",
    )
    await insertCommunityListing({
      communityDbRoot: ctx.communityDbRoot,
      communityId: communityCreateBody.community.community_id,
      listingId: "lst_settlement_1",
      createdByUserId: buyer.userId,
      assetId: "ast_settlement_1",
      priceUsd: "11.00",
    })

    const quoteResponse = await requestJson(
      `http://pirate.test/communities/${communityCreateBody.community.community_id}/purchase-quotes`,
      {
        listing_id: "lst_settlement_1",
        client_estimated_slippage_bps: 0,
        client_estimated_hop_count: 0,
      },
      ctx.env,
      buyer.accessToken,
    )
    expect(quoteResponse.status).toBe(200)
    const quoteBody = await json(quoteResponse) as { quote_id: string }

    const settlementResponse = await requestJson(
      `http://pirate.test/communities/${communityCreateBody.community.community_id}/purchase-settlements`,
      {
        quote_id: quoteBody.quote_id,
        settlement_wallet_attachment_id: `wal_${buyer.userId}`,
        settlement_tx_ref: "story:0xsettlement1",
      },
      ctx.env,
      buyer.accessToken,
    )
    expect(settlementResponse.status).toBe(200)
    const settlementBody = await json(settlementResponse) as {
      purchase_id: string
      quote_id: string
      buyer_user_id: string
      settlement_wallet_attachment_id: string
      settlement_tx_ref: string
      entitlement_kind: string
      entitlement_target_ref: string
    }
    expect(settlementBody.quote_id).toBe(quoteBody.quote_id)
    expect(settlementBody.buyer_user_id).toBe(buyer.userId)
    expect(settlementBody.settlement_wallet_attachment_id).toBe(`wal_${buyer.userId}`)
    expect(settlementBody.settlement_tx_ref).toBe("story:0xsettlement1")
    expect(settlementBody.entitlement_kind).toBe("asset_access")
    expect(settlementBody.entitlement_target_ref).toBe("ast_settlement_1")

    const persistedQuote = await readPurchaseQuoteRow({
      communityDbRoot: ctx.communityDbRoot,
      communityId: communityCreateBody.community.community_id,
      quoteId: quoteBody.quote_id,
    })
    expect(persistedQuote?.status).toBe("consumed")

    const purchaseRow = await readPurchaseRow({
      communityDbRoot: ctx.communityDbRoot,
      communityId: communityCreateBody.community.community_id,
      purchaseId: settlementBody.purchase_id,
    })
    expect(purchaseRow?.listing_id).toBe("lst_settlement_1")
    expect(purchaseRow?.buyer_user_id).toBe(buyer.userId)
    expect(purchaseRow?.settlement_wallet_attachment_id).toBe(`wal_${buyer.userId}`)
    expect(purchaseRow?.settlement_tx_ref).toBe("story:0xsettlement1")

    const entitlementRow = await readPurchaseEntitlementRow({
      communityDbRoot: ctx.communityDbRoot,
      communityId: communityCreateBody.community.community_id,
      purchaseId: settlementBody.purchase_id,
    })
    expect(entitlementRow?.entitlement_kind).toBe("asset_access")
    expect(entitlementRow?.target_ref).toBe("ast_settlement_1")
    expect(entitlementRow?.status).toBe("active")
  })

  test("community purchase settlement is blocked while an open rights review case exists", async () => {
    const ctx = await createRouteTestContext()
    cleanup = ctx.cleanup

    const buyer = await exchangeJwt(ctx.env, "community-purchase-settlement-rights-hold")
    const namespaceVerificationId = await prepareVerifiedNamespace(ctx.env, buyer.accessToken)
    const communityCreate = await requestJson("http://pirate.test/communities", {
      display_name: "Pirate Purchase Settlement Hold",
      namespace: {
        namespace_verification_id: namespaceVerificationId,
      },
    }, ctx.env, buyer.accessToken)
    expect(communityCreate.status).toBe(202)
    const communityCreateBody = await json(communityCreate) as {
      community: { community_id: string }
    }
    await setPrimaryWalletAttachment(
      ctx.env,
      buyer.userId,
      "0x1212121212121212121212121212121212121212",
    )
    await insertCommunityListing({
      communityDbRoot: ctx.communityDbRoot,
      communityId: communityCreateBody.community.community_id,
      listingId: "lst_settlement_hold_1",
      createdByUserId: buyer.userId,
      assetId: "ast_settlement_hold_1",
      priceUsd: "9.00",
    })

    const quoteResponse = await requestJson(
      `http://pirate.test/communities/${communityCreateBody.community.community_id}/purchase-quotes`,
      {
        listing_id: "lst_settlement_hold_1",
        client_estimated_slippage_bps: 0,
        client_estimated_hop_count: 0,
      },
      ctx.env,
      buyer.accessToken,
    )
    expect(quoteResponse.status).toBe(200)
    const quoteBody = await json(quoteResponse) as { quote_id: string }

    await insertOpenRightsReviewCase({
      communityDbRoot: ctx.communityDbRoot,
      communityId: communityCreateBody.community.community_id,
      subjectId: "ast_settlement_hold_1",
    })

    const settlementResponse = await requestJson(
      `http://pirate.test/communities/${communityCreateBody.community.community_id}/purchase-settlements`,
      {
        quote_id: quoteBody.quote_id,
        settlement_wallet_attachment_id: `wal_${buyer.userId}`,
        settlement_tx_ref: "story:0xsettlementhold1",
      },
      ctx.env,
      buyer.accessToken,
    )
    expect(settlementResponse.status).toBe(409)
    const settlementBody = await json(settlementResponse) as { code: string; message: string }
    expect(settlementBody.code).toBe("conflict")
    expect(settlementBody.message).toBe("Settlement is on hold pending rights review resolution")

    const persistedQuote = await readPurchaseQuoteRow({
      communityDbRoot: ctx.communityDbRoot,
      communityId: communityCreateBody.community.community_id,
      quoteId: quoteBody.quote_id,
    })
    expect(persistedQuote?.status).toBe("active")
  })

  test("community purchase settlement rejects consumed quotes and expires stale ones", async () => {
    const ctx = await createRouteTestContext()
    cleanup = ctx.cleanup

    const buyer = await exchangeJwt(ctx.env, "community-purchase-settlement-conflict-buyer")
    const namespaceVerificationId = await prepareVerifiedNamespace(ctx.env, buyer.accessToken)
    const communityCreate = await requestJson("http://pirate.test/communities", {
      display_name: "Pirate Purchase Settlement Conflicts",
      namespace: {
        namespace_verification_id: namespaceVerificationId,
      },
    }, ctx.env, buyer.accessToken)
    expect(communityCreate.status).toBe(202)
    const communityCreateBody = await json(communityCreate) as {
      community: { community_id: string }
    }
    await setPrimaryWalletAttachment(
      ctx.env,
      buyer.userId,
      "0x2222222222222222222222222222222222222222",
    )
    await insertCommunityListing({
      communityDbRoot: ctx.communityDbRoot,
      communityId: communityCreateBody.community.community_id,
      listingId: "lst_settlement_conflict_1",
      createdByUserId: buyer.userId,
      assetId: "ast_settlement_conflict_1",
      priceUsd: "6.00",
    })

    const firstQuoteResponse = await requestJson(
      `http://pirate.test/communities/${communityCreateBody.community.community_id}/purchase-quotes`,
      {
        listing_id: "lst_settlement_conflict_1",
        client_estimated_slippage_bps: 0,
        client_estimated_hop_count: 0,
      },
      ctx.env,
      buyer.accessToken,
    )
    expect(firstQuoteResponse.status).toBe(200)
    const firstQuoteBody = await json(firstQuoteResponse) as { quote_id: string }

    const firstSettlement = await requestJson(
      `http://pirate.test/communities/${communityCreateBody.community.community_id}/purchase-settlements`,
      {
        quote_id: firstQuoteBody.quote_id,
        settlement_wallet_attachment_id: `wal_${buyer.userId}`,
        settlement_tx_ref: "story:0xsettlement2",
      },
      ctx.env,
      buyer.accessToken,
    )
    expect(firstSettlement.status).toBe(200)

    const repeatedSettlement = await requestJson(
      `http://pirate.test/communities/${communityCreateBody.community.community_id}/purchase-settlements`,
      {
        quote_id: firstQuoteBody.quote_id,
        settlement_wallet_attachment_id: `wal_${buyer.userId}`,
        settlement_tx_ref: "story:0xsettlement2b",
      },
      ctx.env,
      buyer.accessToken,
    )
    expect(repeatedSettlement.status).toBe(409)
    const repeatedSettlementBody = await json(repeatedSettlement) as { code: string; message: string }
    expect(repeatedSettlementBody.code).toBe("conflict")
    expect(repeatedSettlementBody.message).toMatch(/already been consumed/)

    const secondQuoteResponse = await requestJson(
      `http://pirate.test/communities/${communityCreateBody.community.community_id}/purchase-quotes`,
      {
        listing_id: "lst_settlement_conflict_1",
        client_estimated_slippage_bps: 0,
        client_estimated_hop_count: 0,
      },
      ctx.env,
      buyer.accessToken,
    )
    expect(secondQuoteResponse.status).toBe(200)
    const secondQuoteBody = await json(secondQuoteResponse) as { quote_id: string }
    await expirePurchaseQuote({
      communityDbRoot: ctx.communityDbRoot,
      communityId: communityCreateBody.community.community_id,
      quoteId: secondQuoteBody.quote_id,
    })

    const expiredSettlement = await requestJson(
      `http://pirate.test/communities/${communityCreateBody.community.community_id}/purchase-settlements`,
      {
        quote_id: secondQuoteBody.quote_id,
        settlement_wallet_attachment_id: `wal_${buyer.userId}`,
        settlement_tx_ref: "story:0xsettlement3",
      },
      ctx.env,
      buyer.accessToken,
    )
    expect(expiredSettlement.status).toBe(409)
    const expiredSettlementBody = await json(expiredSettlement) as { code: string; message: string }
    expect(expiredSettlementBody.code).toBe("conflict")
    expect(expiredSettlementBody.message).toMatch(/has expired/)

    const expiredQuote = await readPurchaseQuoteRow({
      communityDbRoot: ctx.communityDbRoot,
      communityId: communityCreateBody.community.community_id,
      quoteId: secondQuoteBody.quote_id,
    })
    expect(expiredQuote?.status).toBe("expired")
  })

  test("buyers can list and fetch their settled purchases within a community", async () => {
    const ctx = await createRouteTestContext()
    cleanup = ctx.cleanup

    const buyer = await exchangeJwt(ctx.env, "community-purchase-read-buyer")
    const otherUser = await exchangeJwt(ctx.env, "community-purchase-read-other")
    const namespaceVerificationId = await prepareVerifiedNamespace(ctx.env, buyer.accessToken)
    const communityCreate = await requestJson("http://pirate.test/communities", {
      display_name: "Pirate Purchase Reads",
      namespace: {
        namespace_verification_id: namespaceVerificationId,
      },
    }, ctx.env, buyer.accessToken)
    expect(communityCreate.status).toBe(202)
    const communityCreateBody = await json(communityCreate) as {
      community: { community_id: string }
    }
    await setPrimaryWalletAttachment(
      ctx.env,
      buyer.userId,
      "0x3333333333333333333333333333333333333333",
    )
    await insertCommunityListing({
      communityDbRoot: ctx.communityDbRoot,
      communityId: communityCreateBody.community.community_id,
      listingId: "lst_purchase_reads_1",
      createdByUserId: buyer.userId,
      liveRoomId: "room_purchase_reads_1",
      priceUsd: "4.50",
    })

    const quoteResponse = await requestJson(
      `http://pirate.test/communities/${communityCreateBody.community.community_id}/purchase-quotes`,
      {
        listing_id: "lst_purchase_reads_1",
        client_estimated_slippage_bps: 0,
        client_estimated_hop_count: 0,
      },
      ctx.env,
      buyer.accessToken,
    )
    expect(quoteResponse.status).toBe(200)
    const quoteBody = await json(quoteResponse) as { quote_id: string }

    const settlementResponse = await requestJson(
      `http://pirate.test/communities/${communityCreateBody.community.community_id}/purchase-settlements`,
      {
        quote_id: quoteBody.quote_id,
        settlement_wallet_attachment_id: `wal_${buyer.userId}`,
        settlement_tx_ref: "story:0xsettlement4",
      },
      ctx.env,
      buyer.accessToken,
    )
    expect(settlementResponse.status).toBe(200)
    const settlementBody = await json(settlementResponse) as {
      purchase_id: string
      entitlement_kind: string
      entitlement_target_ref: string
    }

    const listPurchases = await app.request(
      `http://pirate.test/communities/${communityCreateBody.community.community_id}/purchases`,
      {
        headers: {
          authorization: `Bearer ${buyer.accessToken}`,
        },
      },
      ctx.env,
    )
    expect(listPurchases.status).toBe(200)
    const purchasesBody = await json(listPurchases) as {
      items: Array<{
        purchase_id: string
        entitlement_kind: string
        entitlement_target_ref: string
      }>
    }
    expect(purchasesBody.items).toHaveLength(1)
    expect(purchasesBody.items[0]?.purchase_id).toBe(settlementBody.purchase_id)
    expect(purchasesBody.items[0]?.entitlement_kind).toBe("live_room_access")
    expect(purchasesBody.items[0]?.entitlement_target_ref).toBe("room_purchase_reads_1")

    const getPurchase = await app.request(
      `http://pirate.test/communities/${communityCreateBody.community.community_id}/purchases/${settlementBody.purchase_id}`,
      {
        headers: {
          authorization: `Bearer ${buyer.accessToken}`,
        },
      },
      ctx.env,
    )
    expect(getPurchase.status).toBe(200)
    const purchaseBody = await json(getPurchase) as {
      purchase_id: string
      entitlement_kind: string
      entitlement_target_ref: string
    }
    expect(purchaseBody.purchase_id).toBe(settlementBody.purchase_id)
    expect(purchaseBody.entitlement_kind).toBe("live_room_access")
    expect(purchaseBody.entitlement_target_ref).toBe("room_purchase_reads_1")

    const otherBuyerGet = await app.request(
      `http://pirate.test/communities/${communityCreateBody.community.community_id}/purchases/${settlementBody.purchase_id}`,
      {
        headers: {
          authorization: `Bearer ${otherUser.accessToken}`,
        },
      },
      ctx.env,
    )
    expect(otherBuyerGet.status).toBe(404)
  })

  test("owner can list and approve pending membership requests for request-mode communities", async () => {
    const ctx = await createRouteTestContext()
    cleanup = ctx.cleanup

    const owner = await exchangeJwt(ctx.env, "community-request-owner")
    const namespaceVerificationId = await prepareVerifiedNamespace(ctx.env, owner.accessToken)
    const communityCreate = await requestJson("http://pirate.test/communities", {
      display_name: "Pirate Request Club",
      namespace: {
        namespace_verification_id: namespaceVerificationId,
      },
    }, ctx.env, owner.accessToken)
    expect(communityCreate.status).toBe(202)
    const communityCreateBody = await json(communityCreate) as {
      community: { community_id: string }
    }
    await setCommunityMembershipMode(ctx.communityDbRoot, communityCreateBody.community.community_id, "request")

    const requester = await exchangeJwt(ctx.env, "community-request-joiner")
    await completeUniqueHumanVerification(ctx.env, requester.accessToken)

    const requestedJoin = await app.request(
      `http://pirate.test/communities/${communityCreateBody.community.community_id}/join`,
      {
        method: "POST",
        headers: {
          authorization: `Bearer ${requester.accessToken}`,
        },
      },
      ctx.env,
    )
    expect(requestedJoin.status).toBe(200)
    const requestedJoinBody = await json(requestedJoin) as { community_id: string; status: string }
    expect(requestedJoinBody.community_id).toBe(communityCreateBody.community.community_id)
    expect(requestedJoinBody.status).toBe("requested")

    const pendingList = await app.request(
      `http://pirate.test/communities/${communityCreateBody.community.community_id}/membership-requests`,
      {
        headers: {
          authorization: `Bearer ${owner.accessToken}`,
        },
      },
      ctx.env,
    )
    expect(pendingList.status).toBe(200)
    const pendingListBody = await json(pendingList) as {
      membership_requests: Array<{ membership_request_id: string; applicant_user_id: string; status: string }>
    }
    expect(pendingListBody.membership_requests).toHaveLength(1)
    expect(pendingListBody.membership_requests[0]?.applicant_user_id).toBe(requester.userId)
    expect(pendingListBody.membership_requests[0]?.status).toBe("pending")

    const approved = await requestJson(
      `http://pirate.test/communities/${communityCreateBody.community.community_id}/membership-requests/${pendingListBody.membership_requests[0]?.membership_request_id}/approve`,
      {
        review_reason: "approved for testing",
      },
      ctx.env,
      owner.accessToken,
    )
    expect(approved.status).toBe(200)
    const approvedBody = await json(approved) as {
      applicant_user_id: string
      status: string
      reviewed_by_user_id: string | null
      review_reason: string | null
    }
    expect(approvedBody.applicant_user_id).toBe(requester.userId)
    expect(approvedBody.status).toBe("approved")
    expect(approvedBody.reviewed_by_user_id).toBe(owner.userId)
    expect(approvedBody.review_reason).toBe("approved for testing")

    const postAfterApproval = await requestJson(
      `http://pirate.test/communities/${communityCreateBody.community.community_id}/posts`,
      {
        post_type: "text",
        title: "Approved member post",
        body: "Request approval should create membership.",
        idempotency_key: "post-key-approved-request-member",
      },
      ctx.env,
      requester.accessToken,
    )
    expect(postAfterApproval.status).toBe(201)

    const emptyPendingList = await app.request(
      `http://pirate.test/communities/${communityCreateBody.community.community_id}/membership-requests`,
      {
        headers: {
          authorization: `Bearer ${owner.accessToken}`,
        },
      },
      ctx.env,
    )
    expect(emptyPendingList.status).toBe(200)
    const emptyPendingListBody = await json(emptyPendingList) as { membership_requests: unknown[] }
    expect(emptyPendingListBody.membership_requests).toEqual([])
  })

  test("non-moderators cannot review membership requests and moderators can approve them", async () => {
    const ctx = await createRouteTestContext()
    cleanup = ctx.cleanup

    const owner = await exchangeJwt(ctx.env, "community-request-owner-roles")
    const namespaceVerificationId = await prepareVerifiedNamespace(ctx.env, owner.accessToken)
    const communityCreate = await requestJson("http://pirate.test/communities", {
      display_name: "Pirate Moderation Club",
      namespace: {
        namespace_verification_id: namespaceVerificationId,
      },
    }, ctx.env, owner.accessToken)
    expect(communityCreate.status).toBe(202)
    const communityCreateBody = await json(communityCreate) as {
      community: { community_id: string }
    }
    await setCommunityMembershipMode(ctx.communityDbRoot, communityCreateBody.community.community_id, "request")

    const moderator = await exchangeJwt(ctx.env, "community-request-moderator")
    await addCommunityRole(ctx.communityDbRoot, communityCreateBody.community.community_id, moderator.userId, "moderator")

    const outsider = await exchangeJwt(ctx.env, "community-request-outsider")
    const requester = await exchangeJwt(ctx.env, "community-request-target")
    await completeUniqueHumanVerification(ctx.env, requester.accessToken)

    const requestedJoin = await app.request(
      `http://pirate.test/communities/${communityCreateBody.community.community_id}/join`,
      {
        method: "POST",
        headers: {
          authorization: `Bearer ${requester.accessToken}`,
        },
      },
      ctx.env,
    )
    expect(requestedJoin.status).toBe(200)

    const outsiderList = await app.request(
      `http://pirate.test/communities/${communityCreateBody.community.community_id}/membership-requests`,
      {
        headers: {
          authorization: `Bearer ${outsider.accessToken}`,
        },
      },
      ctx.env,
    )
    expect(outsiderList.status).toBe(403)
    const outsiderListBody = await json(outsiderList) as { code: string; message: string }
    expect(outsiderListBody.code).toBe("eligibility_failed")
    expect(outsiderListBody.message).toBe("Community moderation access is required")

    const moderatorList = await app.request(
      `http://pirate.test/communities/${communityCreateBody.community.community_id}/membership-requests`,
      {
        headers: {
          authorization: `Bearer ${moderator.accessToken}`,
        },
      },
      ctx.env,
    )
    expect(moderatorList.status).toBe(200)
    const moderatorListBody = await json(moderatorList) as {
      membership_requests: Array<{ membership_request_id: string }>
    }
    expect(moderatorListBody.membership_requests).toHaveLength(1)

    const approved = await requestJson(
      `http://pirate.test/communities/${communityCreateBody.community.community_id}/membership-requests/${moderatorListBody.membership_requests[0]?.membership_request_id}/approve`,
      {
        review_reason: "moderator approval",
      },
      ctx.env,
      moderator.accessToken,
    )
    expect(approved.status).toBe(200)
    const approvedBody = await json(approved) as { reviewed_by_user_id: string | null; status: string }
    expect(approvedBody.reviewed_by_user_id).toBe(moderator.userId)
    expect(approvedBody.status).toBe("approved")
  })

  test("rejected membership requests do not grant membership", async () => {
    const ctx = await createRouteTestContext()
    cleanup = ctx.cleanup

    const owner = await exchangeJwt(ctx.env, "community-request-reject-owner")
    const namespaceVerificationId = await prepareVerifiedNamespace(ctx.env, owner.accessToken)
    const communityCreate = await requestJson("http://pirate.test/communities", {
      display_name: "Pirate Reject Club",
      namespace: {
        namespace_verification_id: namespaceVerificationId,
      },
    }, ctx.env, owner.accessToken)
    expect(communityCreate.status).toBe(202)
    const communityCreateBody = await json(communityCreate) as {
      community: { community_id: string }
    }
    await setCommunityMembershipMode(ctx.communityDbRoot, communityCreateBody.community.community_id, "request")

    const requester = await exchangeJwt(ctx.env, "community-request-reject-target")
    await completeUniqueHumanVerification(ctx.env, requester.accessToken)

    const requestedJoin = await app.request(
      `http://pirate.test/communities/${communityCreateBody.community.community_id}/join`,
      {
        method: "POST",
        headers: {
          authorization: `Bearer ${requester.accessToken}`,
        },
      },
      ctx.env,
    )
    expect(requestedJoin.status).toBe(200)

    const pendingList = await app.request(
      `http://pirate.test/communities/${communityCreateBody.community.community_id}/membership-requests`,
      {
        headers: {
          authorization: `Bearer ${owner.accessToken}`,
        },
      },
      ctx.env,
    )
    expect(pendingList.status).toBe(200)
    const pendingListBody = await json(pendingList) as {
      membership_requests: Array<{ membership_request_id: string }>
    }
    expect(pendingListBody.membership_requests).toHaveLength(1)

    const rejected = await requestJson(
      `http://pirate.test/communities/${communityCreateBody.community.community_id}/membership-requests/${pendingListBody.membership_requests[0]?.membership_request_id}/reject`,
      {
        review_reason: "rejected for testing",
      },
      ctx.env,
      owner.accessToken,
    )
    expect(rejected.status).toBe(200)
    const rejectedBody = await json(rejected) as { status: string; review_reason: string | null }
    expect(rejectedBody.status).toBe("rejected")
    expect(rejectedBody.review_reason).toBe("rejected for testing")

    const deniedPost = await requestJson(
      `http://pirate.test/communities/${communityCreateBody.community.community_id}/posts`,
      {
        post_type: "text",
        title: "Rejected member post",
        body: "Rejected request should not create membership.",
        idempotency_key: "post-key-rejected-request-member",
      },
      ctx.env,
      requester.accessToken,
    )
    expect(deniedPost.status).toBe(404)
    const deniedBody = await json(deniedPost) as { code: string; message: string }
    expect(deniedBody.code).toBe("not_found")
    expect(deniedBody.message).toBe("Community not found")
  })

  test("post vote requires unique_human verification", async () => {
    const ctx = await createRouteTestContext()
    cleanup = ctx.cleanup

    const creator = await exchangeJwt(ctx.env, "community-vote-creator")
    const namespaceVerificationId = await prepareVerifiedNamespace(ctx.env, creator.accessToken)
    const communityCreate = await requestJson("http://pirate.test/communities", {
      display_name: "Pirate Voting Club",
      namespace: {
        namespace_verification_id: namespaceVerificationId,
      },
    }, ctx.env, creator.accessToken)
    expect(communityCreate.status).toBe(202)
    const communityCreateBody = await json(communityCreate) as {
      community: { community_id: string }
    }

    const createdPost = await requestJson(
      `http://pirate.test/communities/${communityCreateBody.community.community_id}/posts`,
      {
        post_type: "text",
        title: "Vote me",
        body: "A post to exercise vote gating.",
        idempotency_key: "vote-post-key-1",
      },
      ctx.env,
      creator.accessToken,
    )
    expect(createdPost.status).toBe(201)
    const postBody = await json(createdPost) as { post_id: string }

    const unverifiedMember = await exchangeJwt(ctx.env, "community-unverified-voter")
    await addCommunityMember(ctx.communityDbRoot, communityCreateBody.community.community_id, unverifiedMember.userId)

    const deniedVote = await requestJson(
      `http://pirate.test/posts/${postBody.post_id}/vote`,
      { value: 1 },
      ctx.env,
      unverifiedMember.accessToken,
    )
    expect(deniedVote.status).toBe(403)
    const deniedBody = await json(deniedVote) as { code: string; message: string }
    expect(deniedBody.code).toBe("verification_required")
    expect(deniedBody.message).toBe("unique_human verification is required")

    const verifiedMember = await exchangeJwt(ctx.env, "community-verified-voter")
    await completeUniqueHumanVerification(ctx.env, verifiedMember.accessToken)
    await addCommunityMember(ctx.communityDbRoot, communityCreateBody.community.community_id, verifiedMember.userId)

    const allowedVote = await requestJson(
      `http://pirate.test/posts/${postBody.post_id}/vote`,
      { value: 1 },
      ctx.env,
      verifiedMember.accessToken,
    )
    expect(allowedVote.status).toBe(200)
    const allowedBody = await json(allowedVote) as { post_id: string; value: number }
    expect(allowedBody.post_id).toBe(postBody.post_id)
    expect(allowedBody.value).toBe(1)

    const updatedVote = await requestJson(
      `http://pirate.test/posts/${postBody.post_id}/vote`,
      { value: -1 },
      ctx.env,
      verifiedMember.accessToken,
    )
    expect(updatedVote.status).toBe(200)
    const updatedBody = await json(updatedVote) as { post_id: string; value: number }
    expect(updatedBody.post_id).toBe(postBody.post_id)
    expect(updatedBody.value).toBe(-1)

    const listedPosts = await app.request(
      `http://pirate.test/communities/${communityCreateBody.community.community_id}/posts`,
      {
        headers: {
          authorization: `Bearer ${verifiedMember.accessToken}`,
        },
      },
      ctx.env,
    )
    expect(listedPosts.status).toBe(200)
    const listedPostsBody = await json(listedPosts) as {
      items: Array<{
        post: { post_id: string }
        upvote_count: number
        downvote_count: number
        like_count: number
        viewer_vote: number | null
      }>
    }
    expect(listedPostsBody.items).toHaveLength(1)
    expect(listedPostsBody.items[0]?.post.post_id).toBe(postBody.post_id)
    expect(listedPostsBody.items[0]?.upvote_count).toBe(0)
    expect(listedPostsBody.items[0]?.downvote_count).toBe(1)
    expect(listedPostsBody.items[0]?.like_count).toBe(0)
    expect(listedPostsBody.items[0]?.viewer_vote).toBe(-1)
  })
})
