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
import type { Env } from "../../../src/types"

let cleanup: (() => Promise<void>) | null = null

function settingsJson(body: Record<string, unknown>): string {
  return JSON.stringify(body)
}

async function withHnsVerifierMock<T>(env: Env, run: () => Promise<T>): Promise<T> {
  const originalFetch = globalThis.fetch
  const originalHnsVerifierBaseUrl = env.HNS_VERIFIER_BASE_URL
  const originalHnsVerifierAuthToken = env.HNS_VERIFIER_AUTH_TOKEN
  env.HNS_VERIFIER_BASE_URL = "http://hns-verifier.test"
  env.HNS_VERIFIER_AUTH_TOKEN = "test-hns-token"
  globalThis.fetch = (async (input: RequestInfo | URL, init?: RequestInit) => {
    const url = typeof input === "string" ? input : input.toString()
    if (url.startsWith("http://hns-verifier.test")) {
      if (url.includes("/inspect-public?")) {
        return new Response(JSON.stringify({
          root_exists: true,
          root_control_verified: true,
          expiry_horizon_sufficient: true,
          routing_enabled: true,
          pirate_dns_authority_verified: true,
          club_attach_allowed: true,
          pirate_web_routing_allowed: true,
          pirate_subdomain_issuance_allowed: true,
          operation_class: "pirate_delegated_namespace",
          observation_provider: "web3dns_json_doh",
        }), { status: 200, headers: { "content-type": "application/json" } })
      }
      if (url.endsWith("/verify-txt-public")) {
        return new Response(JSON.stringify({
          verified: true,
          ownership_source: "hns_parent_chain_txt",
          root_exists: true,
          root_control_verified: true,
          expiry_horizon_sufficient: true,
          routing_enabled: true,
          pirate_dns_authority_verified: true,
          club_attach_allowed: true,
          pirate_web_routing_allowed: true,
          pirate_subdomain_issuance_allowed: true,
          operation_class: "pirate_delegated_namespace",
          observation_provider: "web3dns_json_doh",
        }), { status: 200, headers: { "content-type": "application/json" } })
      }
      // Provisioning publishes the session nonce into the child zone...
      if (url.endsWith("/publish-txt") || url.endsWith("/ensure-zone")) {
        return new Response(JSON.stringify({
          root_label: "piratecommunityroot",
          zone_name: "piratecommunityroot.",
          challenge_name: "_pirate.piratecommunityroot.",
          zone_created: true,
          nameservers: ["ns1.pirate."],
          observation_provider: "powerdns_api",
        }), { status: 200, headers: { "content-type": "application/json" } })
      }
      // ...and the authority-health check reads it back through the serving path.
      if (url.includes("/authority-health")) {
        return new Response(JSON.stringify({
          root_label: "piratecommunityroot",
          zone_name: "piratecommunityroot.",
          challenge_name: "_pirate.piratecommunityroot.",
          zone_provisioned: true,
          challenge_present: true,
          challenge_served: true,
          nameservers: ["ns1.pirate."],
          observation_provider: "powerdns_api",
        }), { status: 200, headers: { "content-type": "application/json" } })
      }
    }
    return originalFetch(input, init)
  }) as typeof fetch

  try {
    return await run()
  } finally {
    globalThis.fetch = originalFetch
    env.HNS_VERIFIER_BASE_URL = originalHnsVerifierBaseUrl
    env.HNS_VERIFIER_AUTH_TOKEN = originalHnsVerifierAuthToken
  }
}

