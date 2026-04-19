import { afterEach, beforeEach, describe, expect, test } from "bun:test"
import { createRouteTestContext, json, resetRuntimeCaches } from "./helpers"
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

  test("anonymous post create returns 403 when anonymous posting is disabled", async () => {
    const ctx = await createRouteTestContext()
    cleanup = ctx.cleanup

    const session = await exchangeJwt(ctx.env, "community-anonymous-disabled")
    await completeUniqueHumanVerification(ctx.env, session.accessToken)

    const communityCreate = await requestJson("http://pirate.test/communities", {
      display_name: "Pirate Anonymous Disabled Club",
    }, ctx.env, session.accessToken)
    expect(communityCreate.status).toBe(202)
    const communityCreateBody = await json(communityCreate) as {
      community: { community_id: string }
    }

    await updateLocalCommunityAnonymousPolicy({
      allowAnonymousIdentity: false,
      anonymousIdentityScope: null,
      communityDbRoot: ctx.communityDbRoot,
      communityId: communityCreateBody.community.community_id,
    })

    const deniedPost = await requestJson(
      `http://pirate.test/communities/${communityCreateBody.community.community_id}/posts`,
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
    }, ctx.env, session.accessToken)
    expect(communityCreate.status).toBe(202)
    const communityCreateBody = await json(communityCreate) as {
      community: { community_id: string }
    }

    await updateLocalCommunityAnonymousPolicy({
      allowAnonymousIdentity: true,
      anonymousIdentityScope: "thread_stable",
      communityDbRoot: ctx.communityDbRoot,
      communityId: communityCreateBody.community.community_id,
    })

    const deniedPost = await requestJson(
      `http://pirate.test/communities/${communityCreateBody.community.community_id}/posts`,
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
    }, ctx.env, session.accessToken)
    expect(communityCreate.status).toBe(202)
    const communityCreateBody = await json(communityCreate) as {
      community: { community_id: string }
    }

    await updateLocalCommunityAnonymousPolicy({
      allowAnonymousIdentity: true,
      anonymousIdentityScope: "community_stable",
      communityDbRoot: ctx.communityDbRoot,
      communityId: communityCreateBody.community.community_id,
    })

    const createdPost = await requestJson(
      `http://pirate.test/communities/${communityCreateBody.community.community_id}/posts`,
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
      anonymous_label: string | null
      disclosed_qualifiers_json?: Array<{
        qualifier_template_id: string
        rendered_label: string
      }> | null
      identity_mode: string
    }
    expect(createdBody.identity_mode).toBe("anonymous")
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
  })
})
