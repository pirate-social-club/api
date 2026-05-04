import { afterEach, beforeEach, describe, expect, test } from "bun:test"
import { app } from "../../../src/index"
import { createRouteTestContext, json, resetRuntimeCaches } from "../../helpers"
import {
  addCommunityMember,
  completeUniqueHumanVerification,
  exchangeJwt,
  prepareVerifiedNamespace,
  requestJson,
  updateLocalCommunityAnonymousPolicy,
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

describe("community anonymous post routes", () => {
  test("anonymous post create still requires anonymous posting to be enabled", async () => {
    const ctx = await createRouteTestContext()
    cleanup = ctx.cleanup

    const verifiedCreator = await exchangeJwt(ctx.env, "community-anon-verified-creator")
    const namespaceVerificationId = await prepareVerifiedNamespace(ctx.env, verifiedCreator.accessToken)

    const communityCreate = await requestJson("http://pirate.test/communities", {
      display_name: "Pirate Anonymous Posting Club",
membership_mode: "request",
      namespace: {
        namespace_verification: namespaceVerificationId,
      },
    }, ctx.env, verifiedCreator.accessToken)
    expect(communityCreate.status).toBe(202)
    const communityCreateBody = await json(communityCreate) as {
      community: { id: string }
    }

    const unverifiedMember = await exchangeJwt(ctx.env, "community-anon-unverified-member")
    await addCommunityMember(
      ctx.communityDbRoot,
      communityCreateBody.community.id.replace(/^com_/, ""),
      unverifiedMember.userId,
    )
    const deniedPost = await requestJson(
      `http://pirate.test/communities/${communityCreateBody.community.id.replace(/^com_/, "")}/posts`,
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
    expect(deniedBody.code).toBe("eligibility_failed")
    expect(deniedBody.message).toBe("Anonymous posts are not enabled in this community")
  })

  test("anonymous post create returns 400 when anonymous_scope is missing", async () => {
    const ctx = await createRouteTestContext()
    cleanup = ctx.cleanup

    const session = await exchangeJwt(ctx.env, "community-anonymous-validation")
    const namespaceVerificationId = await prepareVerifiedNamespace(ctx.env, session.accessToken)

    const communityCreate = await requestJson("http://pirate.test/communities", {
      display_name: "Pirate Anonymous Club",
membership_mode: "request",
      namespace: {
        namespace_verification: namespaceVerificationId,
      },
    }, ctx.env, session.accessToken)
    expect(communityCreate.status).toBe(202)
    const communityCreateBody = await json(communityCreate) as {
      community: { id: string }
    }

    const deniedPost = await requestJson(
      `http://pirate.test/communities/${communityCreateBody.community.id.replace(/^com_/, "")}/posts`,
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

  test("anonymous post create returns 403 when anonymous posting is disabled", async () => {
    const ctx = await createRouteTestContext()
    cleanup = ctx.cleanup

    const session = await exchangeJwt(ctx.env, "community-anonymous-disabled")
    await completeUniqueHumanVerification(ctx.env, session.accessToken)

    const communityCreate = await requestJson("http://pirate.test/communities", {
      display_name: "Pirate Anonymous Disabled Club",
membership_mode: "request",
    }, ctx.env, session.accessToken)
    expect(communityCreate.status).toBe(202)
    const communityCreateBody = await json(communityCreate) as {
      community: { id: string }
    }

    await updateLocalCommunityAnonymousPolicy({
      allowAnonymousIdentity: false,
      anonymousIdentityScope: null,
      communityDbRoot: ctx.communityDbRoot,
      communityId: communityCreateBody.community.id.replace(/^com_/, ""),
    })

    const deniedPost = await requestJson(
      `http://pirate.test/communities/${communityCreateBody.community.id.replace(/^com_/, "")}/posts`,
      {
        post_type: "text",
        identity_mode: "anonymous",
        anonymous_scope: "community_stable",
        title: "Anonymous Disabled",
        body: "This should fail when anonymous posting is disabled.",
        idempotency_key: "post-key-anonymous-disabled",
      },
      ctx.env,
      session.accessToken,
    )

    expect(deniedPost.status).toBe(403)
    const deniedBody = await json(deniedPost) as { code: string; message: string }
    expect(deniedBody.code).toBe("eligibility_failed")
    expect(deniedBody.message).toBe("Anonymous posts are not enabled in this community")
  })

  test("anonymous post create returns 400 when anonymous_scope mismatches community policy", async () => {
    const ctx = await createRouteTestContext()
    cleanup = ctx.cleanup

    const session = await exchangeJwt(ctx.env, "community-anonymous-scope-mismatch")
    await completeUniqueHumanVerification(ctx.env, session.accessToken)

    const communityCreate = await requestJson("http://pirate.test/communities", {
      display_name: "Pirate Anonymous Scope Club",
membership_mode: "request",
    }, ctx.env, session.accessToken)
    expect(communityCreate.status).toBe(202)
    const communityCreateBody = await json(communityCreate) as {
      community: { id: string }
    }

    await updateLocalCommunityAnonymousPolicy({
      allowAnonymousIdentity: true,
      anonymousIdentityScope: "thread_stable",
      communityDbRoot: ctx.communityDbRoot,
      communityId: communityCreateBody.community.id.replace(/^com_/, ""),
    })

    const deniedPost = await requestJson(
      `http://pirate.test/communities/${communityCreateBody.community.id.replace(/^com_/, "")}/posts`,
      {
        post_type: "text",
        identity_mode: "anonymous",
        anonymous_scope: "community_stable",
        title: "Anonymous Scope Mismatch",
        body: "This should fail when the requested scope does not match policy.",
        idempotency_key: "post-key-anonymous-scope-mismatch",
      },
      ctx.env,
      session.accessToken,
    )

    expect(deniedPost.status).toBe(400)
    const deniedBody = await json(deniedPost) as { code: string; message: string }
    expect(deniedBody.code).toBe("bad_request")
    expect(deniedBody.message).toBe("anonymous_scope does not match the community policy")
  })

  test("anonymous post create stores generated labels and disclosed qualifier snapshots", async () => {
    const ctx = await createRouteTestContext()
    cleanup = ctx.cleanup

    const session = await exchangeJwt(ctx.env, "community-anonymous-qualifier-snapshots")
    await completeUniqueHumanVerification(ctx.env, session.accessToken)

    const communityCreate = await requestJson("http://pirate.test/communities", {
      display_name: "Pirate Anonymous Snapshot Club",
membership_mode: "request",
    }, ctx.env, session.accessToken)
    expect(communityCreate.status).toBe(202)
    const communityCreateBody = await json(communityCreate) as {
      community: { id: string }
    }
    const communityId = communityCreateBody.community.id.replace(/^com_/, "")

    await updateLocalCommunityAnonymousPolicy({
      allowAnonymousIdentity: true,
      anonymousIdentityScope: "community_stable",
      communityDbRoot: ctx.communityDbRoot,
      communityId,
    })

    const createdPost = await requestJson(
      `http://pirate.test/communities/${communityId}/posts`,
      {
        post_type: "text",
        identity_mode: "anonymous",
        anonymous_scope: "community_stable",
        disclosed_qualifier_ids: ["unique_human", "age_over_18"],
        title: "Anonymous Snapshot",
        body: "Anonymous posts should persist a generated label and qualifier labels.",
        idempotency_key: "post-key-anonymous-snapshot",
      },
      ctx.env,
      session.accessToken,
    )

    expect(createdPost.status).toBe(201)
    const createdBody = await json(createdPost) as {
      id: string
      anonymous_label: string | null
      author_user: string | null
      disclosed_qualifiers_json?: Array<{
        qualifier_template_id: string
        rendered_label: string
      }> | null
      identity_mode: string
    }
    expect(createdBody.identity_mode).toBe("anonymous")
    expect(createdBody.author_user).toBeNull()
    expect(createdBody.anonymous_label).toMatch(/^anon_[a-z]+-[a-z]+-\d{2}$/)
    expect(createdBody.anonymous_label).not.toBe("anonymous")
    expect(createdBody.disclosed_qualifiers_json?.map((entry) => entry.qualifier_template_id)).toEqual([
      "unique_human",
      "age_over_18",
    ])
    expect(createdBody.disclosed_qualifiers_json?.map((entry) => entry.rendered_label)).toEqual([
      "Unique Human",
      "18+",
    ])

    const authorRead = await app.request(`http://pirate.test/posts/${createdBody.id}`, {
      headers: {
        authorization: `Bearer ${session.accessToken}`,
      },
    }, ctx.env)
    expect(authorRead.status).toBe(200)
    const authorReadBody = await json(authorRead) as {
      post: { author_user: string | null; identity_mode: string }
      viewer_is_author?: boolean
    }
    expect(authorReadBody.post.identity_mode).toBe("anonymous")
    expect(authorReadBody.post.author_user).toBeNull()
    expect(authorReadBody.viewer_is_author).toBe(true)

    const otherMember = await exchangeJwt(ctx.env, "community-anonymous-other-reader")
    await addCommunityMember(ctx.communityDbRoot, communityId, otherMember.userId)
    const otherRead = await app.request(`http://pirate.test/posts/${createdBody.id}`, {
      headers: {
        authorization: `Bearer ${otherMember.accessToken}`,
      },
    }, ctx.env)
    expect(otherRead.status).toBe(200)
    const otherReadBody = await json(otherRead) as {
      post: { author_user: string | null; identity_mode: string }
      viewer_is_author?: boolean
    }
    expect(otherReadBody.post.identity_mode).toBe("anonymous")
    expect(otherReadBody.post.author_user).toBeNull()
    expect(otherReadBody.viewer_is_author).toBe(false)

    const authorFeed = await app.request(`http://pirate.test/communities/${communityId}/posts`, {
      headers: {
        authorization: `Bearer ${session.accessToken}`,
      },
    }, ctx.env)
    expect(authorFeed.status).toBe(200)
    const authorFeedBody = await json(authorFeed) as {
      items: Array<{
        post: { id: string; author_user: string | null; identity_mode: string }
        viewer_is_author?: boolean
      }>
    }
    expect(authorFeedBody.items[0]?.post.id).toBe(createdBody.id)
    expect(authorFeedBody.items[0]?.post.identity_mode).toBe("anonymous")
    expect(authorFeedBody.items[0]?.post.author_user).toBeNull()
    expect(authorFeedBody.items[0]?.viewer_is_author).toBe(true)
  })
})
