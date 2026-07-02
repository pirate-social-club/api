import { afterEach, beforeEach, describe, expect, test } from "bun:test"
import { createClient } from "@libsql/client"
import { app } from "../../../src/index"
import { buildLocalCommunityDbUrl } from "../../../src/lib/communities/community-local-db"
import { createRouteTestContext, json, resetRuntimeCaches } from "../../helpers"
import {
  completeAgeOver18Verification,
  completeUniqueHumanVerification,
  exchangeJwt,
  getCommunityControlPlaneState,
  prepareVerifiedNamespace,
  requestJson,
} from "./community-routes-test-helpers"

let cleanup: (() => Promise<void>) | null = null

function stripPublicPrefix(value: unknown, prefix: string): unknown {
  if (typeof value !== "string") {
    return value
  }
  const publicPrefix = `${prefix}_`
  return value.startsWith(publicPrefix) ? value.slice(publicPrefix.length) : value
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

describe("community routes", () => {
  test("community create succeeds without unique_human verification", async () => {
    const ctx = await createRouteTestContext()
    cleanup = ctx.cleanup

    const session = await exchangeJwt(ctx.env, "community-create-without-unique-human-user")

    const communityCreate = await requestJson("http://pirate.test/communities", {
      display_name: "Open Create Club",
      membership_mode: "request",
      handle_policy: {
        policy_template: "standard",
      },
    }, ctx.env, session.accessToken)
    expect(communityCreate.status).toBe(202)
    const communityCreateBody = await json(communityCreate) as {
      community: {
        id: string
        display_name: string
        membership_mode: string
        gate_policy?: unknown
      }
    }
    expect(communityCreateBody.community.display_name).toBe("Open Create Club")
    expect(communityCreateBody.community.id.replace(/^com_/, "").startsWith("cmt_")).toBe(true)
    expect(communityCreateBody.community.membership_mode).toBe("request")
    expect(communityCreateBody.community.gate_policy ?? null).toBeNull()

    const policyResponse = await app.request(
      `http://pirate.test/communities/${communityCreateBody.community.id.replace(/^com_/, "")}/machine-access-policy`,
      {
        headers: {
          authorization: `Bearer ${session.accessToken}`,
        },
      },
      ctx.env,
    )
    expect(policyResponse.status).toBe(200)
    const policy = await json(policyResponse) as {
      id: string
      community_id: string
      policy_origin: string
      access_mode: string
      included_surfaces: {
        community_identity: boolean
        community_stats: boolean
        thread_cards: boolean
        thread_bodies: boolean
        top_comments: boolean
        events: boolean
      }
      allowed_uses: {
        summarization: boolean
        analytics: boolean
        ai_training: string
      }
      operational_limits: {
        anonymous_rate_tier: string
        authenticated_rate_tier: string
        top_comments_limit: number
        max_lookback_window: string
      }
    }
    expect(policy.community_id).toBe(communityCreateBody.community.id.replace(/^com_/, ""))
    expect(policy.policy_origin).toBe("default")
    expect(policy.access_mode).toBe("structured_api")
    expect(policy.included_surfaces).toEqual({
      community_identity: true,
      community_stats: true,
      thread_cards: true,
      thread_bodies: true,
      top_comments: true,
      events: true,
    })
    expect(policy.allowed_uses).toEqual({
      summarization: true,
      analytics: true,
      ai_training: "prohibited",
    })
    expect(policy.operational_limits).toEqual({
      anonymous_rate_tier: "low",
      authenticated_rate_tier: "standard",
      top_comments_limit: 10,
      max_lookback_window: "all_time",
    })

    const patchPolicyResponse = await app.request(
      `http://pirate.test/communities/${communityCreateBody.community.id.replace(/^com_/, "")}/machine-access-policy`,
      {
        method: "POST",
        headers: {
          authorization: `Bearer ${session.accessToken}`,
          "content-type": "application/json",
        },
        body: JSON.stringify({
          included_surfaces: {
            community_stats: false,
            top_comments: false,
          },
        }),
      },
      ctx.env,
    )
    expect(patchPolicyResponse.status).toBe(200)
    const patchedPolicy = await json(patchPolicyResponse) as typeof policy
    expect(patchedPolicy.policy_origin).toBe("explicit")
    expect(patchedPolicy.included_surfaces).toEqual({
      community_identity: true,
      community_stats: false,
      thread_cards: true,
      thread_bodies: true,
      top_comments: false,
      events: true,
    })

    const persistedPolicyResponse = await app.request(
      `http://pirate.test/communities/${communityCreateBody.community.id.replace(/^com_/, "")}/machine-access-policy`,
      {
        headers: {
          authorization: `Bearer ${session.accessToken}`,
        },
      },
      ctx.env,
    )
    expect(persistedPolicyResponse.status).toBe(200)
    const persistedPolicy = await json(persistedPolicyResponse) as typeof policy
    expect(persistedPolicy.policy_origin).toBe("explicit")
    expect(persistedPolicy.included_surfaces.community_stats).toBe(false)
    expect(persistedPolicy.included_surfaces.top_comments).toBe(false)
  })

  test("18_plus community create requires age verification but not unique_human", async () => {
    const ctx = await createRouteTestContext()
    cleanup = ctx.cleanup

    const session = await exchangeJwt(ctx.env, "community-create-adult-age-only-user")

    const deniedCreate = await requestJson("http://pirate.test/communities", {
      display_name: "Adults Only Club",
      membership_mode: "request",
      default_age_gate_policy: "18_plus",
      handle_policy: {
        policy_template: "standard",
      },
    }, ctx.env, session.accessToken)
    expect(deniedCreate.status).toBe(403)
    const deniedBody = await json(deniedCreate) as { code: string; message: string }
    expect(deniedBody.code).toBe("eligibility_failed")
    expect(deniedBody.message).toBe("age_over_18 verification is required for 18_plus communities")

    await completeAgeOver18Verification(ctx.env, session.accessToken)

    const allowedCreate = await requestJson("http://pirate.test/communities", {
      display_name: "Adults Only Club",
      membership_mode: "request",
      default_age_gate_policy: "18_plus",
      handle_policy: {
        policy_template: "standard",
      },
    }, ctx.env, session.accessToken)
    expect(allowedCreate.status).toBe(202)
  })

  test("community create succeeds without a namespace and can attach one later", async () => {
    const ctx = await createRouteTestContext()
    cleanup = ctx.cleanup

    const session = await exchangeJwt(ctx.env, "community-optional-namespace-user")
    await completeUniqueHumanVerification(ctx.env, session.accessToken)

    const communityCreate = await requestJson("http://pirate.test/communities", {
      display_name: "Namespace Later Club",
      membership_mode: "request",
      handle_policy: {
        policy_template: "standard",
      },
    }, ctx.env, session.accessToken)
    expect(communityCreate.status).toBe(202)
    const communityCreateBody = await json(communityCreate) as {
      community: {
        id: string
        namespace_verification: string | null
        route_slug: string | null
      }
    }
    expect(communityCreateBody.community.namespace_verification).toBeNull()
    expect(communityCreateBody.community.route_slug).toBeNull()

    const createdState = await getCommunityControlPlaneState(ctx.env, communityCreateBody.community.id.replace(/^com_/, ""))
    expect(createdState.namespaceVerificationId).toBeNull()
    expect(createdState.routeSlug).toBeNull()

    const namespaceVerificationId = await prepareVerifiedNamespace(ctx.env, session.accessToken)
    const attachResponse = await requestJson(
      `http://pirate.test/communities/${communityCreateBody.community.id.replace(/^com_/, "")}/namespace`,
      {
        namespace_verification: namespaceVerificationId,
      },
      ctx.env,
      session.accessToken,
    )
    expect(attachResponse.status).toBe(200)
    const attachedCommunity = await json(attachResponse) as {
      id: string
      namespace_verification: string | null
      route_slug: string | null
    }
    expect(attachedCommunity.namespace_verification).toBe(namespaceVerificationId)
    expect(attachedCommunity.route_slug).toBe("piratecommunityroot")

    const attachedState = await getCommunityControlPlaneState(ctx.env, communityCreateBody.community.id.replace(/^com_/, ""))
    expect(attachedState.namespaceVerificationId).toBe(stripPublicPrefix(namespaceVerificationId, "nv"))
    expect(attachedState.routeSlug).toBe("piratecommunityroot")

    const communityBySlug = await app.request(`http://pirate.test/communities/piratecommunityroot`, {
      headers: {
        authorization: `Bearer ${session.accessToken}`,
      },
    }, ctx.env)
    expect(communityBySlug.status).toBe(200)
    const communityBySlugBody = await json(communityBySlug) as { id: string; route_slug: string | null }
    expect(communityBySlugBody.id).toBe(communityCreateBody.community.id)
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
      membership_mode: "request",
      handle_policy: {
        policy_template: "standard",
      },
    }, ctx.env, session.accessToken)
    expect(communityCreate.status).toBe(202)
    const communityCreateBody = await json(communityCreate) as {
      community: {
        id: string
      }
    }

    const originalFetch = globalThis.fetch
    globalThis.fetch = (async (input: RequestInfo | URL, init?: RequestInit) => {
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
        root_label: "@\u{1F1F5}\u{1F1F8}",
      }, ctx.env, session.accessToken)
      expect(namespaceSession.status).toBe(201)
      const namespaceBody = await json(namespaceSession) as { id: string }
      const completed = await requestJson(
        `http://pirate.test/namespace-verification-sessions/${namespaceBody.id}/complete`,
        {},
        ctx.env,
        session.accessToken,
      )
      expect(completed.status).toBe(200)
      const completedBody = await json(completed) as { namespace_verification: string }

      const attachResponse = await requestJson(
        `http://pirate.test/communities/${communityCreateBody.community.id.replace(/^com_/, "")}/namespace`,
        {
          namespace_verification: completedBody.namespace_verification,
        },
        ctx.env,
        session.accessToken,
      )
      expect(attachResponse.status).toBe(200)
      const attachedCommunity = await json(attachResponse) as {
        id: string
        namespace_verification: string | null
        route_slug: string | null
      }
      expect(attachedCommunity.namespace_verification).toBe(completedBody.namespace_verification)
      expect(attachedCommunity.route_slug).toBe("@xn--t77hga")

      const communityBySlug = await app.request("http://pirate.test/communities/@xn--t77hga", {
        headers: {
          authorization: `Bearer ${session.accessToken}`,
        },
      }, ctx.env)
      expect(communityBySlug.status).toBe(200)

      const previewById = await app.request(
        `http://pirate.test/public-communities/${communityCreateBody.community.id.replace(/^com_/, "")}`,
        {},
        ctx.env,
      )
      expect(previewById.status).toBe(200)
      const previewByIdBody = await json(previewById) as {
        namespace_verification: string | null
        route_slug: string | null
        links: { canonical: { href: string } }
      }
      expect(previewByIdBody.namespace_verification).toBe(completedBody.namespace_verification)
      expect(previewByIdBody.route_slug).toBe("@xn--t77hga")
      expect(previewByIdBody.links.canonical.href).toBe("http://pirate.test/c/@xn--t77hga")
    } finally {
      globalThis.fetch = originalFetch
    }
  })

  test("public community routes return preview and published posts without auth", async () => {
    const ctx = await createRouteTestContext({
      PIRATE_WEB_PUBLIC_ORIGIN: "https://staging.pirate.sc",
    })
    cleanup = ctx.cleanup

    const session = await exchangeJwt(ctx.env, "community-public-preview-user")
    await completeUniqueHumanVerification(ctx.env, session.accessToken)
    const namespaceVerificationId = await prepareVerifiedNamespace(ctx.env, session.accessToken)

    const communityCreate = await requestJson("http://pirate.test/communities", {
      display_name: "Public Community Club",
      description: "Readable without reconnecting.",
      country_code: "GE",
      membership_mode: "request",
      namespace: {
        namespace_verification: namespaceVerificationId,
      },
    }, ctx.env, session.accessToken)
    expect(communityCreate.status).toBe(202)
    const communityCreateBody = await json(communityCreate) as {
      community: {
        id: string
        route_slug: string | null
        country_code: string | null
      }
    }
    expect(communityCreateBody.community.country_code).toBe("ge")

    const rulesResponse = await app.request(
      `http://pirate.test/communities/${communityCreateBody.community.id.replace(/^com_/, "")}/rules`,
      {
        method: "POST",
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
      `http://pirate.test/communities/${communityCreateBody.community.id.replace(/^com_/, "")}/donation-policy`,
      {
        method: "POST",
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

    const referenceLinksResponse = await app.request(
      `http://pirate.test/communities/${communityCreateBody.community.id.replace(/^com_/, "")}/reference-links`,
      {
        method: "POST",
        headers: {
          authorization: `Bearer ${session.accessToken}`,
          "content-type": "application/json",
        },
        body: JSON.stringify({
          reference_links: [{
            platform: "official_website",
            url: "https://pirate.test/public-community-club",
            label: "Official site",
          }],
        }),
      },
      ctx.env,
    )
    expect(referenceLinksResponse.status).toBe(200)

    const createdPost = await requestJson(
      `http://pirate.test/communities/${communityCreateBody.community.id.replace(/^com_/, "")}/posts`,
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
      id: string
      title: string | null
    }
    expect(createdPostBody.title).toBe("Public route post")

    const secondPost = await requestJson(
      `http://pirate.test/communities/${communityCreateBody.community.id.replace(/^com_/, "")}/posts`,
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
      id: string
      title: string | null
    }
    expect(secondPostBody.title).toBe("Second public route post")

    const preview = await app.request(
      `http://pirate.test/public-communities/${communityCreateBody.community.route_slug ?? communityCreateBody.community.id.replace(/^com_/, "")}?locale=ar`,
      {},
      ctx.env,
    )
    expect(preview.status).toBe(200)
    const previewBody = await json(preview) as {
      id: string
      display_name: string
      description: string | null
      country_code: string | null
      donation_policy_mode?: "none" | "optional_creator_sidecar" | null
      donation_partner_id?: string | null
      donation_partner?: {
        donation_partner: string
        display_name: string
        provider_partner_ref?: string | null
        image_url?: string | null
      } | null
      reference_links?: Array<{
        id: string
        object: "community_reference_link"
        platform: string
        url: string
        label: string | null
        link_status: string
        verified: boolean
        metadata: {
          display_name: string | null
          image_url: string | null
        }
      }> | null
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
      omitted_surfaces: unknown[]
      links: {
        self: { href: string; type: string }
        canonical: { href: string; type: string }
        markdown: { href: string; type: string }
        posts: { href: string; type: string }
      }
      namespace_verification: string | null
      route_slug: string | null
      viewer_membership_status: string | null
    }
    expect(previewBody.id).toBe(communityCreateBody.community.id)
    expect(previewBody.display_name).toBe("Public Community Club")
    expect(previewBody.description).toBe("Readable without reconnecting.")
    expect(previewBody.country_code).toBe("ge")
    expect(previewBody.donation_policy_mode).toBe("optional_creator_sidecar")
    expect(previewBody.donation_partner?.donation_partner).toBe("org_charity_water")
    expect(previewBody.donation_partner?.display_name).toBe("charity: water")
    expect(previewBody.donation_partner?.provider_partner_ref).toBe("charity-water")
    expect(previewBody.donation_partner?.image_url).toBe("https://images.example/charity-water.png")
    expect(previewBody.reference_links?.[0]?.label).toBe("Official site")
    expect(previewBody.reference_links?.[0]?.url).toBe("https://pirate.test/public-community-club")
    expect(previewBody.reference_links?.[0]?.verified).toBe(false)
    expect(previewBody.reference_links?.[0]?.metadata.display_name).toBe("Official site")
    expect(previewBody.rules?.map((rule) => rule.title)).toEqual([
      "Respect others and be civil",
      "No spam",
    ])
    expect(previewBody.localized_text?.resolved_locale).toBe("ar")
    expect(previewBody.localized_text?.items.some((item) => item.field_key === "community.description")).toBe(true)
    expect(previewBody.localized_text?.items.some((item) => /^community\.reference_link\..+\.label$/.test(item.field_key))).toBe(true)
    expect(previewBody.localized_text?.items.some((item) => /^community\.reference_link\..+\.metadata\.display_name$/.test(item.field_key))).toBe(true)
    expect(previewBody.localized_text?.items.some((item) => /^community\.rule\..+\.title$/.test(item.field_key))).toBe(true)
    expect(previewBody.localized_text?.items.some((item) => /^community\.rule\..+\.body$/.test(item.field_key))).toBe(true)
    expect(previewBody.viewer_membership_status).toBe("not_member")
    expect(previewBody.namespace_verification).toBe(namespaceVerificationId)
    expect(previewBody.route_slug).toBe(communityCreateBody.community.route_slug)
    expect(preview.headers.get("link")).toContain("/public-communities/")
    expect(preview.headers.get("cdn-cache-control")).toBe("public, s-maxage=60, stale-while-revalidate=300")
    expect(preview.headers.get("cache-control")).toBe("public, max-age=0, s-maxage=60, stale-while-revalidate=300")
    expect(preview.headers.get("vary")).toContain("Accept")
    expect(previewBody.omitted_surfaces).toEqual([])
    expect(previewBody.links.canonical.href).toBe(`https://staging.pirate.sc/c/${communityCreateBody.community.route_slug}`)
    expect(previewBody.links.self.href).toBe(`http://pirate.test/public-communities/${communityCreateBody.community.id}`)
    expect(previewBody.links.markdown.href).toBe(`http://pirate.test/public-communities/${communityCreateBody.community.id}?format=markdown`)
    expect(previewBody.links.posts.href).toBe(`http://pirate.test/public-communities/${communityCreateBody.community.id}/posts`)

    const previewMarkdown = await app.request(
      `http://pirate.test/public-communities/${communityCreateBody.community.id}?format=markdown`,
      {},
      ctx.env,
    )
    expect(previewMarkdown.status).toBe(200)
    expect(previewMarkdown.headers.get("content-type")).toContain("text/markdown")
    expect(previewMarkdown.headers.get("cdn-cache-control")).toBe("public, s-maxage=60, stale-while-revalidate=300")
    expect(await previewMarkdown.text()).toContain("# Public Community Club")

    const posts = await app.request(
      `http://pirate.test/public-communities/${communityCreateBody.community.route_slug ?? communityCreateBody.community.id.replace(/^com_/, "")}/posts`,
      {},
      ctx.env,
    )
    expect(posts.status).toBe(200)
    expect(posts.headers.get("cdn-cache-control")).toBe("public, s-maxage=60, stale-while-revalidate=300")
    expect(posts.headers.get("cache-control")).toBe("public, max-age=0, s-maxage=60, stale-while-revalidate=300")
    const postsBody = await json(posts) as {
      items: Array<{
        post: { id: string; title: string | null }
        omitted_surfaces: unknown[]
        links: {
          self: { href: string; type: string }
          canonical: { href: string; type: string }
          community: { href: string; type: string }
          markdown: { href: string; type: string }
          top_comments: { href: string; type: string }
        }
      }>
      next_cursor: string | null
      omitted_surfaces: unknown[]
      links: {
        self: { href: string; type: string }
        community: { href: string; type: string }
      }
    }
    expect(postsBody.items).toHaveLength(2)
    expect(postsBody.items[0]?.post.id).toBe(secondPostBody.id)
    expect(postsBody.items[0]?.post.title).toBe("Second public route post")
    expect(postsBody.items[1]?.post.id).toBe(createdPostBody.id)
    expect(postsBody.items[1]?.post.title).toBe("Public route post")
    expect(postsBody.next_cursor).toBeNull()
    expect(posts.headers.get("link")).toContain("/public-communities/")
    expect(postsBody.omitted_surfaces).toEqual([])
    expect(postsBody.links.community.href).toBe(`http://pirate.test/public-communities/${communityCreateBody.community.id}`)
    expect(postsBody.items[0]?.omitted_surfaces).toEqual([])
    expect(postsBody.items[0]?.links.self.href).toBe(`http://pirate.test/public-posts/${secondPostBody.id}`)
    expect(postsBody.items[0]?.links.canonical.href).toBe(`https://staging.pirate.sc/p/${secondPostBody.id}`)
    expect(postsBody.items[0]?.links.markdown.href).toBe(`http://pirate.test/public-posts/${secondPostBody.id}?format=markdown`)
    expect(postsBody.items[0]?.links.top_comments.href).toBe(`http://pirate.test/public-posts/${secondPostBody.id}/top-comments`)

    const postsMarkdown = await app.request(
      `http://pirate.test/public-communities/${communityCreateBody.community.id}/posts?format=markdown`,
      {},
      ctx.env,
    )
    expect(postsMarkdown.status).toBe(200)
    expect(postsMarkdown.headers.get("content-type")).toContain("text/markdown")
    expect(await postsMarkdown.text()).toContain("Second public route post")

    const publicPost = await app.request(
      `http://pirate.test/public-posts/${createdPostBody.id}?locale=zh-Hans`,
      {},
      ctx.env,
    )
    expect(publicPost.status).toBe(200)
    expect(publicPost.headers.get("cdn-cache-control")).toBe("public, s-maxage=60, stale-while-revalidate=300")
    expect(publicPost.headers.get("cache-control")).toBe("public, max-age=0, s-maxage=60, stale-while-revalidate=300")
    const publicPostBody = await json(publicPost) as {
      post: { id: string; title: string | null }
      community: {
        id: string
        display_name: string
        description?: string | null
        avatar_ref?: string | null
        banner_ref?: string | null
      }
      resolved_locale: string
      translation_state: string
      omitted_surfaces: unknown[]
      links: {
        self: { href: string; type: string }
        canonical: { href: string; type: string }
        community: { href: string; type: string }
        markdown: { href: string; type: string }
        top_comments: { href: string; type: string }
      }
    }
    expect(publicPostBody.post.id).toBe(createdPostBody.id)
    expect(publicPostBody.post.title).toBe("Public route post")
    expect(publicPostBody.community.id).toBe(communityCreateBody.community.id)
    expect(publicPostBody.community.display_name).toBe("Public Community Club")
    expect(publicPostBody.community.description).toBe("Readable without reconnecting.")
    expect(publicPostBody.resolved_locale).toBe("zh-Hans")
    expect(publicPostBody.translation_state).toBe("policy_blocked")
    expect(publicPost.headers.get("link")).toContain("/public-posts/")
    expect(publicPostBody.omitted_surfaces).toEqual([])
    expect(publicPostBody.links.self.href).toBe(`http://pirate.test/public-posts/${createdPostBody.id}`)
    expect(publicPostBody.links.canonical.href).toBe(`https://staging.pirate.sc/p/${createdPostBody.id}`)
    expect(publicPostBody.links.community.href).toBe(`http://pirate.test/public-communities/${communityCreateBody.community.id}`)
    expect(publicPostBody.links.markdown.href).toBe(`http://pirate.test/public-posts/${createdPostBody.id}?format=markdown`)
    expect(publicPostBody.links.top_comments.href).toBe(`http://pirate.test/public-posts/${createdPostBody.id}/top-comments`)

    const publicPostMarkdown = await app.request(
      `http://pirate.test/public-posts/${createdPostBody.id}?format=markdown`,
      {},
      ctx.env,
    )
    expect(publicPostMarkdown.status).toBe(200)
    expect(publicPostMarkdown.headers.get("content-type")).toContain("text/markdown")
    expect(await publicPostMarkdown.text()).toContain("This should be visible without a session.")

    const topComments = await app.request(
      `http://pirate.test/public-posts/${createdPostBody.id}/top-comments`,
      {},
      ctx.env,
    )
    expect(topComments.status).toBe(200)
    expect(topComments.headers.get("cdn-cache-control")).toBe("public, s-maxage=60, stale-while-revalidate=300")
    expect(topComments.headers.get("cache-control")).toBe("public, max-age=0, s-maxage=60, stale-while-revalidate=300")
    const topCommentsBody = await json(topComments) as {
      items: unknown[]
      top_comments_limit: number
      links: {
        self: { href: string; type: string }
        markdown: { href: string; type: string }
        post: { href: string; type: string }
        community: { href: string; type: string }
      }
    }
    expect(topCommentsBody.items).toEqual([])
    expect(topCommentsBody.top_comments_limit).toBe(10)
    expect(topCommentsBody.links.self.href).toBe(`http://pirate.test/public-posts/${createdPostBody.id}/top-comments`)
    expect(topCommentsBody.links.markdown.href).toBe(`http://pirate.test/public-posts/${createdPostBody.id}/top-comments?format=markdown`)
    expect(topCommentsBody.links.post.href).toBe(`http://pirate.test/public-posts/${createdPostBody.id}`)
    expect(topCommentsBody.links.community.href).toBe(`http://pirate.test/public-communities/${communityCreateBody.community.id}`)

    const publicThread = await app.request(
      `http://pirate.test/public-posts/${createdPostBody.id}/thread?locale=zh-Hans&limit=10`,
      {},
      ctx.env,
    )
    expect(publicThread.status).toBe(200)
    expect(publicThread.headers.get("cdn-cache-control")).toBe("public, s-maxage=60, stale-while-revalidate=300")
    const publicThreadBody = await json(publicThread) as {
      post: { post: { id: string; title: string | null }; resolved_locale: string }
      community: { id: string; display_name: string }
      comments: { items: unknown[]; next_cursor: string | null }
      omitted_surfaces: unknown[]
      links: { self: { href: string }; community: { href: string } }
    }
    expect(publicThreadBody.post.post.id).toBe(createdPostBody.id)
    expect(publicThreadBody.post.post.title).toBe("Public route post")
    expect(publicThreadBody.community.id).toBe(communityCreateBody.community.id)
    expect(publicThreadBody.comments.items).toEqual([])
    expect(publicThreadBody.comments.next_cursor).toBeNull()
    expect(publicThreadBody.links.self.href).toBe(`http://pirate.test/public-posts/${createdPostBody.id}`)
    expect(publicThreadBody.links.community.href).toBe(`http://pirate.test/public-communities/${communityCreateBody.community.id}`)

    const topCommentsMarkdown = await app.request(
      `http://pirate.test/public-posts/${createdPostBody.id}/top-comments?format=markdown`,
      {},
      ctx.env,
    )
    expect(topCommentsMarkdown.status).toBe(200)
    expect(topCommentsMarkdown.headers.get("content-type")).toContain("text/markdown")
    expect(await topCommentsMarkdown.text()).toContain("# Top comments for Public route post")

    await ctx.client.execute({
      sql: `
        INSERT INTO machine_access_overrides (
          machine_access_override_id, community_id, surface, effect, reason_code, note, created_at
        )
        VALUES (?1, ?2, 'top_comments', 'disable', 'abuse_response', 'route test override', ?3)
      `,
      args: [
        "mao_route_top_comments",
        communityCreateBody.community.id.replace(/^com_/, ""),
        "2026-04-24T00:00:00.000Z",
      ],
    })

    const platformDisabledPublicPost = await app.request(
      `http://pirate.test/public-posts/${createdPostBody.id}`,
      {},
      ctx.env,
    )
    expect(platformDisabledPublicPost.status).toBe(200)
    const platformDisabledPublicPostBody = await json(platformDisabledPublicPost) as {
      omitted_surfaces: Array<{ surface: string; reason: string }>
      links: Record<string, unknown>
    }
    expect("top_comments" in platformDisabledPublicPostBody.links).toBe(false)
    expect(platformDisabledPublicPostBody.omitted_surfaces).toEqual([
      { surface: "top_comments", reason: "platform_disabled" },
    ])

    const platformDisabledTopComments = await app.request(
      `http://pirate.test/public-posts/${createdPostBody.id}/top-comments`,
      {},
      ctx.env,
    )
    expect(platformDisabledTopComments.status).toBe(403)
    const platformDisabledTopCommentsBody = await json(platformDisabledTopComments) as {
      code: string
      details?: { reason?: string; surface?: string }
    }
    expect(platformDisabledTopCommentsBody.code).toBe("structured_surface_disabled")
    expect(platformDisabledTopCommentsBody.details?.surface).toBe("top_comments")
    expect(platformDisabledTopCommentsBody.details?.reason).toBe("platform_disabled")

    await ctx.client.execute({
      sql: `
        UPDATE machine_access_overrides
        SET revoked_at = ?2,
            revoked_reason = 'route test complete'
        WHERE machine_access_override_id = ?1
      `,
      args: ["mao_route_top_comments", "2026-04-24T00:01:00.000Z"],
    })

    const patchPolicyResponse = await app.request(
      `http://pirate.test/communities/${communityCreateBody.community.id.replace(/^com_/, "")}/machine-access-policy`,
      {
        method: "POST",
        headers: {
          authorization: `Bearer ${session.accessToken}`,
          "content-type": "application/json",
        },
        body: JSON.stringify({
          included_surfaces: {
            community_stats: false,
            thread_bodies: false,
            top_comments: false,
          },
        }),
      },
      ctx.env,
    )
    expect(patchPolicyResponse.status).toBe(200)

    const disabledPreview = await app.request(
      `http://pirate.test/public-communities/${communityCreateBody.community.id}`,
      {},
      ctx.env,
    )
    expect(disabledPreview.status).toBe(200)
    const disabledPreviewBody = await json(disabledPreview) as {
      omitted_surfaces: Array<{ surface: string; reason: string }>
      member_count?: number
      follower_count?: number
    }
    expect("member_count" in disabledPreviewBody).toBe(false)
    expect("follower_count" in disabledPreviewBody).toBe(false)
    expect(disabledPreviewBody.omitted_surfaces).toEqual([
      { surface: "community_stats", reason: "community_opt_out" },
    ])

    const disabledPosts = await app.request(
      `http://pirate.test/public-communities/${communityCreateBody.community.id}/posts`,
      {},
      ctx.env,
    )
    expect(disabledPosts.status).toBe(200)
    const disabledPostsBody = await json(disabledPosts) as {
      omitted_surfaces: Array<{ surface: string; reason: string }>
      items: Array<{
        post: Record<string, unknown>
        omitted_surfaces: Array<{ surface: string; reason: string }>
        links: Record<string, unknown>
      }>
    }
    expect(disabledPostsBody.omitted_surfaces).toEqual([
      { surface: "thread_bodies", reason: "community_opt_out" },
      { surface: "top_comments", reason: "community_opt_out" },
    ])
    expect("body" in disabledPostsBody.items[0]!.post).toBe(false)
    expect("top_comments" in disabledPostsBody.items[0]!.links).toBe(false)
    expect(disabledPostsBody.items[0]!.omitted_surfaces).toEqual(disabledPostsBody.omitted_surfaces)

    const disabledPublicPost = await app.request(
      `http://pirate.test/public-posts/${createdPostBody.id}`,
      {},
      ctx.env,
    )
    expect(disabledPublicPost.status).toBe(200)
    const disabledPublicPostBody = await json(disabledPublicPost) as {
      post: Record<string, unknown>
      omitted_surfaces: Array<{ surface: string; reason: string }>
      links: Record<string, unknown>
    }
    expect("body" in disabledPublicPostBody.post).toBe(false)
    expect("top_comments" in disabledPublicPostBody.links).toBe(false)
    expect(disabledPublicPostBody.omitted_surfaces).toEqual([
      { surface: "community_stats", reason: "community_opt_out" },
      { surface: "thread_bodies", reason: "community_opt_out" },
      { surface: "top_comments", reason: "community_opt_out" },
    ])

    const disabledTopComments = await app.request(
      `http://pirate.test/public-posts/${createdPostBody.id}/top-comments`,
      {},
      ctx.env,
    )
    expect(disabledTopComments.status).toBe(403)
    const disabledTopCommentsBody = await json(disabledTopComments) as {
      code: string
      details?: { reason?: string; surface?: string }
    }
    expect(disabledTopCommentsBody.code).toBe("structured_surface_disabled")
    expect(disabledTopCommentsBody.details?.surface).toBe("top_comments")
    expect(disabledTopCommentsBody.details?.reason).toBe("community_opt_out")
  })

  test("public community SEO preview returns control-plane projection without community database access", async () => {
    const ctx = await createRouteTestContext({
      PIRATE_WEB_PUBLIC_ORIGIN: "https://staging.pirate.sc",
    })
    cleanup = ctx.cleanup

    const session = await exchangeJwt(ctx.env, "community-public-seo-preview-user")
    await completeUniqueHumanVerification(ctx.env, session.accessToken)

    const communityCreate = await requestJson("http://pirate.test/communities", {
      display_name: "SEO Preview Club",
      description: "Projected description for crawlers.",
      avatar_ref: "https://media.example/avatar.jpg",
      banner_ref: "https://media.example/banner.jpg",
      membership_mode: "request",
      handle_policy: {
        policy_template: "standard",
      },
    }, ctx.env, session.accessToken)
    expect(communityCreate.status).toBe(202)
    const communityCreateBody = await json(communityCreate) as {
      community: {
        id: string
        route_slug: string | null
      }
    }
    const communityId = communityCreateBody.community.id.replace(/^com_/, "")

    await ctx.client.execute({
      sql: `
        UPDATE community_database_bindings
        SET database_url = 'libsql' || '://unreachable-seo-preview.invalid',
            updated_at = CURRENT_TIMESTAMP
        WHERE community_id = ?1
      `,
      args: [communityId],
    })

    const preview = await app.request(
      `http://pirate.test/public-communities/${communityCreateBody.community.id}?preview=seo`,
      {},
      ctx.env,
    )
    expect(preview.status).toBe(200)
    const previewBody = await json(preview) as {
      id: string
      display_name: string
      description: string | null
      avatar_ref: string | null
      banner_ref: string | null
      localized_text: unknown
      omitted_surfaces: unknown[]
      links: {
        canonical: { href: string }
        self: { href: string }
      }
    }

    expect(previewBody.id).toBe(communityCreateBody.community.id)
    expect(previewBody.display_name).toBe("SEO Preview Club")
    expect(previewBody.description).toBe("Projected description for crawlers.")
    expect(previewBody.avatar_ref).toBe("https://media.example/avatar.jpg")
    expect(previewBody.banner_ref).toBe("https://media.example/banner.jpg")
    expect(previewBody.localized_text).toBeNull()
    expect(previewBody.omitted_surfaces).toEqual([])
    expect(previewBody.links.self.href).toBe(`http://pirate.test/public-communities/${communityCreateBody.community.id}`)
    expect(previewBody.links.canonical.href).toBe(`https://staging.pirate.sc/c/${communityCreateBody.community.id}`)
    expect(preview.headers.get("cdn-cache-control")).toBe("public, s-maxage=60, stale-while-revalidate=300")
    expect(preview.headers.get("cache-control")).toBe("public, max-age=0, s-maxage=60, stale-while-revalidate=300")
  })

  test("community reads expose localized text overlays and enqueue one batch translation job per locale", async () => {
    const ctx = await createRouteTestContext()
    cleanup = ctx.cleanup

    const session = await exchangeJwt(ctx.env, "community-localized-read-user")
    await completeUniqueHumanVerification(ctx.env, session.accessToken)

    const communityCreate = await requestJson("http://pirate.test/communities", {
      display_name: "Localized Community Club",
      description: "Welcome to the community.",
      membership_mode: "request",
      handle_policy: {
        policy_template: "standard",
      },
    }, ctx.env, session.accessToken)
    expect(communityCreate.status).toBe(202)
    const communityCreateBody = await json(communityCreate) as {
      community: {
        id: string
      }
    }

    const rulesResponse = await app.request(
      `http://pirate.test/communities/${communityCreateBody.community.id.replace(/^com_/, "")}/rules`,
      {
        method: "POST",
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
      url: buildLocalCommunityDbUrl(String(ctx.env.LOCAL_COMMUNITY_DB_ROOT), communityCreateBody.community.id.replace(/^com_/, "")),
    })
    try {
      await localClient.execute({
        sql: `
          UPDATE communities
          SET settings_json = ?2
          WHERE community_id = ?1
        `,
        args: [
          communityCreateBody.community.id.replace(/^com_/, ""),
          JSON.stringify({
            reference_links: [
              {
                community_reference_link: "crl_sidebar",
                object: "community_reference_link",
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
        `http://pirate.test/communities/${communityCreateBody.community.id.replace(/^com_/, "")}?locale=es`,
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
        args: [`${communityCreateBody.community.id.replace(/^com_/, "")}:es`],
      })
      expect(jobs.rows).toHaveLength(1)
      expect(String(jobs.rows[0]?.job_type)).toBe("community_text_translation_materialize")
      expect(String(jobs.rows[0]?.subject_id)).toBe(`${communityCreateBody.community.id.replace(/^com_/, "")}:es`)
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
      membership_mode: "request",
      namespace: {
        namespace_verification: namespaceVerificationId,
      },
    }, ctx.env, session.accessToken)
    expect(communityCreate.status).toBe(202)
    const communityCreateBody = await json(communityCreate) as {
      community: {
        id: string
        route_slug: string | null
      }
    }

    const publicPost = await requestJson(
      `http://pirate.test/communities/${communityCreateBody.community.id.replace(/^com_/, "")}/posts`,
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
      id: string
      visibility: string
    }
    expect(publicPostBody.visibility).toBe("public")

    const privatePost = await requestJson(
      `http://pirate.test/communities/${communityCreateBody.community.id.replace(/^com_/, "")}/posts`,
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
      id: string
      visibility: string
    }
    expect(privatePostBody.visibility).toBe("members_only")

    const memberRead = await app.request(
      `http://pirate.test/posts/${privatePostBody.id}`,
      {
        headers: {
          authorization: `Bearer ${session.accessToken}`,
        },
      },
      ctx.env,
    )
    expect(memberRead.status).toBe(200)
    const memberReadBody = await json(memberRead) as {
      post: { id: string; visibility: string }
    }
    expect(memberReadBody.post.id).toBe(privatePostBody.id)
    expect(memberReadBody.post.visibility).toBe("members_only")

    const publicPosts = await app.request(
      `http://pirate.test/public-communities/${communityCreateBody.community.route_slug ?? communityCreateBody.community.id.replace(/^com_/, "")}/posts`,
      {},
      ctx.env,
    )
    expect(publicPosts.status).toBe(200)
    const publicPostsBody = await json(publicPosts) as {
      items: Array<{ post: { id: string } }>
    }
    expect(publicPostsBody.items.map((item) => item.post.id)).toEqual([publicPostBody.id])

    const hiddenPublicPost = await app.request(
      `http://pirate.test/public-posts/${privatePostBody.id}`,
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
      args: [communityCreateBody.community.id.replace(/^com_/, "")],
    })
    expect(projectionRows.rows).toEqual([
      { source_post_id: stripPublicPrefix(publicPostBody.id, "post"), visibility: "public" },
      { source_post_id: stripPublicPrefix(privatePostBody.id, "post"), visibility: "members_only" },
    ])
  })

  test("community create, job fetch, post create, and post read work through the full route stack", async () => {
    const ctx = await createRouteTestContext()
    cleanup = ctx.cleanup

    const session = await exchangeJwt(ctx.env, "community-user")
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
      community: {
        id: string
        display_name: string
        namespace_verification: string | null
        route_slug: string | null
        provisioning_state: string
        status: string
      }
      job: { id: string; status: string }
    }
    expect(communityCreateBody.community.display_name).toBe("Pirate Test Club")
    expect(communityCreateBody.community.namespace_verification).toBe(namespaceVerificationId)
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
      `http://pirate.test/communities/${communityCreateBody.community.id.replace(/^com_/, "")}`,
      {
        headers: {
          authorization: `Bearer ${session.accessToken}`,
        },
      },
      ctx.env,
    )
    expect(communityGet.status).toBe(200)

    const jobGet = await app.request(
      `http://pirate.test/jobs/${communityCreateBody.job.id}`,
      {
        headers: {
          authorization: `Bearer ${session.accessToken}`,
        },
      },
      ctx.env,
    )
    expect(jobGet.status).toBe(200)
    const jobBody = await json(jobGet) as { status: string; subject: string }
    expect(jobBody.status).toBe("succeeded")
    expect(jobBody.subject).toBe(communityCreateBody.community.id.replace(/^com_/, ""))

    const createdPost = await requestJson(
      `http://pirate.test/communities/${communityCreateBody.community.id.replace(/^com_/, "")}/posts`,
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
      id: string
      community: string
      status: string
      title: string | null
      author_user: string | null
    }
    expect(postBody.community).toBe(communityCreateBody.community.id)
    expect(postBody.status).toBe("published")
    expect(postBody.title).toBe("Hello Pirate")
    expect(postBody.author_user).toBe(`usr_${session.userId}`)

    const retriedPost = await requestJson(
      `http://pirate.test/communities/${communityCreateBody.community.id.replace(/^com_/, "")}/posts`,
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
      id: string
      community: string
      status: string
    }
    expect(retriedPostBody.id).toBe(postBody.id)
    expect(retriedPostBody.community).toBe(postBody.community)
    expect(retriedPostBody.status).toBe("published")

    const fetchedPost = await app.request(
      `http://pirate.test/posts/${postBody.id}?locale=es`,
      {
        headers: {
          authorization: `Bearer ${session.accessToken}`,
        },
      },
      ctx.env,
    )
    expect(fetchedPost.status).toBe(200)
    const fetchedPostBody = await json(fetchedPost) as {
      post: { id: string; title: string | null }
      resolved_locale: string
      translation_state: string
    }
    expect(fetchedPostBody.post.id).toBe(postBody.id)
    expect(fetchedPostBody.post.title).toBe("Hello Pirate")
    expect(fetchedPostBody.resolved_locale).toBe("es")
    expect(fetchedPostBody.translation_state).toBe("policy_blocked")

    const reviewHeldPost = await requestJson(
      `http://pirate.test/communities/${communityCreateBody.community.id.replace(/^com_/, "")}/posts`,
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
      id: string
      community: string
      status: string
      analysis_state: string
      content_safety_state: string
    }
    expect(reviewHeldPostBody.community).toBe(communityCreateBody.community.id)
    expect(reviewHeldPostBody.status).toBe("draft")
    expect(reviewHeldPostBody.analysis_state).toBe("review_required")
    expect(reviewHeldPostBody.content_safety_state).toBe("pending")

    const fetchedReviewHeldPost = await app.request(
      `http://pirate.test/posts/${reviewHeldPostBody.id}?locale=es`,
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
        id: string
        status: string
        analysis_state: string
        content_safety_state: string
      }
      resolved_locale: string
      translation_state: string
    }
    expect(fetchedReviewHeldPostBody.post.id).toBe(reviewHeldPostBody.id)
    expect(fetchedReviewHeldPostBody.post.status).toBe("draft")
    expect(fetchedReviewHeldPostBody.post.analysis_state).toBe("review_required")
    expect(fetchedReviewHeldPostBody.post.content_safety_state).toBe("pending")
    expect(fetchedReviewHeldPostBody.resolved_locale).toBe("es")
    expect(fetchedReviewHeldPostBody.translation_state).toBe("policy_blocked")

    const blockedPost = await requestJson(
      `http://pirate.test/communities/${communityCreateBody.community.id.replace(/^com_/, "")}/posts`,
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
      args: [communityCreateBody.community.id.replace(/^com_/, "")],
    })
    expect(Number(controlPlaneProjectionCount.rows[0]?.count ?? 0)).toBe(2)

    const communityDb = createClient({
      url: buildLocalCommunityDbUrl(ctx.communityDbRoot, communityCreateBody.community.id.replace(/^com_/, "")),
    })
    try {
      const communityPostCount = await communityDb.execute({
        sql: `
          SELECT COUNT(*) AS count
          FROM posts
          WHERE community_id = ?1
        `,
        args: [communityCreateBody.community.id.replace(/^com_/, "")],
      })
      expect(Number(communityPostCount.rows[0]?.count ?? 0)).toBe(2)
    } finally {
      communityDb.close()
    }

    const listedPosts = await app.request(
      `http://pirate.test/communities/${communityCreateBody.community.id.replace(/^com_/, "")}/posts?locale=es`,
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
        post: { id: string; status: string }
        resolved_locale: string
      }>
      next_cursor: string | null
    }
    expect(listedPostsBody.items).toHaveLength(1)
    expect(listedPostsBody.items[0]?.post.id).toBe(postBody.id)
    expect(listedPostsBody.items[0]?.post.status).toBe("published")
    expect(listedPostsBody.items[0]?.resolved_locale).toBe("es")
    expect(listedPostsBody.items.some((item) => item.post.id === reviewHeldPostBody.id)).toBe(false)
    expect(listedPostsBody.next_cursor).toBeNull()
  })

  test("community create returns 400 for missing required fields", async () => {
    const ctx = await createRouteTestContext()
    cleanup = ctx.cleanup

    const session = await exchangeJwt(ctx.env, "community-invalid-create")

    const response = await requestJson("http://pirate.test/communities", {
      display_name: "",
membership_mode: "request",
      governance_mode: "multisig",
      namespace: {},
    }, ctx.env, session.accessToken)

    expect(response.status).toBe(400)
    const body = await json(response) as { code: string }
    expect(body.code).toBe("bad_request")
  })

})
