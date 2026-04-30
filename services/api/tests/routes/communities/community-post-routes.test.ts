import { afterEach, beforeEach, describe, expect, test } from "bun:test"
import { app } from "../../../src/index"
import { createRouteTestContext, json, resetRuntimeCaches } from "../../helpers"
import {
  addCommunityMember,
  completeUniqueHumanVerification,
  exchangeJwt,
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

describe("community post routes", () => {
  test("OpenAI moderation leaves text and link posts alone and only blocks high-confidence visual sexual-minors", async () => {
    const ctx = await createRouteTestContext({
      OPENAI_API_KEY: "test-openai-key",
      OPENAI_MODERATION_BASE_URL: "https://openai.test/v1",
    })
    cleanup = ctx.cleanup

    const originalFetch = globalThis.fetch
    globalThis.fetch = async (input: RequestInfo | URL, init?: RequestInit): Promise<Response> => {
      const request = new Request(input, init)
      if (request.url !== "https://openai.test/v1/moderations") {
        return originalFetch(input, init)
      }

      const requestBody = await request.json() as { input?: unknown }
      const serializedInput = JSON.stringify(requestBody.input)
      const normalizedInput = serializedInput.toLowerCase()
      const categories: Record<string, boolean> = {
        sexual: normalizedInput.includes("post_image_test.gif"),
        "sexual/minors": normalizedInput.includes("post_image_minors_high.jpg") || normalizedInput.includes("video-cover-minors-high.jpg"),
        harassment: false,
        "harassment/threatening": false,
        hate: false,
        "hate/threatening": false,
        illicit: false,
        "illicit/violent": false,
        "self-harm": false,
        "self-harm/intent": false,
        "self-harm/instructions": false,
        violence: normalizedInput.includes("medical injury"),
        "violence/graphic": false,
      }
      const categoryScores = Object.fromEntries(Object.keys(categories).map((category) => [category, categories[category] ? 0.99 : 0.01]))
      if (normalizedInput.includes("post_image_minors_low.jpg")) {
        categories["sexual/minors"] = true
        categoryScores["sexual/minors"] = 0.8
      }
      return new Response(JSON.stringify({
        id: "modr_test",
        model: "omni-moderation-latest",
        results: [{
          flagged: Object.values(categories).some(Boolean),
          categories,
          category_scores: categoryScores,
        }],
      }), {
        headers: { "content-type": "application/json" },
      })
    }

    try {
      const session = await exchangeJwt(ctx.env, "community-openai-moderation-owner")
      const namespaceVerificationId = await prepareVerifiedNamespace(ctx.env, session.accessToken)

      const communityCreate = await requestJson("http://pirate.test/communities", {
        display_name: "Pirate OpenAI Moderation Club",
        namespace: {
          namespace_verification_id: namespaceVerificationId,
        },
      }, ctx.env, session.accessToken)
      expect(communityCreate.status).toBe(202)
      const communityCreateBody = await json(communityCreate) as {
        community: { community_id: string }
      }

      const textPost = await requestJson(
        `http://pirate.test/communities/${communityCreateBody.community.community_id}/posts`,
        {
          post_type: "text",
          title: "Medical injury update",
          body: "This should follow the graphic injury review policy.",
          idempotency_key: "post-key-openai-review",
        },
        ctx.env,
        session.accessToken,
      )
      expect(textPost.status).toBe(201)
      const textPostBody = await json(textPost) as {
        status: string
        analysis_state: string
        content_safety_state: string
      }
      expect(textPostBody.status).toBe("published")
      expect(textPostBody.analysis_state).toBe("allow")
      expect(textPostBody.content_safety_state).toBe("safe")

      const linkPost = await requestJson(
        `http://pirate.test/communities/${communityCreateBody.community.community_id}/posts`,
        {
          post_type: "link",
          title: "Medical injury resource",
          body: "This should follow the graphic injury review policy for link posts.",
          link_url: "https://example.test/injury-resource",
          idempotency_key: "post-key-openai-link-review",
        },
        ctx.env,
        session.accessToken,
      )
      expect(linkPost.status).toBe(201)
      const linkPostBody = await json(linkPost) as {
        status: string
        analysis_state: string
      }
      expect(linkPostBody.status).toBe("published")
      expect(linkPostBody.analysis_state).toBe("allow")

      const videoPostWithoutPoster = await requestJson(
        `http://pirate.test/communities/${communityCreateBody.community.community_id}/posts`,
        {
          post_type: "video",
          title: "Medical injury clip",
          media_refs: [{
            storage_ref: "http://pirate.test/community-media/post_video/post_video_test.mp4",
            mime_type: "video/mp4",
            size_bytes: 123,
          }],
          idempotency_key: "post-key-openai-video-review",
        },
        ctx.env,
        session.accessToken,
      )
      expect(videoPostWithoutPoster.status).toBe(201)
      const videoPostWithoutPosterBody = await json(videoPostWithoutPoster) as {
        status: string
        analysis_state: string
      }
      expect(videoPostWithoutPosterBody.status).toBe("published")
      expect(videoPostWithoutPosterBody.analysis_state).toBe("allow")

      const ordinarySexualImagePost = await requestJson(
        `http://pirate.test/communities/${communityCreateBody.community.community_id}/posts`,
        {
          post_type: "image",
          title: "Backstage",
          media_refs: [{
            storage_ref: "http://pirate.test/community-media/post_image/post_image_test.gif",
            mime_type: "image/gif",
            size_bytes: 12,
          }],
          idempotency_key: "post-key-openai-image-ordinary-sexual",
        },
        ctx.env,
        session.accessToken,
      )
      expect(ordinarySexualImagePost.status).toBe(201)
      const ordinarySexualImageBody = await json(ordinarySexualImagePost) as {
        status: string
        analysis_state: string
      }
      expect(ordinarySexualImageBody.status).toBe("published")
      expect(ordinarySexualImageBody.analysis_state).toBe("allow")

      const lowConfidenceSexualMinorsImagePost = await requestJson(
        `http://pirate.test/communities/${communityCreateBody.community.community_id}/posts`,
        {
          post_type: "image",
          title: "Backstage",
          media_refs: [{
            storage_ref: "http://pirate.test/community-media/post_image/post_image_minors_low.jpg",
            mime_type: "image/jpeg",
            size_bytes: 12,
          }],
          idempotency_key: "post-key-openai-image-minors-low",
        },
        ctx.env,
        session.accessToken,
      )
      expect(lowConfidenceSexualMinorsImagePost.status).toBe(201)

      const blockedImagePost = await requestJson(
        `http://pirate.test/communities/${communityCreateBody.community.community_id}/posts`,
        {
          post_type: "image",
          title: "Backstage",
          media_refs: [{
            storage_ref: "http://pirate.test/community-media/post_image/post_image_minors_high.jpg",
            mime_type: "image/jpeg",
            size_bytes: 12,
          }],
          idempotency_key: "post-key-openai-image-minors-high",
        },
        ctx.env,
        session.accessToken,
      )
      expect(blockedImagePost.status).toBe(422)
      const blockedBody = await json(blockedImagePost) as { code: string }
      expect(blockedBody.code).toBe("analysis_blocked")

      const blockedVideoPost = await requestJson(
        `http://pirate.test/communities/${communityCreateBody.community.community_id}/posts`,
        {
          post_type: "video",
          title: "Video",
          media_refs: [{
            storage_ref: "http://pirate.test/community-media/post_video/post_video_test_2.mp4",
            mime_type: "video/mp4",
            size_bytes: 123,
            poster_ref: "http://pirate.test/community-media/post_image/video-cover-minors-high.jpg",
            poster_mime_type: "image/jpeg",
          }],
          idempotency_key: "post-key-openai-video-poster-minors-high",
        },
        ctx.env,
        session.accessToken,
      )
      expect(blockedVideoPost.status).toBe(422)
    } finally {
      globalThis.fetch = originalFetch
    }
  })

  test("OpenAI moderation respects disabled image scanning", async () => {
    const ctx = await createRouteTestContext({
      OPENAI_API_KEY: "test-openai-key",
      OPENAI_MODERATION_BASE_URL: "https://openai.test/v1",
    })
    cleanup = ctx.cleanup

    const moderationInputs: unknown[] = []
    const originalFetch = globalThis.fetch
    globalThis.fetch = async (input: RequestInfo | URL, init?: RequestInit): Promise<Response> => {
      const request = new Request(input, init)
      if (request.url !== "https://openai.test/v1/moderations") {
        return originalFetch(input, init)
      }

      const requestBody = await request.json() as { input?: unknown }
      moderationInputs.push(requestBody.input)
      const categories: Record<string, boolean> = {
        sexual: false,
        "sexual/minors": true,
        harassment: false,
        "harassment/threatening": false,
        hate: false,
        "hate/threatening": false,
        illicit: false,
        "illicit/violent": false,
        "self-harm": false,
        "self-harm/intent": false,
        "self-harm/instructions": false,
        violence: false,
        "violence/graphic": false,
      }
      return new Response(JSON.stringify({
        id: "modr_test",
        model: "omni-moderation-latest",
        results: [{
          flagged: Object.values(categories).some(Boolean),
          categories,
          category_scores: Object.fromEntries(Object.keys(categories).map((category) => [category, categories[category] ? 0.99 : 0.01])),
        }],
      }), {
        headers: { "content-type": "application/json" },
      })
    }

    try {
      const session = await exchangeJwt(ctx.env, "community-openai-disabled-body-owner")
      const namespaceVerificationId = await prepareVerifiedNamespace(ctx.env, session.accessToken)

      const communityCreate = await requestJson("http://pirate.test/communities", {
        display_name: "Pirate OpenAI Disabled Body Club",
        namespace: {
          namespace_verification_id: namespaceVerificationId,
        },
      }, ctx.env, session.accessToken)
      expect(communityCreate.status).toBe(202)
      const communityCreateBody = await json(communityCreate) as {
        community: { community_id: string }
      }

      const safetyUpdate = await app.request(
        `http://pirate.test/communities/${communityCreateBody.community.community_id}/safety`,
        {
          method: "PUT",
          headers: {
            "content-type": "application/json",
            authorization: `Bearer ${session.accessToken}`,
          },
          body: JSON.stringify({
            adult_content_policy: {
              suggestive: "review",
              artistic_nudity: "allow",
              explicit_nudity: "disallow",
              explicit_sexual_content: "disallow",
              fetish_content: "review",
            },
            graphic_content_policy: {
              injury_medical: "review",
              gore: "review",
              extreme_gore: "disallow",
              body_horror_disturbing: "review",
              animal_harm: "disallow",
            },
            civility_policy: {
              group_directed_demeaning_language: "review",
              targeted_insults: "review",
              targeted_harassment: "disallow",
              threatening_language: "disallow",
            },
            openai_moderation_settings: {
              scan_titles: true,
              scan_post_bodies: true,
              scan_captions: true,
              scan_link_preview_text: true,
              scan_images: false,
            },
          }),
        },
        ctx.env,
      )
      expect(safetyUpdate.status).toBe(200)

      const createdPost = await requestJson(
        `http://pirate.test/communities/${communityCreateBody.community.community_id}/posts`,
        {
          post_type: "image",
          title: "Clean title",
          media_refs: [{
            storage_ref: "http://pirate.test/community-media/post_image/post_image_minors_high.jpg",
            mime_type: "image/jpeg",
            size_bytes: 12,
          }],
          idempotency_key: "post-key-openai-disabled-body",
        },
        ctx.env,
        session.accessToken,
      )
      expect(createdPost.status).toBe(201)
      const createdBody = await json(createdPost) as { status: string; analysis_state: string }
      expect(createdBody.status).toBe("published")
      expect(createdBody.analysis_state).toBe("allow")
      expect(moderationInputs).toHaveLength(0)
    } finally {
      globalThis.fetch = originalFetch
    }
  })

  test("post create allows members without hidden unique_human verification", async () => {
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
        title: "Member post",
        body: "Membership is sufficient when no hidden verification check applies.",
        idempotency_key: "post-key-unverified-member",
      },
      ctx.env,
      unverifiedMember.accessToken,
    )

    expect(deniedPost.status).toBe(201)
    const postBody = await json(deniedPost) as { title: string | null }
    expect(postBody.title).toBe("Member post")
  })

  test("community post feed marks creator posts with owner role", async () => {
    const ctx = await createRouteTestContext()
    cleanup = ctx.cleanup

    const creator = await exchangeJwt(ctx.env, "community-owner-role-creator")
    const namespaceVerificationId = await prepareVerifiedNamespace(ctx.env, creator.accessToken)

    const communityCreate = await requestJson("http://pirate.test/communities", {
      display_name: "Pirate Owner Badge Club",
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
        title: "Owner post",
        body: "The creator should render with the owner badge.",
        idempotency_key: "post-key-owner-role",
      },
      ctx.env,
      creator.accessToken,
    )
    expect(createdPost.status).toBe(201)

    const feed = await app.request(
      `http://pirate.test/communities/${communityCreateBody.community.community_id}/posts`,
      { headers: { authorization: `Bearer ${creator.accessToken}` } },
      ctx.env,
    )
    expect(feed.status).toBe(200)
    const feedBody = await json(feed) as {
      items: Array<{ author_community_role?: "owner" | "moderator" | null; post: { title: string | null } }>
    }
    expect(feedBody.items.find((item) => item.post.title === "Owner post")?.author_community_role).toBe("owner")
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

  test("image post create stores image media refs", async () => {
    const ctx = await createRouteTestContext()
    cleanup = ctx.cleanup

    const session = await exchangeJwt(ctx.env, "community-image-post")
    const namespaceVerificationId = await prepareVerifiedNamespace(ctx.env, session.accessToken)

    const communityCreate = await requestJson("http://pirate.test/communities", {
      display_name: "Pirate Images Club",
      namespace: {
        namespace_verification_id: namespaceVerificationId,
      },
    }, ctx.env, session.accessToken)
    expect(communityCreate.status).toBe(202)
    const communityCreateBody = await json(communityCreate) as {
      community: { community_id: string }
    }

    const createdPost = await requestJson(
      `http://pirate.test/communities/${communityCreateBody.community.community_id}/posts`,
      {
        post_type: "image",
        title: "Backstage",
        caption: "Right before the set.",
        media_refs: [{
          storage_ref: "http://pirate.test/community-media/post_image/post_image_test.gif",
          mime_type: "image/gif",
          size_bytes: 12,
        }],
        idempotency_key: "post-key-image-create",
      },
      ctx.env,
      session.accessToken,
    )

    expect(createdPost.status).toBe(201)
    const postBody = await json(createdPost) as {
      post_type: string
      title?: string | null
      caption?: string | null
      media_refs?: Array<{ storage_ref: string; mime_type?: string | null; size_bytes?: number | null }>
    }
    expect(postBody.post_type).toBe("image")
    expect(postBody.title).toBe("Backstage")
    expect(postBody.caption).toBe("Right before the set.")
    expect(postBody.media_refs?.[0]).toEqual({
      storage_ref: "http://pirate.test/community-media/post_image/post_image_test.gif",
      mime_type: "image/gif",
      size_bytes: 12,
    })
  })

  test("image post create returns 400 when media refs are missing", async () => {
    const ctx = await createRouteTestContext()
    cleanup = ctx.cleanup

    const session = await exchangeJwt(ctx.env, "community-image-post-invalid")
    const namespaceVerificationId = await prepareVerifiedNamespace(ctx.env, session.accessToken)

    const communityCreate = await requestJson("http://pirate.test/communities", {
      display_name: "Pirate Broken Images Club",
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
        post_type: "image",
        title: "Missing image",
        idempotency_key: "post-key-image-missing-media",
      },
      ctx.env,
      session.accessToken,
    )

    expect(deniedPost.status).toBe(400)
    const deniedBody = await json(deniedPost) as { code: string; message: string }
    expect(deniedBody.code).toBe("bad_request")
    expect(deniedBody.message).toBe("media_refs is required for image posts")
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



  test("post vote requires membership but not hidden unique_human verification", async () => {
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

    const allowedVote = await requestJson(
      `http://pirate.test/posts/${postBody.post_id}/vote`,
      { value: 1 },
      ctx.env,
      unverifiedMember.accessToken,
    )
    expect(allowedVote.status).toBe(200)
    const allowedBody = await json(allowedVote) as { post_id: string; value: number }
    expect(allowedBody.post_id).toBe(postBody.post_id)
    expect(allowedBody.value).toBe(1)

    const updatedVote = await requestJson(
      `http://pirate.test/posts/${postBody.post_id}/vote`,
      { value: -1 },
      ctx.env,
      unverifiedMember.accessToken,
    )
    expect(updatedVote.status).toBe(200)
    const updatedBody = await json(updatedVote) as { post_id: string; value: number }
    expect(updatedBody.post_id).toBe(postBody.post_id)
    expect(updatedBody.value).toBe(-1)

    const listedPosts = await app.request(
      `http://pirate.test/communities/${communityCreateBody.community.community_id}/posts`,
      {
        headers: {
          authorization: `Bearer ${unverifiedMember.accessToken}`,
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
