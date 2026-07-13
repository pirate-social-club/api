import { createClient } from "@libsql/client"
import { app } from "../../../src/index"
import { buildLocalCommunityDbUrl } from "../../../src/lib/communities/community-local-db"
import { buildDefaultVerificationCapabilities } from "../../../src/lib/verification/verification-capabilities"
import type { Env } from "../../../src/types"
import { json, mintUpstreamJwt } from "../../helpers"

export function requestJson(url: string, body: unknown, env: Env, token?: string): Promise<Response> {
  return Promise.resolve(app.request(
    url,
    {
      method: "POST",
      headers: {
        "content-type": "application/json",
        ...(token ? { authorization: `Bearer ${token}` } : {}),
      },
      body: JSON.stringify(body),
    },
    env,
  ))
}

export async function exchangeJwt(env: Env, sub: string): Promise<{ accessToken: string; userId: string }> {
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

export async function prepareVerifiedNamespace(env: Env, accessToken: string): Promise<string> {
  const verificationSession = await requestJson("http://pirate.test/verification-sessions", {
    provider: "self",
  }, env, accessToken)
  const verificationBody = await json(verificationSession) as { id: string }
  await requestJson(
    `http://pirate.test/verification-sessions/${verificationBody.id}/complete`,
    {},
    env,
    accessToken,
  )

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
        }), {
          status: 200,
          headers: { "content-type": "application/json" },
        })
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
        }), {
          status: 200,
          headers: { "content-type": "application/json" },
        })
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
        }), {
          status: 200,
          headers: { "content-type": "application/json" },
        })
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
        }), {
          status: 200,
          headers: { "content-type": "application/json" },
        })
      }
    }

    return originalFetch(input, init)
  }) as typeof fetch

  try {
    const namespaceSession = await requestJson("http://pirate.test/namespace-verification-sessions", {
      family: "hns",
      root_label: "PirateCommunityRoot",
    }, env, accessToken)
    const namespaceBody = await json(namespaceSession) as { id: string }
    const completed = await requestJson(
      `http://pirate.test/namespace-verification-sessions/${namespaceBody.id}/complete`,
      {},
      env,
      accessToken,
    )
    const completedBody = await json(completed) as { namespace_verification: string | null }
    if (!completedBody.namespace_verification) {
      throw new Error("namespace verification did not complete")
    }
    return completedBody.namespace_verification
  } finally {
    globalThis.fetch = originalFetch
    env.HNS_VERIFIER_BASE_URL = originalHnsVerifierBaseUrl
    env.HNS_VERIFIER_AUTH_TOKEN = originalHnsVerifierAuthToken
  }
}

export async function prepareVerifiedSpacesNamespace(env: Env, accessToken: string, rootLabel = "@pesto"): Promise<string> {
  const verificationSession = await requestJson("http://pirate.test/verification-sessions", {
    provider: "self",
  }, env, accessToken)
  const verificationBody = await json(verificationSession) as { id: string }
  await requestJson(
    `http://pirate.test/verification-sessions/${verificationBody.id}/complete`,
    {},
    env,
    accessToken,
  )

  const originalFetch = globalThis.fetch
  const originalSpacesVerifierBaseUrl = env.SPACES_VERIFIER_BASE_URL
  env.SPACES_VERIFIER_BASE_URL = "http://spaces-verifier.test"
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
      root_label: rootLabel,
    }, env, accessToken)
    const namespaceBody = await json(namespaceSession) as { id: string }
    const completed = await requestJson(
      `http://pirate.test/namespace-verification-sessions/${namespaceBody.id}/complete`,
      {},
      env,
      accessToken,
    )
    const completedBody = await json(completed) as { namespace_verification: string | null }
    if (!completedBody.namespace_verification) {
      throw new Error("spaces namespace verification did not complete")
    }
    return completedBody.namespace_verification
  } finally {
    globalThis.fetch = originalFetch
    env.SPACES_VERIFIER_BASE_URL = originalSpacesVerifierBaseUrl
  }
}

export async function completeUniqueHumanVerification(
  env: Env,
  accessToken: string,
  provider: "self" | "very" = "self",
): Promise<void> {
  const verificationSession = await requestJson("http://pirate.test/verification-sessions", {
    provider,
  }, env, accessToken)
  const verificationBody = await json(verificationSession) as { id: string }
  await requestJson(
    `http://pirate.test/verification-sessions/${verificationBody.id}/complete`,
    {},
    env,
    accessToken,
  )
}