function genderGatePolicy(...allowed: string[]): Record<string, unknown> {
  if (allowed.length === 1) {
    return {
      version: 1,
      expression: {
        op: "gate",
        gate: { type: "gender", provider: "self", allowed },
      },
    }
  }
  return {
    version: 1,
    expression: {
      op: "and",
      children: allowed.map((value) => ({
        op: "gate",
        gate: { type: "gender", provider: "self", allowed: [value] },
      })),
    },
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

describe("community settings routes", () => {
  test("community owner can archive and unarchive while strangers are denied", async () => {
    const ctx = await createRouteTestContext()
    cleanup = ctx.cleanup

    const owner = await exchangeJwt(ctx.env, "community-lifecycle-owner")
    const stranger = await exchangeJwt(ctx.env, "community-lifecycle-stranger")

    const communityCreate = await requestJson("http://pirate.test/communities", {
      display_name: "Lifecycle Route Club",
      membership_mode: "request",
      handle_policy: {
        policy_template: "standard",
      },
    }, ctx.env, owner.accessToken)
    expect(communityCreate.status).toBe(202)
    const communityCreateBody = await json(communityCreate) as {
      community: {
        id: string
      }
    }
    const communityId = communityCreateBody.community.id.replace(/^com_/, "")

    const strangerArchive = await app.request(
      `http://pirate.test/communities/${communityId}/archive`,
      {
        method: "POST",
        headers: {
          authorization: `Bearer ${stranger.accessToken}`,
        },
      },
      ctx.env,
    )
    expect(strangerArchive.status).toBe(404)

    const ownerArchive = await app.request(
      `http://pirate.test/communities/${communityId}/archive`,
      {
        method: "POST",
        headers: {
          authorization: `Bearer ${owner.accessToken}`,
        },
      },
      ctx.env,
    )
    expect(ownerArchive.status).toBe(200)
    expect(await json(ownerArchive)).toMatchObject({
      community_id: communityId,
      status: "archived",
    })
    expect((await getCommunityControlPlaneState(ctx.env, communityId)).status).toBe("archived")

    const ownerUnarchive = await app.request(
      `http://pirate.test/communities/${communityId}/unarchive`,
      {
        method: "POST",
        headers: {
          authorization: `Bearer ${owner.accessToken}`,
        },
      },
      ctx.env,
    )
    expect(ownerUnarchive.status).toBe(200)
    expect(await json(ownerUnarchive)).toMatchObject({
      community_id: communityId,
      status: "active",
    })
    expect((await getCommunityControlPlaneState(ctx.env, communityId)).status).toBe("active")
  })

  test("label settings update returns the public community contract shape", async () => {
    const ctx = await createRouteTestContext()
    cleanup = ctx.cleanup

    const session = await exchangeJwt(ctx.env, "community-label-contract-user")
    await completeUniqueHumanVerification(ctx.env, session.accessToken)

    const communityCreate = await requestJson("http://pirate.test/communities", {
      display_name: "Label Contract Club",
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

    const labelsUpdate = await app.request(
      `http://pirate.test/communities/${communityCreateBody.community.id.replace(/^com_/, "")}/labels`,
      {
        method: "POST",
        headers: {
          "content-type": "application/json",
          authorization: `Bearer ${session.accessToken}`,
        },
        body: settingsJson({
          label_enabled: true,
          require_label_on_top_level_posts: false,
          definitions: [{
            label_id: null,
            label: "Discussion",
            color_token: "#6377f0",
            status: "active",
            position: 0,
          }],
        }),
      },
      ctx.env,
    )
    expect(labelsUpdate.status).toBe(200)
    const updatedCommunity = await labelsUpdate.json() as {
      id?: string
      community_id?: string
      created_by_user?: string
      created_by_user_id?: string
      label_policy?: {
        label_enabled?: boolean
        definitions?: Array<{ label: string }>
      } | null
    }

    expect(updatedCommunity.id).toBe(`com_${communityCreateBody.community.id.replace(/^com_/, "")}`)
    expect(updatedCommunity.community_id).toBe(undefined)
    expect(updatedCommunity.created_by_user).toBe(`usr_${session.userId}`)
    expect(updatedCommunity.created_by_user_id).toBe(undefined)
    expect(updatedCommunity.label_policy?.label_enabled).toBe(true)
    expect(updatedCommunity.label_policy?.definitions?.[0]?.label).toBe("Discussion")
  })

  test("community owner can persist and read a pending namespace verification session", async () => {
    const ctx = await createRouteTestContext()
    cleanup = ctx.cleanup

    const session = await exchangeJwt(ctx.env, "community-pending-session-user")
    await completeUniqueHumanVerification(ctx.env, session.accessToken)

    const communityCreate = await requestJson("http://pirate.test/communities", {
      display_name: "Pending Namespace Club",
membership_mode: "request",
      handle_policy: {
        policy_template: "standard",
      },
    }, ctx.env, session.accessToken)
    expect(communityCreate.status).toBe(202)
    const communityCreateBody = await json(communityCreate) as {
      community: {
        id: string
        pending_namespace_verification_session: string | null
      }
    }
    expect(communityCreateBody.community.pending_namespace_verification_session).toBeNull()

    const namespaceSession = await withHnsVerifierMock(ctx.env, () =>
      requestJson("http://pirate.test/namespace-verification-sessions", {
        family: "hns",
        root_label: "PendingAttachRoot",
      }, ctx.env, session.accessToken)
    )
    expect(namespaceSession.status).toBe(201)
    const namespaceSessionBody = await json(namespaceSession) as {
      id: string
    }

    const pendingUpdate = await Promise.resolve(app.request(
      `http://pirate.test/communities/${communityCreateBody.community.id.replace(/^com_/, "")}/pending-namespace-session`,
      {
        method: "POST",
        headers: {
          "content-type": "application/json",
          authorization: `Bearer ${session.accessToken}`,
        },
        body: settingsJson({
          namespace_verification_session_id: namespaceSessionBody.id,
        }),
      },
      ctx.env,
    ))
    expect(pendingUpdate.status).toBe(200)
    const updatedCommunity = await json(pendingUpdate) as {
      pending_namespace_verification_session: string | null
    }
    expect(updatedCommunity.pending_namespace_verification_session).toBe(
      namespaceSessionBody.id,
    )

    const fetchedCommunity = await app.request(
      `http://pirate.test/communities/${communityCreateBody.community.id.replace(/^com_/, "")}`,
      {
        headers: {
          authorization: `Bearer ${session.accessToken}`,
        },
      },
      ctx.env,
    )
    expect(fetchedCommunity.status).toBe(200)
    const fetchedBody = await json(fetchedCommunity) as {
      pending_namespace_verification_session: string | null
    }
    expect(fetchedBody.pending_namespace_verification_session).toBe(
      namespaceSessionBody.id,
    )
  })

  test("community owner can reattach a newly verified session for the same namespace root", async () => {
    const ctx = await createRouteTestContext()
    cleanup = ctx.cleanup

    const session = await exchangeJwt(ctx.env, "community-same-namespace-reattach-user")
    await completeUniqueHumanVerification(ctx.env, session.accessToken)

    const communityCreate = await requestJson("http://pirate.test/communities", {
      display_name: "Same Namespace Club",
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

    const firstCompletedBody = await withHnsVerifierMock(ctx.env, async () => {
      const firstNamespaceSession = await requestJson("http://pirate.test/namespace-verification-sessions", {
        family: "hns",
        root_label: "SameNamespaceRoot",
      }, ctx.env, session.accessToken)
      const firstNamespaceSessionBody = await json(firstNamespaceSession) as {
        id: string
      }
      const firstCompleted = await requestJson(
        `http://pirate.test/namespace-verification-sessions/${firstNamespaceSessionBody.id}/complete`,
        {},
        ctx.env,
        session.accessToken,
      )
      return json(firstCompleted) as Promise<{ namespace_verification: string }>
    })

    const firstAttach = await requestJson(
      `http://pirate.test/communities/${communityCreateBody.community.id.replace(/^com_/, "")}/namespace`,
      { namespace_verification: firstCompletedBody.namespace_verification },
      ctx.env,
      session.accessToken,
    )
    expect(firstAttach.status).toBe(200)

    const secondNamespace = await withHnsVerifierMock(ctx.env, async () => {
      const secondNamespaceSession = await requestJson("http://pirate.test/namespace-verification-sessions", {
        family: "hns",
        root_label: "SameNamespaceRoot",
      }, ctx.env, session.accessToken)
      const secondNamespaceSessionBody = await json(secondNamespaceSession) as {
        id: string
      }
      const secondCompleted = await requestJson(
        `http://pirate.test/namespace-verification-sessions/${secondNamespaceSessionBody.id}/complete`,
        {},
        ctx.env,
        session.accessToken,
      )
      return {
        session: secondNamespaceSessionBody.id,
        completed: await json(secondCompleted) as { namespace_verification: string },
      }
    })
    const secondCompletedBody = secondNamespace.completed
    expect(secondCompletedBody.namespace_verification).not.toBe(firstCompletedBody.namespace_verification)

    const pendingUpdate = await Promise.resolve(app.request(
      `http://pirate.test/communities/${communityCreateBody.community.id.replace(/^com_/, "")}/pending-namespace-session`,
      {
        method: "POST",
        headers: {
          "content-type": "application/json",
          authorization: `Bearer ${session.accessToken}`,
        },
        body: settingsJson({
          id: secondNamespace.session,
        }),
      },
      ctx.env,
    ))
    expect(pendingUpdate.status).toBe(200)

    const secondAttach = await requestJson(
      `http://pirate.test/communities/${communityCreateBody.community.id.replace(/^com_/, "")}/namespace`,
      { namespace_verification: secondCompletedBody.namespace_verification },
      ctx.env,
      session.accessToken,
    )
    expect(secondAttach.status).toBe(200)
    const secondAttachBody = await json(secondAttach) as {
      namespace_verification: string | null
      pending_namespace_verification_session: string | null
      route_slug: string | null
    }
    expect(secondAttachBody.namespace_verification).toBe(firstCompletedBody.namespace_verification)
    expect(secondAttachBody.pending_namespace_verification_session).toBeNull()
    expect(secondAttachBody.route_slug).toBe("samenamespaceroot")
  })

  test("community owner can attach a verified mirror without replacing the primary route", async () => {
    const ctx = await createRouteTestContext()
    cleanup = ctx.cleanup
    const session = await exchangeJwt(ctx.env, "community-mirror-namespace-user")
    await completeUniqueHumanVerification(ctx.env, session.accessToken)

    const communityCreate = await requestJson("http://pirate.test/communities", {
      display_name: "Pokemon Mirrors Club",
      membership_mode: "request",
      handle_policy: { policy_template: "standard" },
    }, ctx.env, session.accessToken)
    expect(communityCreate.status).toBe(202)
    const community = await json(communityCreate) as { community: { id: string } }
    const communityId = community.community.id.replace(/^com_/, "")

    const completeRoot = async (rootLabel: string): Promise<string> => {
      const started = await requestJson("http://pirate.test/namespace-verification-sessions", {
        family: "hns",
        root_label: rootLabel,
      }, ctx.env, session.accessToken)
      const startedBody = await json(started) as { id: string }
      const completed = await requestJson(
        `http://pirate.test/namespace-verification-sessions/${startedBody.id}/complete`,
        {},
        ctx.env,
        session.accessToken,
      )
      const completedBody = await json(completed) as { namespace_verification: string }
      return completedBody.namespace_verification
    }

    const { primaryVerification, mirrorVerification } = await withHnsVerifierMock(ctx.env, async () => ({
      primaryVerification: await completeRoot("pokemon"),
      mirrorVerification: await completeRoot("charizard"),
    }))

    const primaryAttach = await requestJson(
      `http://pirate.test/communities/${communityId}/namespace`,
      { namespace_verification: primaryVerification, namespace_role: "primary" },
      ctx.env,
      session.accessToken,
    )
    expect(primaryAttach.status).toBe(200)

    const mirrorAttach = await requestJson(
      `http://pirate.test/communities/${communityId}/namespace`,
      { namespace_verification: mirrorVerification, namespace_role: "mirror" },
      ctx.env,
      session.accessToken,
    )
    expect(mirrorAttach.status).toBe(200)
    const mirrorAttachBody = await json(mirrorAttach) as {
      namespace_verification: string
      route_slug: string
    }
    expect(mirrorAttachBody.namespace_verification).toBe(primaryVerification)
    expect(mirrorAttachBody.route_slug).toBe("pokemon")

    const bindings = await ctx.client.execute({
      sql: `
        SELECT namespace_role, namespace_verification_id
        FROM community_namespace_bindings
        WHERE community_id = ?1 AND status = 'active'
        ORDER BY namespace_role DESC
      `,
      args: [communityId],
    })
    expect(bindings.rows).toEqual([
      {
        namespace_role: "primary",
        namespace_verification_id: primaryVerification.replace(/^nv_/, ""),
      },
      {
        namespace_role: "mirror",
        namespace_verification_id: mirrorVerification.replace(/^nv_/, ""),
      },
    ])

    const communityClient = createClient({
      url: buildLocalCommunityDbUrl(ctx.communityDbRoot, communityId),
    })
    try {
      const policies = await communityClient.execute({
        sql: `
          SELECT nb.namespace_role, nhp.claims_enabled
          FROM namespace_bindings nb
          JOIN namespace_handle_policies nhp ON nhp.namespace_id = nb.namespace_id
          WHERE nb.community_id = ?1 AND nb.status = 'active'
          ORDER BY nb.namespace_role DESC
        `,
        args: [communityId],
      })
      expect(policies.rows).toEqual([
        { namespace_role: "primary", claims_enabled: 1 },
        { namespace_role: "mirror", claims_enabled: 0 },
      ])
    } finally {
      communityClient.close()
    }

    const mirrorSelector = `namespace_verification=${encodeURIComponent(mirrorVerification)}`
    const mirrorPolicy = await app.request(
      `http://pirate.test/communities/${communityId}/handle-policy?${mirrorSelector}`,
      { headers: { authorization: `Bearer ${session.accessToken}` } },
      ctx.env,
    )
    expect(mirrorPolicy.status).toBe(200)
    expect((await json(mirrorPolicy) as { claims_enabled: boolean }).claims_enabled).toBe(false)

    const reservedMirrorHandle = await requestJson(
      `http://pirate.test/communities/${communityId}/handles/reserve?${mirrorSelector}`,
      { desired_label: "ash" },
      ctx.env,
      session.accessToken,
    )
    expect(reservedMirrorHandle.status).toBe(200)

    const mirrorHandles = await app.request(
      `http://pirate.test/communities/${communityId}/handles?${mirrorSelector}`,
      { headers: { authorization: `Bearer ${session.accessToken}` } },
      ctx.env,
    )
    expect(mirrorHandles.status).toBe(200)
    expect((await json(mirrorHandles) as { handles: unknown[] }).handles).toHaveLength(1)

    const primaryHandles = await app.request(
      `http://pirate.test/communities/${communityId}/handles`,
      { headers: { authorization: `Bearer ${session.accessToken}` } },
      ctx.env,
    )
    expect(primaryHandles.status).toBe(200)
    expect((await json(primaryHandles) as { handles: unknown[] }).handles).toHaveLength(0)

    const byMirror = await app.request("http://pirate.test/communities/charizard", {
      headers: { authorization: `Bearer ${session.accessToken}` },
    }, ctx.env)
    expect(byMirror.status).toBe(200)
  }, 15_000)

  test("community owner can persist safety moderation settings", async () => {
    const ctx = await createRouteTestContext()
    cleanup = ctx.cleanup

    const session = await exchangeJwt(ctx.env, "community-safety-user")
    await completeUniqueHumanVerification(ctx.env, session.accessToken)

    const communityCreate = await requestJson("http://pirate.test/communities", {
      display_name: "Safety Club",
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

    const safetyUpdate = await Promise.resolve(app.request(
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
            injury_medical: "allow",
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
            scan_post_bodies: false,
            scan_captions: true,
            scan_link_preview_text: false,
            scan_images: true,
          },
        }),
      },
      ctx.env,
    ))
    expect(safetyUpdate.status).toBe(200)
    const updatedCommunity = await json(safetyUpdate) as {
      adult_content_policy: {
        artistic_nudity: string
        explicit_nudity: string
      }
      civility_policy: {
        threatening_language: string
      }
      openai_moderation_settings: {
        scan_post_bodies: boolean
        scan_images: boolean
      } | null
    }
    expect(updatedCommunity.adult_content_policy.artistic_nudity).toBe("allow")
    expect(updatedCommunity.adult_content_policy.explicit_nudity).toBe("disallow")
    expect(updatedCommunity.civility_policy.threatening_language).toBe("disallow")
    expect(updatedCommunity.openai_moderation_settings?.scan_post_bodies).toBe(false)
    expect(updatedCommunity.openai_moderation_settings?.scan_images).toBe(true)

    const fetchedCommunity = await app.request(
      `http://pirate.test/communities/${communityCreateBody.community.id.replace(/^com_/, "")}`,
      {
        headers: {
          authorization: `Bearer ${session.accessToken}`,
        },
      },
      ctx.env,
    )
    expect(fetchedCommunity.status).toBe(200)
    const fetchedBody = await json(fetchedCommunity) as {
      adult_content_policy: {
        fetish_content: string
      }
      graphic_content_policy: {
        gore: string
      }
      openai_moderation_settings: {
        scan_link_preview_text: boolean
      } | null
    }
    expect(fetchedBody.adult_content_policy.fetish_content).toBe("review")
    expect(fetchedBody.graphic_content_policy.gore).toBe("review")
    expect(fetchedBody.openai_moderation_settings?.scan_link_preview_text).toBe(false)
  })

  test("community owner can persist visual policy settings", async () => {
    const ctx = await createRouteTestContext()
    cleanup = ctx.cleanup

    const session = await exchangeJwt(ctx.env, "community-visual-policy-user")
    await completeUniqueHumanVerification(ctx.env, session.accessToken)

    const communityCreate = await requestJson("http://pirate.test/communities", {
      display_name: "Visual Club",
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

    const visualPolicySettings = {
      topless: "allow",
      visible_nipples: "allow",
      visible_buttocks: "queue",
      visible_genitals: "reject",
      bottomless_obscured: "queue",
      implied_sexual_activity: "queue",
      explicit_sexual_activity: "reject",
      sexualized_contact: "reject",
      masturbation: "reject",
      oral_sex: "reject",
      sex_toy_packaging: "queue",
      sex_toy_visible: "queue",
      sex_toy_in_use: "reject",
      anime_manga: "allow",
      furry_anthro: "allow",
      fictional_nudity: "allow",
      fictional_explicit_sex: "queue",
      ambiguous_fictional_age_with_adult_content: "queue",
      possible_minor_with_adult_content: "reject",
      ai_generated_images: "allow",
      ai_generated_adult_images: "queue",
      deepfake_or_face_swap_risk: "reject",
      celebrity_adult_likeness: "reject",
      voyeuristic_or_hidden_camera: "reject",
      watermark: "allow",
      adult_platform_watermark: "queue",
      product_promotion: "allow_with_disclosure",
      affiliate_or_sales_link: "queue",
      qr_code: "reject",
      payment_handle: "queue",
      urls_in_image: "queue",
      weapons: "reject",
      gore_or_injury: "reject",
      drugs: "queue",
      hate_symbols: "reject",
      personal_documents: "queue",
      uncertain_age_with_adult_content: "queue",
      low_quality_adult_image: "queue",
      model_uncertain: "queue",
    } as const

    const visualPolicyUpdate = await app.request(
      `http://pirate.test/communities/${communityCreateBody.community.id.replace(/^com_/, "")}/visual-policy`,
      {
        method: "POST",
        headers: {
          "content-type": "application/json",
          authorization: `Bearer ${session.accessToken}`,
        },
        body: settingsJson({
          visual_policy_settings: visualPolicySettings,
        }),
      },
      ctx.env,
    )
    expect(visualPolicyUpdate.status).toBe(200)
    const updatedCommunity = await json(visualPolicyUpdate) as {
      visual_policy_settings: {
        fictional_explicit_sex: string
        product_promotion: string
        qr_code: string
        voyeuristic_or_hidden_camera: string
      }
    }
    expect(updatedCommunity.visual_policy_settings.fictional_explicit_sex).toBe("queue")
    expect(updatedCommunity.visual_policy_settings.product_promotion).toBe("allow_with_disclosure")
    expect(updatedCommunity.visual_policy_settings.qr_code).toBe("reject")
    expect(updatedCommunity.visual_policy_settings.voyeuristic_or_hidden_camera).toBe("reject")

    const invalidFloorUpdate = await app.request(
      `http://pirate.test/communities/${communityCreateBody.community.id.replace(/^com_/, "")}/visual-policy`,
      {
        method: "POST",
        headers: {
          "content-type": "application/json",
          authorization: `Bearer ${session.accessToken}`,
        },
        body: settingsJson({
          visual_policy_settings: {
            ...visualPolicySettings,
            voyeuristic_or_hidden_camera: "queue",
          },
        }),
      },
      ctx.env,
    )
    expect(invalidFloorUpdate.status).toBe(400)

    const fetchedCommunity = await app.request(
      `http://pirate.test/communities/${communityCreateBody.community.id.replace(/^com_/, "")}`,
      {
        headers: {
          authorization: `Bearer ${session.accessToken}`,
        },
      },
      ctx.env,
    )
    expect(fetchedCommunity.status).toBe(200)
    const fetchedBody = await json(fetchedCommunity) as {
      visual_policy_settings: {
        fictional_explicit_sex: string
        qr_code: string
      }
    }
    expect(fetchedBody.visual_policy_settings.fictional_explicit_sex).toBe("queue")
    expect(fetchedBody.visual_policy_settings.qr_code).toBe("reject")
  })

  test("community owner can persist membership gates settings", async () => {
    const ctx = await createRouteTestContext()
    cleanup = ctx.cleanup

    const session = await exchangeJwt(ctx.env, "community-gates-user")
    await completeUniqueHumanVerification(ctx.env, session.accessToken)
    await completeAgeOver18Verification(ctx.env, session.accessToken)

    const communityCreate = await requestJson("http://pirate.test/communities", {
      display_name: "Gates Club",
membership_mode: "request",
      default_age_gate_policy: "18_plus",
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

    const gatesUpdate = await Promise.resolve(app.request(
      `http://pirate.test/communities/${communityCreateBody.community.id.replace(/^com_/, "")}/gates`,
      {
        method: "POST",
        headers: {
          "content-type": "application/json",
          authorization: `Bearer ${session.accessToken}`,
        },
        body: settingsJson({
          membership_mode: "gated",
          default_age_gate_policy: "18_plus",
          allow_anonymous_identity: true,
          anonymous_identity_scope: "thread_stable",
          gate_policy: genderGatePolicy("F"),
        }),
      },
      ctx.env,
    ))
    expect(gatesUpdate.status).toBe(200)
    const updatedCommunity = await json(gatesUpdate) as {
      membership_mode: string
      default_age_gate_policy?: string | null
      allow_anonymous_identity: boolean
      anonymous_identity_scope?: string | null
      gate_policy?: { expression?: { gate?: { type?: string; allowed?: string[] } } }
    }
    expect(updatedCommunity.membership_mode).toBe("gated")
    expect(updatedCommunity.default_age_gate_policy).toBe("18_plus")
    expect(updatedCommunity.allow_anonymous_identity).toBe(true)
    expect(updatedCommunity.anonymous_identity_scope).toBe("thread_stable")
    expect(updatedCommunity.gate_policy?.expression?.gate?.type).toBe("gender")
    expect(updatedCommunity.gate_policy?.expression?.gate?.allowed).toEqual(["F"])

    const fetchedCommunity = await app.request(
      `http://pirate.test/communities/${communityCreateBody.community.id.replace(/^com_/, "")}`,
      {
        headers: {
          authorization: `Bearer ${session.accessToken}`,
        },
      },
      ctx.env,
    )
    expect(fetchedCommunity.status).toBe(200)
    const fetchedBody = await json(fetchedCommunity) as {
      membership_mode: string
      gate_policy?: { expression?: { gate?: { type?: string } } }
    }
    expect(fetchedBody.membership_mode).toBe("gated")
    expect(fetchedBody.gate_policy?.expression?.gate?.type).toBe("gender")
  })

  test("community owner preserves gate_rule_id across gates updates", async () => {
    const ctx = await createRouteTestContext()
    cleanup = ctx.cleanup

    const session = await exchangeJwt(ctx.env, "community-gates-preserve-user")
    await completeUniqueHumanVerification(ctx.env, session.accessToken)
    await completeAgeOver18Verification(ctx.env, session.accessToken)

    const communityCreate = await requestJson("http://pirate.test/communities", {
      display_name: "Gates Preserve Club",
membership_mode: "request",
      default_age_gate_policy: "18_plus",
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

    const firstUpdate = await Promise.resolve(app.request(
      `http://pirate.test/communities/${communityCreateBody.community.id.replace(/^com_/, "")}/gates`,
      {
        method: "POST",
        headers: {
          "content-type": "application/json",
          authorization: `Bearer ${session.accessToken}`,
        },
        body: settingsJson({
          membership_mode: "gated",
          default_age_gate_policy: "18_plus",
          allow_anonymous_identity: false,
          anonymous_identity_scope: null,
          gate_policy: genderGatePolicy("F"),
        }),
      },
      ctx.env,
    ))
    expect(firstUpdate.status).toBe(200)
    const firstUpdateBody = await json(firstUpdate) as {
      gate_policy?: { expression?: { gate?: { type?: string } } }
    }
    expect(firstUpdateBody.gate_policy?.expression?.gate?.type).toBe("gender")

    const secondUpdate = await Promise.resolve(app.request(
      `http://pirate.test/communities/${communityCreateBody.community.id.replace(/^com_/, "")}/gates`,
      {
        method: "POST",
        headers: {
          "content-type": "application/json",
          authorization: `Bearer ${session.accessToken}`,
        },
        body: settingsJson({
          membership_mode: "gated",
          default_age_gate_policy: "18_plus",
          allow_anonymous_identity: false,
          anonymous_identity_scope: null,
          gate_policy: genderGatePolicy("M"),
        }),
      },
      ctx.env,
    ))
    expect(secondUpdate.status).toBe(200)
    const secondUpdateBody = await json(secondUpdate) as {
      gate_policy?: { expression?: { gate?: { allowed?: string[] } } }
    }
    expect(secondUpdateBody.gate_policy?.expression?.gate?.allowed).toEqual(["M"])
  })

  test("community gates update rejects duplicate or blank gate_rule_id payloads", async () => {
    const ctx = await createRouteTestContext()
    cleanup = ctx.cleanup

    const session = await exchangeJwt(ctx.env, "community-gates-invalid-id-user")
    await completeUniqueHumanVerification(ctx.env, session.accessToken)
    await completeAgeOver18Verification(ctx.env, session.accessToken)

    const communityCreate = await requestJson("http://pirate.test/communities", {
      display_name: "Gates Invalid Id Club",
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

    const emptyAllowedValues = await Promise.resolve(app.request(
      `http://pirate.test/communities/${communityCreateBody.community.id.replace(/^com_/, "")}/gates`,
      {
        method: "POST",
        headers: {
          "content-type": "application/json",
          authorization: `Bearer ${session.accessToken}`,
        },
        body: settingsJson({
          membership_mode: "gated",
          default_age_gate_policy: "none",
          allow_anonymous_identity: false,
          anonymous_identity_scope: null,
          gate_policy: genderGatePolicy(),
        }),
      },
      ctx.env,
    ))
    expect(emptyAllowedValues.status).toBe(403)

    const invalidGenderValue = await Promise.resolve(app.request(
      `http://pirate.test/communities/${communityCreateBody.community.id.replace(/^com_/, "")}/gates`,
      {
        method: "POST",
        headers: {
          "content-type": "application/json",
          authorization: `Bearer ${session.accessToken}`,
        },
        body: settingsJson({
          membership_mode: "gated",
          default_age_gate_policy: "none",
          allow_anonymous_identity: false,
          anonymous_identity_scope: null,
          gate_policy: genderGatePolicy("X"),
        }),
      },
      ctx.env,
    ))
    expect(invalidGenderValue.status).toBe(403)
  })

  test("community gates update rejects duplicate same-type identity gates", async () => {
    const ctx = await createRouteTestContext()
    cleanup = ctx.cleanup

    const session = await exchangeJwt(ctx.env, "community-gates-duplicate-type-user")
    await completeUniqueHumanVerification(ctx.env, session.accessToken)
    await completeAgeOver18Verification(ctx.env, session.accessToken)

    const communityCreate = await requestJson("http://pirate.test/communities", {
      display_name: "Gates Duplicate Type Club",
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

    const duplicateGenderGates = await Promise.resolve(app.request(
      `http://pirate.test/communities/${communityCreateBody.community.id.replace(/^com_/, "")}/gates`,
      {
        method: "POST",
        headers: {
          "content-type": "application/json",
          authorization: `Bearer ${session.accessToken}`,
        },
        body: settingsJson({
          membership_mode: "gated",
          default_age_gate_policy: "none",
          allow_anonymous_identity: false,
          anonymous_identity_scope: null,
          gate_policy: genderGatePolicy("F", "M"),
        }),
      },
      ctx.env,
    ))
    expect(duplicateGenderGates.status).toBe(200)
    const duplicateGenderBody = await json(duplicateGenderGates) as {
      gate_policy?: { expression?: { children?: Array<{ gate?: { type?: string } }> } } | null
    }
    expect(duplicateGenderBody.gate_policy?.expression?.children?.map((child) => child.gate?.type)).toEqual(["gender", "gender"])
  })

  test("community owner can persist agent moderation settings", async () => {
    const ctx = await createRouteTestContext()
    cleanup = ctx.cleanup

    const session = await exchangeJwt(ctx.env, "community-agent-policy-user")
    await completeUniqueHumanVerification(ctx.env, session.accessToken)

    const communityCreate = await requestJson("http://pirate.test/communities", {
      display_name: "Agents Club",
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

    const agentUpdate = await Promise.resolve(app.request(
      `http://pirate.test/communities/${communityCreateBody.community.id.replace(/^com_/, "")}`,
      {
        method: "POST",
        headers: {
          "content-type": "application/json",
          authorization: `Bearer ${session.accessToken}`,
        },
        body: settingsJson({
          agent_posting_policy: "allow",
          agent_posting_scope: "top_level_and_replies",
          agent_daily_post_cap: 5,
          agent_daily_reply_cap: 20,
          human_verification_lane: "very",
          accepted_agent_ownership_providers: ["clawkey"],
        }),
      },
      ctx.env,
    ))
    expect(agentUpdate.status).toBe(200)
    const updatedCommunity = await json(agentUpdate) as {
      agent_posting_policy: string
      agent_posting_scope: string
      agent_daily_post_cap: number | null
      agent_daily_reply_cap: number | null
      human_verification_lane: string
      human_verification_lane_origin: string
      accepted_agent_ownership_providers: string[]
      accepted_agent_ownership_providers_origin: string
    }
    expect(updatedCommunity.agent_posting_policy).toBe("allow")
    expect(updatedCommunity.agent_posting_scope).toBe("top_level_and_replies")
    expect(updatedCommunity.agent_daily_post_cap).toBe(5)
    expect(updatedCommunity.agent_daily_reply_cap).toBe(20)
    expect(updatedCommunity.human_verification_lane).toBe("very")
    expect(updatedCommunity.human_verification_lane_origin).toBe("explicit")
    expect(updatedCommunity.accepted_agent_ownership_providers).toEqual(["clawkey"])
    expect(updatedCommunity.accepted_agent_ownership_providers_origin).toBe("explicit")

    const fetchedCommunity = await app.request(
      `http://pirate.test/communities/${communityCreateBody.community.id.replace(/^com_/, "")}`,
      {
        headers: {
          authorization: `Bearer ${session.accessToken}`,
        },
      },
      ctx.env,
    )
    expect(fetchedCommunity.status).toBe(200)
    const fetchedBody = await json(fetchedCommunity) as {
      agent_posting_policy: string
      agent_posting_scope: string
      agent_daily_post_cap: number | null
      agent_daily_reply_cap: number | null
      human_verification_lane: string
      human_verification_lane_origin: string
      accepted_agent_ownership_providers: string[]
      accepted_agent_ownership_providers_origin: string
    }
    expect(fetchedBody.agent_posting_policy).toBe("allow")
    expect(fetchedBody.agent_posting_scope).toBe("top_level_and_replies")
    expect(fetchedBody.agent_daily_post_cap).toBe(5)
    expect(fetchedBody.agent_daily_reply_cap).toBe(20)
    expect(fetchedBody.human_verification_lane).toBe("very")
    expect(fetchedBody.human_verification_lane_origin).toBe("explicit")
    expect(fetchedBody.accepted_agent_ownership_providers).toEqual(["clawkey"])
    expect(fetchedBody.accepted_agent_ownership_providers_origin).toBe("explicit")
  })

  test("community owner can persist profile fields", async () => {
    const ctx = await createRouteTestContext()
    cleanup = ctx.cleanup

    const session = await exchangeJwt(ctx.env, "community-profile-user")
    await completeUniqueHumanVerification(ctx.env, session.accessToken)

    const communityCreate = await requestJson("http://pirate.test/communities", {
      display_name: "Old Name",
membership_mode: "request",
      description: "Old description",
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

    const profileUpdate = await Promise.resolve(app.request(
      `http://pirate.test/communities/${communityCreateBody.community.id.replace(/^com_/, "")}`,
      {
        method: "POST",
        headers: {
          "content-type": "application/json",
          authorization: `Bearer ${session.accessToken}`,
        },
        body: settingsJson({
          display_name: "New Name",
          description: "New description",
          avatar_ref: "media://community-avatar",
          banner_ref: "media://community-banner",
          store_url: "https://store.example.test/community",
          store_label: "Community Store",
          country_code: "ge",
        }),
      },
      ctx.env,
    ))
    expect(profileUpdate.status).toBe(200)
    const updatedCommunity = await json(profileUpdate) as {
      display_name: string
      description: string | null
      avatar_ref: string | null
      banner_ref: string | null
      store_url: string | null
      store_label: string | null
      country_code: string | null
    }
    expect(updatedCommunity.display_name).toBe("New Name")
    expect(updatedCommunity.description).toBe("New description")
    expect(updatedCommunity.avatar_ref).toBe("media://community-avatar")
    expect(updatedCommunity.banner_ref).toBe("media://community-banner")
    expect(updatedCommunity.store_url).toBe("https://store.example.test/community")
    expect(updatedCommunity.store_label).toBe("Community Store")
    expect(updatedCommunity.country_code).toBe("ge")

    const fetchedCommunity = await app.request(
      `http://pirate.test/communities/${communityCreateBody.community.id.replace(/^com_/, "")}`,
      {
        headers: {
          authorization: `Bearer ${session.accessToken}`,
        },
      },
      ctx.env,
    )
    expect(fetchedCommunity.status).toBe(200)
    const fetchedBody = await json(fetchedCommunity) as {
      display_name: string
      description: string | null
      avatar_ref: string | null
      banner_ref: string | null
      store_url: string | null
      store_label: string | null
      country_code: string | null
    }
    expect(fetchedBody.display_name).toBe("New Name")
    expect(fetchedBody.description).toBe("New description")
    expect(fetchedBody.avatar_ref).toBe("media://community-avatar")
    expect(fetchedBody.banner_ref).toBe("media://community-banner")
    expect(fetchedBody.store_url).toBe("https://store.example.test/community")
    expect(fetchedBody.store_label).toBe("Community Store")
    expect(fetchedBody.country_code).toBe("ge")

    const projection = await ctx.client.execute({
      sql: "SELECT description, avatar_ref, banner_ref FROM communities WHERE community_id = ?1",
      args: [communityCreateBody.community.id.replace(/^com_/, "")],
    })
    expect(projection.rows[0]?.description).toBe("New description")
    expect(projection.rows[0]?.avatar_ref).toBe("media://community-avatar")
    expect(projection.rows[0]?.banner_ref).toBe("media://community-banner")
  })

  test("community owner can update agent settings without clobbering existing profile fields", async () => {
    const ctx = await createRouteTestContext()
    cleanup = ctx.cleanup

    const session = await exchangeJwt(ctx.env, "community-agent-settings-preserve-profile-user")
    await completeUniqueHumanVerification(ctx.env, session.accessToken)

    const communityCreate = await requestJson("http://pirate.test/communities", {
      display_name: "Preserve Name",
membership_mode: "request",
      description: "Preserve description",
      avatar_ref: "media://preserve-avatar",
      banner_ref: "media://preserve-banner",
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

    const settingsUpdate = await Promise.resolve(app.request(
      `http://pirate.test/communities/${communityCreateBody.community.id.replace(/^com_/, "")}`,
      {
        method: "POST",
        headers: {
          "content-type": "application/json",
          authorization: `Bearer ${session.accessToken}`,
        },
        body: settingsJson({
          human_verification_lane: "very",
          agent_posting_policy: "allow",
          agent_posting_scope: "top_level_and_replies",
          accepted_agent_ownership_providers: ["clawkey"],
        }),
      },
      ctx.env,
    ))
    expect(settingsUpdate.status).toBe(200)
    const updatedCommunity = await json(settingsUpdate) as {
      display_name: string
      description: string | null
      avatar_ref: string | null
      banner_ref: string | null
      human_verification_lane: string
      agent_posting_policy: string
      agent_posting_scope: string
      accepted_agent_ownership_providers: string[]
    }
    expect(updatedCommunity.display_name).toBe("Preserve Name")
    expect(updatedCommunity.description).toBe("Preserve description")
    expect(updatedCommunity.avatar_ref).toBe("media://preserve-avatar")
    expect(updatedCommunity.banner_ref).toBe("media://preserve-banner")
    expect(updatedCommunity.human_verification_lane).toBe("very")
    expect(updatedCommunity.agent_posting_policy).toBe("allow")
    expect(updatedCommunity.agent_posting_scope).toBe("top_level_and_replies")
    expect(updatedCommunity.accepted_agent_ownership_providers).toEqual(["clawkey"])

    const fetchedCommunity = await app.request(
      `http://pirate.test/communities/${communityCreateBody.community.id.replace(/^com_/, "")}`,
      {
        headers: {
          authorization: `Bearer ${session.accessToken}`,
        },
      },
      ctx.env,
    )
    expect(fetchedCommunity.status).toBe(200)
    const fetchedBody = await json(fetchedCommunity) as {
      display_name: string
      description: string | null
      avatar_ref: string | null
      banner_ref: string | null
      human_verification_lane: string
      agent_posting_policy: string
      agent_posting_scope: string
      accepted_agent_ownership_providers: string[]
    }
    expect(fetchedBody.display_name).toBe("Preserve Name")
    expect(fetchedBody.description).toBe("Preserve description")
    expect(fetchedBody.avatar_ref).toBe("media://preserve-avatar")
    expect(fetchedBody.banner_ref).toBe("media://preserve-banner")
    expect(fetchedBody.human_verification_lane).toBe("very")
    expect(fetchedBody.agent_posting_policy).toBe("allow")
    expect(fetchedBody.agent_posting_scope).toBe("top_level_and_replies")
    expect(fetchedBody.accepted_agent_ownership_providers).toEqual(["clawkey"])
  })

  test("community create persists agent posting settings into settings_json", async () => {
    const ctx = await createRouteTestContext()
    cleanup = ctx.cleanup

    const session = await exchangeJwt(ctx.env, "community-create-agent-settings-user")
    await completeUniqueHumanVerification(ctx.env, session.accessToken)

    const namespaceVerificationId = await prepareVerifiedNamespace(ctx.env, session.accessToken)

    const communityCreate = await requestJson("http://pirate.test/communities", {
      display_name: "Agent Settings Create Club",
membership_mode: "request",
      namespace: {
        namespace_verification: namespaceVerificationId,
      },
      human_verification_lane: "very",
      agent_posting_policy: "allow",
      agent_posting_scope: "top_level_and_replies",
      agent_daily_post_cap: 10,
      agent_daily_reply_cap: 50,
      accepted_agent_ownership_providers: ["clawkey"],
    }, ctx.env, session.accessToken)
    expect(communityCreate.status).toBe(202)
    const communityCreateBody = await json(communityCreate) as {
      community: {
        id: string
        agent_posting_policy: string
        agent_posting_scope: string
        agent_daily_post_cap: number | null
        agent_daily_reply_cap: number | null
        human_verification_lane: string
        human_verification_lane_origin: string
        accepted_agent_ownership_providers: string[]
        accepted_agent_ownership_providers_origin: string
      }
    }

    expect(communityCreateBody.community.agent_posting_policy).toBe("allow")
    expect(communityCreateBody.community.agent_posting_scope).toBe("top_level_and_replies")
    expect(communityCreateBody.community.agent_daily_post_cap).toBe(10)
    expect(communityCreateBody.community.agent_daily_reply_cap).toBe(50)
    expect(communityCreateBody.community.human_verification_lane).toBe("very")
    expect(communityCreateBody.community.human_verification_lane_origin).toBe("explicit")
    expect(communityCreateBody.community.accepted_agent_ownership_providers).toEqual(["clawkey"])
    expect(communityCreateBody.community.accepted_agent_ownership_providers_origin).toBe("explicit")

    const fetchedCommunity = await app.request(
      `http://pirate.test/communities/${communityCreateBody.community.id.replace(/^com_/, "")}`,
      {
        headers: {
          authorization: `Bearer ${session.accessToken}`,
        },
      },
      ctx.env,
    )
    expect(fetchedCommunity.status).toBe(200)
    const fetchedBody = await json(fetchedCommunity) as {
      agent_posting_policy: string
      agent_posting_scope: string
      agent_daily_post_cap: number | null
      agent_daily_reply_cap: number | null
      human_verification_lane: string
      human_verification_lane_origin: string
      accepted_agent_ownership_providers: string[]
      accepted_agent_ownership_providers_origin: string
    }
    expect(fetchedBody.agent_posting_policy).toBe("allow")
    expect(fetchedBody.agent_posting_scope).toBe("top_level_and_replies")
    expect(fetchedBody.agent_daily_post_cap).toBe(10)
    expect(fetchedBody.agent_daily_reply_cap).toBe(50)
    expect(fetchedBody.human_verification_lane).toBe("very")
    expect(fetchedBody.human_verification_lane_origin).toBe("explicit")
    expect(fetchedBody.accepted_agent_ownership_providers).toEqual(["clawkey"])
    expect(fetchedBody.accepted_agent_ownership_providers_origin).toBe("explicit")
  })
})
