import { afterEach, beforeEach, describe, expect, test } from "bun:test"
import { createClient } from "@libsql/client"
import { app } from "../../../src/index"
import { buildLocalCommunityDbUrl } from "../../../src/lib/communities/community-local-db"
import { createRouteTestContext, json, resetRuntimeCaches } from "../../helpers"
import {
  addCommunityMember,
  completeUniqueHumanVerification,
  exchangeJwt,
  prepareVerifiedNamespace,
  requestJson,
} from "./community-routes-test-helpers"

let cleanup: (() => Promise<void>) | null = null

function settingsJson(body: Record<string, unknown>): string {
  return JSON.stringify(body)
}

async function grantCommunityRole(input: {
  communityDbRoot: string
  communityId: string
  userId: string
  role: "owner" | "admin" | "moderator"
}): Promise<void> {
  const client = createClient({
    url: buildLocalCommunityDbUrl(input.communityDbRoot, input.communityId),
  })
  try {
    const now = new Date().toISOString()
    await client.execute({
      sql: `
        INSERT INTO community_roles (
          role_assignment_id, community_id, user_id, role, status, granted_at, created_at, updated_at
        ) VALUES (
          ?1, ?2, ?3, ?4, 'active', ?5, ?5, ?5
        )
        ON CONFLICT(role_assignment_id) DO UPDATE SET
          status = excluded.status,
          updated_at = excluded.updated_at
      `,
      args: [`rol_${input.communityId}_${input.userId}_${input.role}`, input.communityId, input.userId, input.role, now],
    })
  } finally {
    client.close()
  }
}

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
membership_mode: "request",
        namespace: {
          namespace_verification: namespaceVerificationId,
        },
      }, ctx.env, session.accessToken)
      expect(communityCreate.status).toBe(202)
      const communityCreateBody = await json(communityCreate) as {
        community: { id: string }
      }

      const textPost = await requestJson(
        `http://pirate.test/communities/${communityCreateBody.community.id.replace(/^com_/, "")}/posts`,
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
        `http://pirate.test/communities/${communityCreateBody.community.id.replace(/^com_/, "")}/posts`,
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
        `http://pirate.test/communities/${communityCreateBody.community.id.replace(/^com_/, "")}/posts`,
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
        `http://pirate.test/communities/${communityCreateBody.community.id.replace(/^com_/, "")}/posts`,
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
        `http://pirate.test/communities/${communityCreateBody.community.id.replace(/^com_/, "")}/posts`,
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
        `http://pirate.test/communities/${communityCreateBody.community.id.replace(/^com_/, "")}/posts`,
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
        `http://pirate.test/communities/${communityCreateBody.community.id.replace(/^com_/, "")}/posts`,
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
membership_mode: "request",
        namespace: {
          namespace_verification: namespaceVerificationId,
        },
      }, ctx.env, session.accessToken)
      expect(communityCreate.status).toBe(202)
      const communityCreateBody = await json(communityCreate) as {
        community: { id: string }
      }

      const safetyUpdate = await app.request(
        `http://pirate.test/communities/${communityCreateBody.community.id.replace(/^com_/, "")}/safety`,
        {
          method: "POST",
          headers: {
            "content-type": "application/json",
            authorization: `Bearer ${session.accessToken}`,
          },
          body: settingsJson({
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
        `http://pirate.test/communities/${communityCreateBody.community.id.replace(/^com_/, "")}/posts`,
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
membership_mode: "request",
      namespace: {
        namespace_verification: namespaceVerificationId,
      },
    }, ctx.env, verifiedCreator.accessToken)
    expect(communityCreate.status).toBe(202)
    const communityCreateBody = await json(communityCreate) as {
      community: { id: string }
    }

    const unverifiedMember = await exchangeJwt(ctx.env, "community-unverified-member")
    await addCommunityMember(
      ctx.communityDbRoot,
      communityCreateBody.community.id.replace(/^com_/, ""),
      unverifiedMember.userId,
    )
    const deniedPost = await requestJson(
      `http://pirate.test/communities/${communityCreateBody.community.id.replace(/^com_/, "")}/posts`,
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
membership_mode: "request",
      namespace: {
        namespace_verification: namespaceVerificationId,
      },
    }, ctx.env, creator.accessToken)
    expect(communityCreate.status).toBe(202)
    const communityCreateBody = await json(communityCreate) as {
      community: { id: string }
    }

    const createdPost = await requestJson(
      `http://pirate.test/communities/${communityCreateBody.community.id.replace(/^com_/, "")}/posts`,
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
      `http://pirate.test/communities/${communityCreateBody.community.id.replace(/^com_/, "")}/posts`,
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
membership_mode: "request",
      namespace: {
        namespace_verification: namespaceVerificationId,
      },
    }, ctx.env, verifiedCreator.accessToken)
    expect(communityCreate.status).toBe(202)
    const communityCreateBody = await json(communityCreate) as {
      community: { id: string }
    }

    const verifiedNonMember = await exchangeJwt(ctx.env, "community-verified-non-member")
    await completeUniqueHumanVerification(ctx.env, verifiedNonMember.accessToken)

    const deniedPost = await requestJson(
      `http://pirate.test/communities/${communityCreateBody.community.id.replace(/^com_/, "")}/posts`,
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
membership_mode: "request",
      namespace: {
        namespace_verification: namespaceVerificationId,
      },
    }, ctx.env, owner.accessToken)
    expect(communityCreate.status).toBe(202)
    const communityCreateBody = await json(communityCreate) as {
      community: { id: string }
    }

    const author = await exchangeJwt(ctx.env, "community-review-held-author")
    await completeUniqueHumanVerification(ctx.env, author.accessToken)
    await addCommunityMember(ctx.communityDbRoot, communityCreateBody.community.id.replace(/^com_/, ""), author.userId)

    const reviewHeldPost = await requestJson(
      `http://pirate.test/communities/${communityCreateBody.community.id.replace(/^com_/, "")}/posts`,
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
      id: string
      status: string
      author_user: string | null
    }
    expect(reviewHeldBody.status).toBe("draft")
    expect(reviewHeldBody.author_user).toBe(`usr_${author.userId}`)

    const ownerRead = await app.request(
      `http://pirate.test/posts/${reviewHeldBody.id}`,
      {
        headers: {
          authorization: `Bearer ${owner.accessToken}`,
        },
      },
      ctx.env,
    )
    expect(ownerRead.status).toBe(200)
    const ownerReadBody = await json(ownerRead) as {
      post: { id: string; status: string }
    }
    expect(ownerReadBody.post.id).toBe(reviewHeldBody.id)
    expect(ownerReadBody.post.status).toBe("draft")

    const otherMember = await exchangeJwt(ctx.env, "community-review-held-other-member")
    await addCommunityMember(ctx.communityDbRoot, communityCreateBody.community.id.replace(/^com_/, ""), otherMember.userId)

    const deniedRead = await app.request(
      `http://pirate.test/posts/${reviewHeldBody.id}`,
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
membership_mode: "request",
      namespace: {
        namespace_verification: namespaceVerificationId,
      },
    }, ctx.env, session.accessToken)
    expect(communityCreate.status).toBe(202)
    const communityCreateBody = await json(communityCreate) as {
      community: { id: string }
    }

    const createdPost = await requestJson(
      `http://pirate.test/communities/${communityCreateBody.community.id.replace(/^com_/, "")}/posts`,
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
membership_mode: "request",
      namespace: {
        namespace_verification: namespaceVerificationId,
      },
    }, ctx.env, session.accessToken)
    expect(communityCreate.status).toBe(202)
    const communityCreateBody = await json(communityCreate) as {
      community: { id: string }
    }

    const response = await requestJson(
      `http://pirate.test/communities/${communityCreateBody.community.id.replace(/^com_/, "")}/posts`,
      {
        community_id: communityCreateBody.community.id.replace(/^com_/, ""),
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
membership_mode: "request",
      namespace: {
        namespace_verification: namespaceVerificationId,
      },
    }, ctx.env, creator.accessToken)
    expect(communityCreate.status).toBe(202)
    const communityCreateBody = await json(communityCreate) as {
      community: { id: string }
    }

    const createdPost = await requestJson(
      `http://pirate.test/communities/${communityCreateBody.community.id.replace(/^com_/, "")}/posts`,
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
    const postBody = await json(createdPost) as { id: string }

    const unverifiedMember = await exchangeJwt(ctx.env, "community-unverified-voter")
    await addCommunityMember(ctx.communityDbRoot, communityCreateBody.community.id.replace(/^com_/, ""), unverifiedMember.userId)

    const allowedVote = await requestJson(
      `http://pirate.test/posts/${postBody.id}/vote`,
      { value: 1 },
      ctx.env,
      unverifiedMember.accessToken,
    )
    expect(allowedVote.status).toBe(200)
    const allowedBody = await json(allowedVote) as { post: string; value: number }
    expect(allowedBody.post).toBe(postBody.id)
    expect(allowedBody.value).toBe(1)

    const updatedVote = await requestJson(
      `http://pirate.test/posts/${postBody.id}/vote`,
      { value: -1 },
      ctx.env,
      unverifiedMember.accessToken,
    )
    expect(updatedVote.status).toBe(200)
    const updatedBody = await json(updatedVote) as { post: string; value: number }
    expect(updatedBody.post).toBe(postBody.id)
    expect(updatedBody.value).toBe(-1)

    const listedPosts = await app.request(
      `http://pirate.test/communities/${communityCreateBody.community.id.replace(/^com_/, "")}/posts`,
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
        post: { id: string }
        upvote_count: number
        downvote_count: number
        like_count: number
        viewer_vote: number | null
      }>
    }
    expect(listedPostsBody.items).toHaveLength(1)
    expect(listedPostsBody.items[0]?.post.id).toBe(postBody.id)
    expect(listedPostsBody.items[0]?.upvote_count).toBe(0)
    expect(listedPostsBody.items[0]?.downvote_count).toBe(1)
    expect(listedPostsBody.items[0]?.like_count).toBe(0)
    expect(listedPostsBody.items[0]?.viewer_vote).toBe(-1)
  })

  test("authors can soft-delete posts and deleted posts read as stubs", async () => {
    const ctx = await createRouteTestContext()
    cleanup = ctx.cleanup

    const creator = await exchangeJwt(ctx.env, "community-post-delete-creator")
    const namespaceVerificationId = await prepareVerifiedNamespace(ctx.env, creator.accessToken)
    const communityCreate = await requestJson("http://pirate.test/communities", {
      display_name: "Pirate Delete Club",
      membership_mode: "request",
      namespace: {
        namespace_verification: namespaceVerificationId,
      },
    }, ctx.env, creator.accessToken)
    expect(communityCreate.status).toBe(202)
    const communityCreateBody = await json(communityCreate) as {
      community: { id: string }
    }
    const communityId = communityCreateBody.community.id.replace(/^com_/, "")

    const createdPost = await requestJson(
      `http://pirate.test/communities/${communityId}/posts`,
      {
        post_type: "text",
        title: "Delete me",
        body: "This body must not leak after delete.",
        idempotency_key: "delete-post-key-1",
      },
      ctx.env,
      creator.accessToken,
    )
    expect(createdPost.status).toBe(201)
    const postBody = await json(createdPost) as { id: string }

    const removedPost = await requestJson(
      `http://pirate.test/communities/${communityId}/posts`,
      {
        post_type: "text",
        title: "Removed by mods",
        body: "This post should stay in moderation-owned state.",
        idempotency_key: "delete-post-key-removed-1",
      },
      ctx.env,
      creator.accessToken,
    )
    expect(removedPost.status).toBe(201)
    const removedPostBody = await json(removedPost) as { id: string }
    const communityDb = createClient({
      url: buildLocalCommunityDbUrl(ctx.communityDbRoot, communityId),
    })
    try {
      await communityDb.execute({
        sql: `
          UPDATE posts
          SET status = 'removed'
          WHERE post_id = ?1
        `,
        args: [removedPostBody.id.replace(/^post_/, "")],
      })
    } finally {
      communityDb.close()
    }

    const deniedRemovedDelete = await requestJson(
      `http://pirate.test/communities/${communityId}/posts/${removedPostBody.id}/delete`,
      {},
      ctx.env,
      creator.accessToken,
    )
    expect(deniedRemovedDelete.status).toBe(400)

    const member = await exchangeJwt(ctx.env, "community-post-delete-member")
    await addCommunityMember(ctx.communityDbRoot, communityId, member.userId)

    const deniedDelete = await requestJson(
      `http://pirate.test/communities/${communityId}/posts/${postBody.id}/delete`,
      {},
      ctx.env,
      member.accessToken,
    )
    expect(deniedDelete.status).toBe(403)

    const deleted = await requestJson(
      `http://pirate.test/communities/${communityId}/posts/${postBody.id}/delete`,
      {},
      ctx.env,
      creator.accessToken,
    )
    expect(deleted.status).toBe(200)
    expect(await json(deleted)).toEqual({
      id: postBody.id,
      object: "post",
      deleted: true,
    })

    const deletedAgain = await requestJson(
      `http://pirate.test/communities/${communityId}/posts/${postBody.id}/delete`,
      {},
      ctx.env,
      creator.accessToken,
    )
    expect(deletedAgain.status).toBe(200)
    expect(await json(deletedAgain)).toEqual({
      id: postBody.id,
      object: "post",
      deleted: true,
    })

    const deniedIdempotentDelete = await requestJson(
      `http://pirate.test/communities/${communityId}/posts/${postBody.id}/delete`,
      {},
      ctx.env,
      member.accessToken,
    )
    expect(deniedIdempotentDelete.status).toBe(403)

    const memberRead = await app.request(`http://pirate.test/posts/${postBody.id}`, {
      headers: {
        authorization: `Bearer ${member.accessToken}`,
      },
    }, ctx.env)
    expect(memberRead.status).toBe(200)
    const memberReadBody = await json(memberRead) as {
      post: {
        status: string
        title: string | null
        body: string | null
        media_refs: unknown[]
      }
      upvote_count: number
      downvote_count: number
      viewer_vote: number | null
      viewer_is_author?: boolean
    }
    expect(memberReadBody.post.status).toBe("deleted")
    expect(memberReadBody.post.title).toBeNull()
    expect(memberReadBody.post.body).toBeNull()
    expect(memberReadBody.post.media_refs).toEqual([])
    expect(memberReadBody.upvote_count).toBe(0)
    expect(memberReadBody.downvote_count).toBe(0)
    expect(memberReadBody.viewer_vote).toBeNull()
    expect(memberReadBody.viewer_is_author).toBe(false)

    const creatorRead = await app.request(`http://pirate.test/posts/${postBody.id}`, {
      headers: {
        authorization: `Bearer ${creator.accessToken}`,
      },
    }, ctx.env)
    expect(creatorRead.status).toBe(200)
    const creatorReadBody = await json(creatorRead) as {
      post: { status: string; body: string | null }
      viewer_is_author?: boolean
    }
    expect(creatorReadBody.post.status).toBe("deleted")
    expect(creatorReadBody.post.body).toBeNull()
    expect(creatorReadBody.viewer_is_author).toBe(true)

    const listedPosts = await app.request(`http://pirate.test/communities/${communityId}/posts`, {
      headers: {
        authorization: `Bearer ${member.accessToken}`,
      },
    }, ctx.env)
    expect(listedPosts.status).toBe(200)
    const listedPostsBody = await json(listedPosts) as { items: unknown[] }
    expect(listedPostsBody.items).toHaveLength(0)

    const voteDeleted = await requestJson(
      `http://pirate.test/posts/${postBody.id}/vote`,
      { value: 1 },
      ctx.env,
      member.accessToken,
    )
    expect(voteDeleted.status).toBe(400)

    const auditRows = await ctx.client.execute({
      sql: `
        SELECT action, actor_type, actor_id, target_type, target_id
        FROM audit_log
        WHERE action = 'community.post_deleted_by_author'
      `,
      args: [],
    })
    expect(auditRows.rows).toHaveLength(1)
    expect(auditRows.rows[0]?.actor_type).toBe("user")
    expect(auditRows.rows[0]?.actor_id).toBe(creator.userId)
    expect(auditRows.rows[0]?.target_type).toBe("post")
    expect(auditRows.rows[0]?.target_id).toBe(postBody.id.replace(/^post_/, ""))
  })

  test("moderators can remove posts and lock thread comments", async () => {
    const ctx = await createRouteTestContext()
    cleanup = ctx.cleanup

    const creator = await exchangeJwt(ctx.env, "community-post-mod-creator")
    const namespaceVerificationId = await prepareVerifiedNamespace(ctx.env, creator.accessToken)
    const communityCreate = await requestJson("http://pirate.test/communities", {
      display_name: "Pirate Mod Post Club",
      membership_mode: "request",
      namespace: {
        namespace_verification: namespaceVerificationId,
      },
    }, ctx.env, creator.accessToken)
    expect(communityCreate.status).toBe(202)
    const communityCreateBody = await json(communityCreate) as { community: { id: string } }
    const communityId = communityCreateBody.community.id.replace(/^com_/, "")

    const moderator = await exchangeJwt(ctx.env, "community-post-moderator")
    await addCommunityMember(ctx.communityDbRoot, communityId, moderator.userId)
    await grantCommunityRole({
      communityDbRoot: ctx.communityDbRoot,
      communityId,
      userId: moderator.userId,
      role: "moderator",
    })

    const member = await exchangeJwt(ctx.env, "community-post-nonmod")
    await addCommunityMember(ctx.communityDbRoot, communityId, member.userId)

    const createdPost = await requestJson(
      `http://pirate.test/communities/${communityId}/posts`,
      {
        post_type: "text",
        title: "Remove and lock me",
        body: "Moderators should own this state change.",
        idempotency_key: "mod-post-remove-lock-1",
      },
      ctx.env,
      creator.accessToken,
    )
    expect(createdPost.status).toBe(201)
    const postBody = await json(createdPost) as { id: string }

    const deniedRemove = await requestJson(
      `http://pirate.test/communities/${communityId}/posts/${postBody.id}/remove`,
      {},
      ctx.env,
      member.accessToken,
    )
    expect(deniedRemove.status).toBe(403)

    const lock = await requestJson(
      `http://pirate.test/communities/${communityId}/posts/${postBody.id}/comments-lock`,
      { locked: true, reason: "cooldown" },
      ctx.env,
      moderator.accessToken,
    )
    expect(lock.status).toBe(200)
    const lockBody = await json(lock) as {
      comments_locked: boolean
      comments_lock_reason: string | null
      comments_locked_by_user: string | null
    }
    expect(lockBody.comments_locked).toBe(true)
    expect(lockBody.comments_lock_reason).toBe("cooldown")
    expect(lockBody.comments_locked_by_user).toBe(`usr_${moderator.userId}`)

    const remove = await requestJson(
      `http://pirate.test/communities/${communityId}/posts/${postBody.id}/remove`,
      {},
      ctx.env,
      moderator.accessToken,
    )
    expect(remove.status).toBe(200)
    const removeBody = await json(remove) as { status: string }
    expect(removeBody.status).toBe("removed")

    const auditRows = await ctx.client.execute({
      sql: `
        SELECT action, actor_id, target_type, target_id
        FROM audit_log
        WHERE action IN ('community.post_removed_by_moderator', 'community.thread_locked_by_moderator')
        ORDER BY created_at ASC, audit_event_id ASC
      `,
      args: [],
    })
    expect(auditRows.rows.map((row) => row.action)).toEqual([
      "community.thread_locked_by_moderator",
      "community.post_removed_by_moderator",
    ])
    expect(auditRows.rows[0]?.actor_id).toBe(moderator.userId)
    expect(auditRows.rows[0]?.target_type).toBe("post")
    expect(auditRows.rows[0]?.target_id).toBe(postBody.id.replace(/^post_/, ""))
    expect(auditRows.rows[1]?.actor_id).toBe(moderator.userId)
    expect(auditRows.rows[1]?.target_type).toBe("post")
    expect(auditRows.rows[1]?.target_id).toBe(postBody.id.replace(/^post_/, ""))
  })
})