export async function setUniqueHumanVerificationProvider(
  env: Env,
  userId: string,
  provider: "self" | "very",
): Promise<void> {
  const client = createClient({
    url: String(env.CONTROL_PLANE_DATABASE_URL),
  })

  try {
    const userResult = await client.execute({
      sql: `SELECT verification_capabilities_json FROM users WHERE user_id = ?1 LIMIT 1`,
      args: [userId],
    })
    const currentCapabilities = typeof userResult.rows[0]?.verification_capabilities_json === "string"
      ? JSON.parse(String(userResult.rows[0]?.verification_capabilities_json)) as ReturnType<typeof buildDefaultVerificationCapabilities>
      : buildDefaultVerificationCapabilities()
    const capabilities = {
      ...buildDefaultVerificationCapabilities(),
      ...currentCapabilities,
    }
    capabilities.unique_human = {
      state: "verified",
      provider,
      mechanism: "route-test",
      proof_type: "unique_human",
      verified_at: Math.floor(Date.now() / 1000),
    }

    await client.execute({
      sql: `
        UPDATE users
        SET verification_state = 'verified',
            capability_provider = ?2,
            verification_capabilities_json = ?3,
            verified_at = ?4,
            updated_at = ?5
        WHERE user_id = ?1
      `,
      args: [
        userId,
        provider,
        JSON.stringify(capabilities),
        Math.floor(Date.now() / 1000),
        new Date().toISOString(),
      ],
    })
  } finally {
    client.close()
  }
}

export async function completeNationalityVerification(
  env: Env,
  accessToken: string,
): Promise<void> {
  const verificationSession = await requestJson("http://pirate.test/verification-sessions", {
    provider: "self",
    requested_capabilities: ["nationality"],
  }, env, accessToken)
  const verificationBody = await json(verificationSession) as { id: string }
  await requestJson(
    `http://pirate.test/verification-sessions/${verificationBody.id}/complete`,
    {},
    env,
    accessToken,
  )
}

export async function completeGenderVerification(
  env: Env,
  accessToken: string,
): Promise<void> {
  const verificationSession = await requestJson("http://pirate.test/verification-sessions", {
    provider: "self",
    requested_capabilities: ["gender"],
  }, env, accessToken)
  const verificationBody = await json(verificationSession) as { id: string }
  await requestJson(
    `http://pirate.test/verification-sessions/${verificationBody.id}/complete`,
    {},
    env,
    accessToken,
  )
}

export async function completeAgeOver18Verification(
  env: Env,
  accessToken: string,
): Promise<void> {
  const verificationSession = await requestJson("http://pirate.test/verification-sessions", {
    provider: "self",
    requested_capabilities: ["age_over_18"],
  }, env, accessToken)
  const verificationBody = await json(verificationSession) as { id: string }
  await requestJson(
    `http://pirate.test/verification-sessions/${verificationBody.id}/complete`,
    {},
    env,
    accessToken,
  )
}

