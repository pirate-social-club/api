import { afterEach, beforeEach, describe, expect, test } from "bun:test"
import { createClient } from "@libsql/client"
import app from "../../../src/index"
import { buildLocalCommunityDbUrl } from "../../../src/lib/communities/community-local-db"
import { createRouteTestContext, json, resetRuntimeCaches } from "../../helpers"
import {
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

  test("spaces namespace attach uses @ route slug", async () => {
    const ctx = await createRouteTestContext({
      SPACES_VERIFIER_BASE_URL: "http://spaces-verifier.test",
    })
    cleanup = ctx.cleanup

    const session = await exchangeJwt(ctx.env, "community-spaces-route-user")
    await completeUniqueHumanVerification(ctx.env, session.accessToken)

    const communityCreate = await requestJson("http://pirate.test/communities", {
      display_name: "Spaces Route Club",
      handle_policy: {
        policy_template: "standard",
      },
    }, ctx.env, session.accessToken)
    expect(communityCreate.status).toBe(202)
    const communityCreateBody = await json(communityCreate) as {
      community: {
        community_id: string
      }
    }

    const originalFetch = globalThis.fetch
    globalThis.fetch = (async (input, init) => {
      const url = typeof input === "string" ? input : input.toString()
      if (url.startsWith("http://spaces-verifier.test/inspect?")) {
        return new Response(JSON.stringify({
          root_exists: true,
          root_key_proof_verified: true,
          root_pubkey: "spaces-root-pubkey",
          observation_provider: "spaces_verifier",
          anchor_fresh_enough: true,
        }), {
          status: 200,
          headers: { "content-type": "application/json" },
        })
      }
      if (url === "http://spaces-verifier.test/verify-publish") {
        const body = JSON.parse(String(init?.body)) as { txt_value: string; web_url: string; freedom_url: string }
        return new Response(JSON.stringify({
          fabric_publish_verified: true,
          root_key_proof_verified: true,
          web_target_verified: true,
          freedom_target_verified: true,
          observed_web_url: body.web_url,
          observed_freedom_url: body.freedom_url,
          observed_txt_values: [body.txt_value],
          records: { "pirate-verify": [body.txt_value] },
          observation_provider: "spaces_verifier+fabric_zone",
        }), {
          status: 200,
          headers: { "content-type": "application/json" },
        })
      }
      return originalFetch(input, init)
    }) as typeof fetch

    try {
      const namespaceSession = await requestJson("http://pirate.test/namespace-verification-sessions", {
        family: "spaces",
        root_label: "\u{1F1F5}\u{1F1F8}",
      }, ctx.env, session.accessToken)
      expect(namespaceSession.status).toBe(201)
      const namespaceBody = await json(namespaceSession) as { namespace_verification_session_id: string }
      const completed = await requestJson(
        `http://pirate.test/namespace-verification-sessions/${namespaceBody.namespace_verification_session_id}/complete`,
        {},
        ctx.env,
        session.accessToken,
      )
      expect(completed.status).toBe(200)
      const completedBody = await json(completed) as { namespace_verification_id: string }

      const attachResponse = await requestJson(
        `http://pirate.test/communities/${communityCreateBody.community.community_id}/namespace`,
        {
          namespace_verification_id: completedBody.namespace_verification_id,
        },
        ctx.env,
        session.accessToken,
      )
      expect(attachResponse.status).toBe(200)
      const attachedCommunity = await json(attachResponse) as {
        community_id: string
        route_slug: string | null
      }
      expect(attachedCommunity.route_slug).toBe("@xn--t77hga")

      const communityBySlug = await app.request("http://pirate.test/communities/@xn--t77hga", {
        headers: {
          authorization: `Bearer ${session.accessToken}`,
        },
      }, ctx.env)
      expect(communityBySlug.status).toBe(200)
    } finally {
      globalThis.fetch = originalFetch
    }
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

    const rulesResponse = await app.request(
      `http://pirate.test/communities/${communityCreateBody.community.community_id}/rules`,
      {
        method: "PUT",
        headers: {
          authorization: `Bearer ${session.accessToken}`,
          "content-type": "application/json",
        },
        body: JSON.stringify({
          rules: [
            {
              title: "Respect others and be civil",
              body: "Keep discussion constructive.",
            },
            {
              title: "No spam",
              body: "Do not flood the community.",
            },
          ],
        }),
      },
      ctx.env,
    )
    expect(rulesResponse.status).toBe(200)

    const donationPolicyResponse = await app.request(
      `http://pirate.test/communities/${communityCreateBody.community.community_id}/donation-policy`,
      {
        method: "PATCH",
        headers: {
          authorization: `Bearer ${session.accessToken}`,
          "content-type": "application/json",
        },
        body: JSON.stringify({
          donation_policy_mode: "optional_creator_sidecar",
          donation_partner_id: "org_charity_water",
          donation_partner: {
            donation_partner_id: "org_charity_water",
            display_name: "charity: water",
            provider: "endaoment",
            provider_partner_ref: "charity-water",
            image_url: "https://images.example/charity-water.png",
          },
        }),
      },
      ctx.env,
    )
    expect(donationPolicyResponse.status).toBe(200)

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
      `http://pirate.test/public-communities/${communityCreateBody.community.route_slug ?? communityCreateBody.community.community_id}?locale=ar`,
      {},
      ctx.env,
    )
    expect(preview.status).toBe(200)
    const previewBody = await json(preview) as {
      community_id: string
      display_name: string
      description: string | null
      donation_policy_mode?: "none" | "optional_creator_sidecar" | null
      donation_partner_id?: string | null
      donation_partner?: {
        donation_partner_id: string
        display_name: string
        provider_partner_ref?: string | null
        image_url?: string | null
      } | null
      rules?: Array<{
        rule_id: string
        title: string
        body: string
        position: number
        status: string
      }> | null
      localized_text?: {
        resolved_locale: string
        items: Array<{
          field_key: string
          translation_state: string
        }>
      } | null
      viewer_membership_status: string | null
    }
    expect(previewBody.community_id).toBe(communityCreateBody.community.community_id)
    expect(previewBody.display_name).toBe("Public Community Club")
    expect(previewBody.description).toBe("Readable without reconnecting.")
    expect(previewBody.donation_policy_mode).toBe("optional_creator_sidecar")
    expect(previewBody.donation_partner_id).toBe("org_charity_water")
    expect(previewBody.donation_partner?.display_name).toBe("charity: water")
    expect(previewBody.donation_partner?.provider_partner_ref).toBe("charity-water")
    expect(previewBody.donation_partner?.image_url).toBe("https://images.example/charity-water.png")
    expect(previewBody.rules?.map((rule) => rule.title)).toEqual([
      "Respect others and be civil",
      "No spam",
    ])
    expect(previewBody.localized_text?.resolved_locale).toBe("ar")
    expect(previewBody.localized_text?.items.some((item) => item.field_key === "community.description")).toBe(true)
    expect(previewBody.localized_text?.items.some((item) => /^community\.rule\..+\.title$/.test(item.field_key))).toBe(true)
    expect(previewBody.localized_text?.items.some((item) => /^community\.rule\..+\.body$/.test(item.field_key))).toBe(true)
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

  test("community reads expose localized text overlays and enqueue one batch translation job per locale", async () => {
    const ctx = await createRouteTestContext()
    cleanup = ctx.cleanup

    const session = await exchangeJwt(ctx.env, "community-localized-read-user")
    await completeUniqueHumanVerification(ctx.env, session.accessToken)

    const communityCreate = await requestJson("http://pirate.test/communities", {
      display_name: "Localized Community Club",
      description: "Welcome to the community.",
      handle_policy: {
        policy_template: "standard",
      },
    }, ctx.env, session.accessToken)
    expect(communityCreate.status).toBe(202)
    const communityCreateBody = await json(communityCreate) as {
      community: {
        community_id: string
      }
    }

    const rulesResponse = await app.request(
      `http://pirate.test/communities/${communityCreateBody.community.community_id}/rules`,
      {
        method: "PUT",
        headers: {
          authorization: `Bearer ${session.accessToken}`,
          "content-type": "application/json",
        },
        body: JSON.stringify({
          rules: [
            {
              title: "Be kind",
              body: "Keep the conversation civil.",
            },
          ],
        }),
      },
      ctx.env,
    )
    expect(rulesResponse.status).toBe(200)

    const localClient = createClient({
      url: buildLocalCommunityDbUrl(String(ctx.env.LOCAL_COMMUNITY_DB_ROOT), communityCreateBody.community.community_id),
    })
    try {
      await localClient.execute({
        sql: `
          UPDATE communities
          SET settings_json = ?2
          WHERE community_id = ?1
        `,
        args: [
          communityCreateBody.community.community_id,
          JSON.stringify({
            reference_links: [
              {
                community_reference_link_id: "crl_sidebar",
                platform: "official_website",
                url: "https://pirate.test/community",
                label: "Official site",
                link_status: "active",
                verified: true,
                metadata: {
                  display_name: "Pirate community hub",
                },
                position: 0,
              },
            ],
          }),
        ],
      })

      const response = await app.request(
        `http://pirate.test/communities/${communityCreateBody.community.community_id}?locale=es`,
        {
          headers: {
            authorization: `Bearer ${session.accessToken}`,
          },
        },
        ctx.env,
      )
      expect(response.status).toBe(200)

      const body = await json(response) as {
        localized_text: {
          resolved_locale: string
          items: Array<{
            field_key: string
            translation_state: string
            machine_translated: boolean
            translated_value: string | null
          }>
        } | null
      }
      expect(body.localized_text?.resolved_locale).toBe("es")
      const fieldKeys = body.localized_text?.items.map((item) => item.field_key) ?? []
      expect(fieldKeys).toContain("community.description")
      expect(fieldKeys).toContain("community.reference_link.crl_sidebar.label")
      expect(fieldKeys).toContain("community.reference_link.crl_sidebar.metadata.display_name")
      expect(fieldKeys.some((fieldKey) => /^community\.rule\..+\.title$/.test(fieldKey))).toBe(true)
      expect(fieldKeys.some((fieldKey) => /^community\.rule\..+\.body$/.test(fieldKey))).toBe(true)
      for (const item of body.localized_text?.items ?? []) {
        expect(item.translation_state).toBe("pending")
        expect(item.machine_translated).toBe(false)
        expect(item.translated_value).toBeNull()
      }

      const jobs = await localClient.execute({
        sql: `
          SELECT job_type, subject_id
          FROM community_jobs
          WHERE subject_id = ?1
        `,
        args: [`${communityCreateBody.community.community_id}:es`],
      })
      expect(jobs.rows).toHaveLength(1)
      expect(String(jobs.rows[0]?.job_type)).toBe("community_text_translation_materialize")
      expect(String(jobs.rows[0]?.subject_id)).toBe(`${communityCreateBody.community.community_id}:es`)
    } finally {
      localClient.close()
    }
  })

  test("private posts stay readable to members but are hidden from public routes", async () => {
    const ctx = await createRouteTestContext()
    cleanup = ctx.cleanup

    const session = await exchangeJwt(ctx.env, "community-private-post-user")
    await completeUniqueHumanVerification(ctx.env, session.accessToken)
    const namespaceVerificationId = await prepareVerifiedNamespace(ctx.env, session.accessToken)

    const communityCreate = await requestJson("http://pirate.test/communities", {
      display_name: "Private Post Club",
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

    const publicPost = await requestJson(
      `http://pirate.test/communities/${communityCreateBody.community.community_id}/posts`,
      {
        post_type: "text",
        title: "Public post",
        body: "This can stay on public routes.",
        idempotency_key: "post-key-private-visibility-public",
      },
      ctx.env,
      session.accessToken,
    )
    expect(publicPost.status).toBe(201)
    const publicPostBody = await json(publicPost) as {
      post_id: string
      visibility: string
    }
    expect(publicPostBody.visibility).toBe("public")

    const privatePost = await requestJson(
      `http://pirate.test/communities/${communityCreateBody.community.community_id}/posts`,
      {
        post_type: "text",
        title: "Private post",
        body: "Only joined members should read this.",
        idempotency_key: "post-key-private-visibility-private",
        visibility: "members_only",
      },
      ctx.env,
      session.accessToken,
    )
    expect(privatePost.status).toBe(201)
    const privatePostBody = await json(privatePost) as {
      post_id: string
      visibility: string
    }
    expect(privatePostBody.visibility).toBe("members_only")

    const memberRead = await app.request(
      `http://pirate.test/posts/${privatePostBody.post_id}`,
      {
        headers: {
          authorization: `Bearer ${session.accessToken}`,
        },
      },
      ctx.env,
    )
    expect(memberRead.status).toBe(200)
    const memberReadBody = await json(memberRead) as {
      post: { post_id: string; visibility: string }
    }
    expect(memberReadBody.post.post_id).toBe(privatePostBody.post_id)
    expect(memberReadBody.post.visibility).toBe("members_only")

    const publicPosts = await app.request(
      `http://pirate.test/public-communities/${communityCreateBody.community.route_slug ?? communityCreateBody.community.community_id}/posts`,
      {},
      ctx.env,
    )
    expect(publicPosts.status).toBe(200)
    const publicPostsBody = await json(publicPosts) as {
      items: Array<{ post: { post_id: string } }>
    }
    expect(publicPostsBody.items.map((item) => item.post.post_id)).toEqual([publicPostBody.post_id])

    const hiddenPublicPost = await app.request(
      `http://pirate.test/public-posts/${privatePostBody.post_id}`,
      {},
      ctx.env,
    )
    expect(hiddenPublicPost.status).toBe(404)

    const projectionRows = await ctx.client.execute({
      sql: `
        SELECT source_post_id, visibility
        FROM community_post_projections
        WHERE community_id = ?1
        ORDER BY source_created_at ASC
      `,
      args: [communityCreateBody.community.community_id],
    })
    expect(projectionRows.rows).toEqual([
      { source_post_id: publicPostBody.post_id, visibility: "public" },
      { source_post_id: privatePostBody.post_id, visibility: "members_only" },
    ])
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

})
