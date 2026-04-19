import { afterEach, beforeEach, describe, expect, test } from "bun:test"
import { createClient } from "@libsql/client"
import app from "../src/index"
import { buildLocalCommunityDbUrl } from "../src/lib/communities/community-local-db"
import { createRouteTestContext, json, resetRuntimeCaches } from "./helpers"
import {
  addCommunityMember,
  completeUniqueHumanVerification,
  exchangeJwt,
  getCommunityControlPlaneState,
  prepareVerifiedNamespace,
  requestJson,
} from "./community-routes-test-helpers"

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
  test("community create succeeds without a namespace and can attach one later", async () => {
    const ctx = await createRouteTestContext()
    cleanup = ctx.cleanup

    const session = await exchangeJwt(ctx.env, "community-optional-namespace-user")
    await completeUniqueHumanVerification(ctx.env, session.accessToken)

    const communityCreate = await requestJson("http://pirate.test/communities", {
      display_name: "Namespace Later Club",
      handle_policy: {
        policy_template: "standard",
      },
    }, ctx.env, session.accessToken)
    expect(communityCreate.status).toBe(202)
    const communityCreateBody = await json(communityCreate) as {
      community: {
        community_id: string
        namespace_verification_id: string | null
        route_slug: string | null
      }
    }
    expect(communityCreateBody.community.namespace_verification_id).toBeNull()
    expect(communityCreateBody.community.route_slug).toBeNull()

    const createdState = await getCommunityControlPlaneState(ctx.env, communityCreateBody.community.community_id)
    expect(createdState.namespaceVerificationId).toBeNull()
    expect(createdState.routeSlug).toBeNull()

    const namespaceVerificationId = await prepareVerifiedNamespace(ctx.env, session.accessToken)
    const attachResponse = await requestJson(
      `http://pirate.test/communities/${communityCreateBody.community.community_id}/namespace`,
      {
        namespace_verification_id: namespaceVerificationId,
      },
      ctx.env,
      session.accessToken,
    )
    expect(attachResponse.status).toBe(200)
    const attachedCommunity = await json(attachResponse) as {
      community_id: string
      namespace_verification_id: string | null
      route_slug: string | null
    }
    expect(attachedCommunity.namespace_verification_id).toBe(namespaceVerificationId)
    expect(attachedCommunity.route_slug).toBe("piratecommunityroot")

    const attachedState = await getCommunityControlPlaneState(ctx.env, communityCreateBody.community.community_id)
    expect(attachedState.namespaceVerificationId).toBe(namespaceVerificationId)
    expect(attachedState.routeSlug).toBe("piratecommunityroot")

    const communityBySlug = await app.request(`http://pirate.test/communities/piratecommunityroot`, {
      headers: {
        authorization: `Bearer ${session.accessToken}`,
      },
    }, ctx.env)
    expect(communityBySlug.status).toBe(200)
    const communityBySlugBody = await json(communityBySlug) as { community_id: string; route_slug: string | null }
    expect(communityBySlugBody.community_id).toBe(communityCreateBody.community.community_id)
    expect(communityBySlugBody.route_slug).toBe("piratecommunityroot")

    const previewBySlug = await app.request(`http://pirate.test/communities/piratecommunityroot/preview`, {
      headers: {
        authorization: `Bearer ${session.accessToken}`,
      },
    }, ctx.env)
    expect(previewBySlug.status).toBe(200)

    const eligibilityBySlug = await app.request(`http://pirate.test/communities/piratecommunityroot/join-eligibility`, {
      headers: {
        authorization: `Bearer ${session.accessToken}`,
      },
    }, ctx.env)
    expect(eligibilityBySlug.status).toBe(200)

    const postsBySlug = await app.request(`http://pirate.test/communities/piratecommunityroot/posts`, {
      headers: {
        authorization: `Bearer ${session.accessToken}`,
      },
    }, ctx.env)
    expect(postsBySlug.status).toBe(200)
  })

  test("public community routes return preview and published posts without auth", async () => {
    const ctx = await createRouteTestContext()
    cleanup = ctx.cleanup

    const session = await exchangeJwt(ctx.env, "community-public-preview-user")
    await completeUniqueHumanVerification(ctx.env, session.accessToken)
    const namespaceVerificationId = await prepareVerifiedNamespace(ctx.env, session.accessToken)

    const communityCreate = await requestJson("http://pirate.test/communities", {
      display_name: "Public Community Club",
      description: "Readable without reconnecting.",
      namespace: {
        namespace_verification_id: namespaceVerificationId,
      },
    }, ctx.env, session.accessToken)
    expect(communityCreate.status).toBe(202)
    const communityCreateBody = await json(communityCreate) as {
      community: {
        community_id: string
        route_slug: string | null
      }
    }

    const createdPost = await requestJson(
      `http://pirate.test/communities/${communityCreateBody.community.community_id}/posts`,
      {
        post_type: "text",
        title: "Public route post",
        body: "This should be visible without a session.",
        idempotency_key: "post-key-public-community-route",
      },
      ctx.env,
      session.accessToken,
    )
    expect(createdPost.status).toBe(201)
    const createdPostBody = await json(createdPost) as {
      post_id: string
      title: string | null
    }
    expect(createdPostBody.title).toBe("Public route post")

    const secondPost = await requestJson(
      `http://pirate.test/communities/${communityCreateBody.community.community_id}/posts`,
      {
        post_type: "text",
        title: "Second public route post",
        body: "This should stay visible alongside the first post.",
        idempotency_key: "post-key-public-community-route-2",
      },
      ctx.env,
      session.accessToken,
    )
    expect(secondPost.status).toBe(201)
    const secondPostBody = await json(secondPost) as {
      post_id: string
      title: string | null
    }
    expect(secondPostBody.title).toBe("Second public route post")

    const preview = await app.request(
      `http://pirate.test/public-communities/${communityCreateBody.community.route_slug ?? communityCreateBody.community.community_id}`,
      {},
      ctx.env,
    )
    expect(preview.status).toBe(200)
    const previewBody = await json(preview) as {
      community_id: string
      display_name: string
      description: string | null
      viewer_membership_status: string | null
    }
    expect(previewBody.community_id).toBe(communityCreateBody.community.community_id)
    expect(previewBody.display_name).toBe("Public Community Club")
    expect(previewBody.description).toBe("Readable without reconnecting.")
    expect(previewBody.viewer_membership_status).toBe("not_member")

    const posts = await app.request(
      `http://pirate.test/public-communities/${communityCreateBody.community.route_slug ?? communityCreateBody.community.community_id}/posts`,
      {},
      ctx.env,
    )
    expect(posts.status).toBe(200)
    const postsBody = await json(posts) as {
      items: Array<{ post: { post_id: string; title: string | null } }>
      next_cursor: string | null
    }
    expect(postsBody.items).toHaveLength(2)
    expect(postsBody.items[0]?.post.post_id).toBe(secondPostBody.post_id)
    expect(postsBody.items[0]?.post.title).toBe("Second public route post")
    expect(postsBody.items[1]?.post.post_id).toBe(createdPostBody.post_id)
    expect(postsBody.items[1]?.post.title).toBe("Public route post")
    expect(postsBody.next_cursor).toBeNull()

    const publicPost = await app.request(
      `http://pirate.test/public-posts/${createdPostBody.post_id}?locale=zh-Hans`,
      {},
      ctx.env,
    )
    expect(publicPost.status).toBe(200)
    const publicPostBody = await json(publicPost) as {
      post: { post_id: string; title: string | null }
      resolved_locale: string
      translation_state: string
    }
    expect(publicPostBody.post.post_id).toBe(createdPostBody.post_id)
    expect(publicPostBody.post.title).toBe("Public route post")
    expect(publicPostBody.resolved_locale).toBe("zh-Hans")
    expect(publicPostBody.translation_state).toBe("policy_blocked")
  })

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
        display_name: string
        namespace_verification_id: string | null
        route_slug: string | null
        provisioning_state: string
        status: string
      }
      job: { job_id: string; status: string }
    }
    expect(communityCreateBody.community.display_name).toBe("Pirate Test Club")
    expect(communityCreateBody.community.namespace_verification_id).toBe(namespaceVerificationId)
    expect(communityCreateBody.community.route_slug).toBe("piratecommunityroot")
    expect(communityCreateBody.community.provisioning_state).toBe("active")
    expect(communityCreateBody.community.status).toBe("active")
    expect(communityCreateBody.job.status).toBe("succeeded")

    const communityBySlug = await Promise.resolve(app.request(
      "http://pirate.test/communities/piratecommunityroot",
      {
        headers: {
          authorization: `Bearer ${session.accessToken}`,
        },
      },
      ctx.env,
    ))
    expect(communityBySlug.status).toBe(200)

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
    expect(fetchedPostBody.translation_state).toBe("policy_blocked")

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
      translation_state: string
    }
    expect(fetchedReviewHeldPostBody.post.post_id).toBe(reviewHeldPostBody.post_id)
    expect(fetchedReviewHeldPostBody.post.status).toBe("draft")
    expect(fetchedReviewHeldPostBody.post.analysis_state).toBe("review_required")
    expect(fetchedReviewHeldPostBody.post.content_safety_state).toBe("pending")
    expect(fetchedReviewHeldPostBody.resolved_locale).toBe("es")
    expect(fetchedReviewHeldPostBody.translation_state).toBe("policy_blocked")

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