export async function addCommunityMember(communityDbRoot: string, communityId: string, userId: string): Promise<void> {
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
        ON CONFLICT(membership_id) DO UPDATE SET
          status = excluded.status,
          joined_at = excluded.joined_at,
          left_at = excluded.left_at,
          banned_at = excluded.banned_at,
          updated_at = excluded.updated_at
      `,
      args: [`mbr_${communityId}_${userId}`, communityId, userId, now],
    })
  } finally {
    client.close()
  }
}

export async function updateLocalCommunityAnonymousPolicy(input: {
  allowAnonymousIdentity: boolean
  anonymousIdentityScope: "community_stable" | "thread_stable" | "post_ephemeral" | null
  communityDbRoot: string
  communityId: string
}): Promise<void> {
  const client = createClient({
    url: buildLocalCommunityDbUrl(input.communityDbRoot, input.communityId),
  })

  try {
    await client.execute({
      sql: `
        UPDATE communities
        SET allow_anonymous_identity = ?2,
            anonymous_identity_scope = ?3,
            updated_at = ?4
        WHERE community_id = ?1
      `,
      args: [
        input.communityId,
        input.allowAnonymousIdentity ? 1 : 0,
        input.allowAnonymousIdentity ? input.anonymousIdentityScope : null,
        new Date().toISOString(),
      ],
    })
  } finally {
    client.close()
  }
}

export async function updateLocalCommunityAgentPostingPolicy(input: {
  communityDbRoot: string
  communityId: string
  agentPostingPolicy: "disallow" | "review" | "allow_with_disclosure" | "allow"
  agentPostingScope: "replies_only" | "top_level_and_replies"
  acceptedAgentOwnershipProviders?: Array<"self_agent_id" | "clawkey"> | null
  humanVerificationLane?: "self" | "very" | null
  agentDailyPostCap?: number | null
  agentDailyReplyCap?: number | null
}): Promise<void> {
  const client = createClient({
    url: buildLocalCommunityDbUrl(input.communityDbRoot, input.communityId),
  })

  try {
    const existing = await client.execute({
      sql: `
        SELECT settings_json
        FROM communities
        WHERE community_id = ?1
        LIMIT 1
      `,
      args: [input.communityId],
    })

    const currentSettings = typeof existing.rows[0]?.settings_json === "string"
      ? JSON.parse(String(existing.rows[0]?.settings_json)) as Record<string, unknown>
      : {}

    const nextSettings = {
      ...currentSettings,
      agent_posting_policy: input.agentPostingPolicy,
      agent_posting_scope: input.agentPostingScope,
      ...(input.humanVerificationLane === undefined
        ? {}
        : { human_verification_lane: input.humanVerificationLane }),
      ...(input.agentDailyPostCap === undefined
        ? {}
        : { agent_daily_post_cap: input.agentDailyPostCap }),
      ...(input.agentDailyReplyCap === undefined
        ? {}
        : { agent_daily_reply_cap: input.agentDailyReplyCap }),
      ...(input.acceptedAgentOwnershipProviders === undefined
        ? {}
        : { accepted_agent_ownership_providers: input.acceptedAgentOwnershipProviders }),
    }

    await client.execute({
      sql: `
        UPDATE communities
        SET settings_json = ?2,
            updated_at = ?3
        WHERE community_id = ?1
      `,
      args: [
        input.communityId,
        JSON.stringify(nextSettings),
        new Date().toISOString(),
      ],
    })
  } finally {
    client.close()
  }
}

export async function setPassportWalletScore(
  env: Env,
  userId: string,
  input: {
    score: number
    scoreThreshold: number
    passingScore: boolean
  },
): Promise<void> {
  const client = createClient({
    url: String(env.CONTROL_PLANE_DATABASE_URL),
  })

  try {
    const userResult = await client.execute({
      sql: `SELECT verification_capabilities_json FROM users WHERE user_id = ?1 LIMIT 1`,
      args: [userId],
    })
    const currentCapabilities = typeof userResult.rows[0]?.verification_capabilities_json === "string"
      ? JSON.parse(String(userResult.rows[0]?.verification_capabilities_json)) as ReturnType<typeof buildDefaultVerificationCapabilities>
      : buildDefaultVerificationCapabilities()
    const capabilities = {
      ...buildDefaultVerificationCapabilities(),
      ...currentCapabilities,
    }
    capabilities.wallet_score = {
      state: "verified",
      provider: "passport",
      proof_type: "wallet_score",
      mechanism: "stamps-api-v2",
      verified_at: Math.floor(Date.now() / 1000),
      score_decimal: String(input.score),
      score_threshold_decimal: String(input.scoreThreshold),
      passing_score: input.passingScore,
      last_scored_at: Math.floor(Date.now() / 1000),
      expires_at: null,
      stamps: null,
    }

    await client.execute({
      sql: `
        UPDATE users
        SET verification_capabilities_json = ?2,
            updated_at = ?3
        WHERE user_id = ?1
      `,
      args: [userId, JSON.stringify(capabilities), new Date().toISOString()],
    })
  } finally {
    client.close()
  }
}

export async function getCommunityControlPlaneState(
  env: Env,
  communityId: string,
): Promise<{
  namespaceVerificationId: string | null
  routeSlug: string | null
  status: string | null
}> {
  const client = createClient({
    url: String(env.CONTROL_PLANE_DATABASE_URL),
  })

  try {
    const communityResult = await client.execute({
      sql: `
        SELECT namespace_verification_id, route_slug, status
        FROM communities
        WHERE community_id = ?1
        LIMIT 1
      `,
      args: [communityId],
    })

    return {
      namespaceVerificationId: communityResult.rows[0]?.namespace_verification_id == null
        ? null
        : String(communityResult.rows[0]?.namespace_verification_id),
      routeSlug: communityResult.rows[0]?.route_slug == null ? null : String(communityResult.rows[0]?.route_slug),
      status: communityResult.rows[0]?.status == null ? null : String(communityResult.rows[0]?.status),
    }
  } finally {
    client.close()
  }
}
