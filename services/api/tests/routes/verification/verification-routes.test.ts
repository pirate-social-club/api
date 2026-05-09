import { afterEach, beforeEach, describe, expect, test } from "bun:test"
import { solveChallenge, type Payload } from "altcha-lib"
import { deriveKey } from "altcha-lib/algorithms/pbkdf2"
import { app } from "../../../src/index"
import { json, createRouteTestContext, resetRuntimeCaches } from "../../helpers"
import { mintUpstreamJwt } from "../../helpers"
import { setSelfProviderForTests } from "../../../src/lib/verification/self-provider"
import { setVeryProviderForTests } from "../../../src/lib/verification/very-provider"
import { setPassportProviderForTests } from "../../../src/lib/verification/passport-provider"
import {
  createAltchaChallenge,
  verifyAndConsumeAltchaProof,
} from "../../../src/lib/verification/altcha-provider"
import { prepareVerifiedNamespace } from "../communities/community-routes-test-helpers"
import {
  exchangeJwt,
  requestJson,
  withFetchMock,
} from "./verification-test-helpers"

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

describe("verification routes", () => {
  test("ALTCHA challenge endpoint binds scope and action, purges expired state, and rate limits", async () => {
    const ctx = await createRouteTestContext({
      ALTCHA_HMAC_SECRET: "test-altcha-secret",
      ALTCHA_HMAC_KEY_SECRET: "test-altcha-key-secret",
      ALTCHA_CHALLENGE_RATE_LIMIT: "2",
      ALTCHA_CHALLENGE_RATE_LIMIT_WINDOW_SECONDS: "60",
    })
    cleanup = ctx.cleanup

    const session = await exchangeJwt(ctx.env, "verification-altcha-user")
    const actorUserId = session.userId
    const oldTimestamp = "2026-01-01T00:00:00.000Z"
    await ctx.client.execute({
      sql: `
        INSERT INTO altcha_used_challenges (
          challenge_hash, actor_user_id, scope, action_ref, used_at, expires_at
        ) VALUES (?1, ?2, ?3, ?4, ?5, ?6)
      `,
      args: ["expired-altcha-challenge", actorUserId, "community_join", "community:cmt_expired", oldTimestamp, oldTimestamp],
    })
    await ctx.client.execute({
      sql: `
        INSERT INTO altcha_challenge_rate_limits (
          actor_user_id, window_start, request_count, updated_at
        ) VALUES (?1, ?2, ?3, ?4)
      `,
      args: [actorUserId, oldTimestamp, 1, oldTimestamp],
    })

    const requestChallenge = () => app.request(
      "http://pirate.test/verification/altcha/challenge?scope=community_join&action=community:cmt_altcha",
      { headers: { authorization: `Bearer ${session.accessToken}` } },
      ctx.env,
    )

    const first = await requestChallenge()
    expect(first.status).toBe(200)
    const firstBody = await json(first) as {
      parameters?: { algorithm?: string; data?: { actor?: string; scope?: string; action?: string } }
      signature?: string
    }
    expect(firstBody.parameters?.algorithm).toBe("PBKDF2/SHA-256")
    expect(typeof firstBody.signature).toBe("string")
    expect(firstBody.parameters?.data).toEqual({
      actor: actorUserId,
      scope: "community_join",
      action: "community:cmt_altcha",
    })

    const expiredChallengeRows = await ctx.client.execute({
      sql: "SELECT COUNT(*) AS count FROM altcha_used_challenges WHERE challenge_hash = ?1",
      args: ["expired-altcha-challenge"],
    })
    expect(Number(expiredChallengeRows.rows[0]?.count ?? 0)).toBe(0)
    const staleLimitRows = await ctx.client.execute({
      sql: "SELECT COUNT(*) AS count FROM altcha_challenge_rate_limits WHERE window_start = ?1",
      args: [oldTimestamp],
    })
    expect(Number(staleLimitRows.rows[0]?.count ?? 0)).toBe(0)

    const second = await requestChallenge()
    expect(second.status).toBe(200)

    const third = await requestChallenge()
    expect(third.status).toBe(429)
    const thirdBody = await json(third) as { code: string; details?: { limit?: number; window_seconds?: number } }
    expect(thirdBody.code).toBe("rate_limited")
    expect(thirdBody.details?.limit).toBe(2)
    expect(thirdBody.details?.window_seconds).toBe(60)
  })

  test("ALTCHA proofs verify once and reject replay or binding mismatch", async () => {
    const ctx = await createRouteTestContext({
      ALTCHA_HMAC_SECRET: "test-altcha-secret",
      ALTCHA_HMAC_KEY_SECRET: "test-altcha-key-secret",
      ALTCHA_POW_COST: "1",
      ALTCHA_POW_COUNTER_MIN: "1",
      ALTCHA_POW_COUNTER_MAX: "2",
    })
    cleanup = ctx.cleanup

    const session = await exchangeJwt(ctx.env, "verification-altcha-proof-user")
    const challenge = await createAltchaChallenge({
      env: ctx.env,
      actorUserId: session.userId,
      scope: "community_join",
      action: "community:cmt_altcha",
    })
    const solution = await solveChallenge({ challenge, deriveKey })
    if (!solution) {
      throw new Error("ALTCHA challenge did not solve")
    }
    const payload = btoa(JSON.stringify({ challenge, solution } satisfies Payload))

    const verified = await verifyAndConsumeAltchaProof({
      env: ctx.env,
      actorUserId: session.userId,
      proof: {
        payload,
        scope: "community_join",
        action: "community:cmt_altcha",
      },
    })
    expect(verified).toEqual({ verified: true })

    const replayed = await verifyAndConsumeAltchaProof({
      env: ctx.env,
      actorUserId: session.userId,
      proof: {
        payload,
        scope: "community_join",
        action: "community:cmt_altcha",
      },
    })
    expect(replayed).toEqual({ verified: false, reason: "replayed" })

    const mismatchChallenge = await createAltchaChallenge({
      env: ctx.env,
      actorUserId: session.userId,
      scope: "post_create",
      action: "community:cmt_altcha",
    })
    const mismatchSolution = await solveChallenge({ challenge: mismatchChallenge, deriveKey })
    if (!mismatchSolution) {
      throw new Error("ALTCHA mismatch challenge did not solve")
    }
    const mismatchPayload = btoa(JSON.stringify({
      challenge: mismatchChallenge,
      solution: mismatchSolution,
    } satisfies Payload))
    const mismatch = await verifyAndConsumeAltchaProof({
      env: ctx.env,
      actorUserId: session.userId,
      proof: {
        payload: mismatchPayload,
        scope: "community_join",
        action: "community:cmt_altcha",
      },
    })
    expect(mismatch).toEqual({ verified: false, reason: "binding_mismatch" })
  })

  test("verification session start accepts self gender capability requests", async () => {
    const ctx = await createRouteTestContext()
    cleanup = ctx.cleanup

    const session = await exchangeJwt(ctx.env, "verification-gender-user")

    const createdVerification = await requestJson("http://pirate.test/verification-sessions", {
      provider: "self",
      requested_capabilities: ["gender"],
    }, ctx.env, session.accessToken)
    expect(createdVerification.status).toBe(201)
    const body = await json(createdVerification) as {
      status: string
      requested_capabilities: string[]
      launch?: { self_app?: { disclosures?: { gender?: boolean } } }
    }
    expect(body.status).toBe("pending")
    expect(body.requested_capabilities).toEqual(["unique_human", "gender"])
    expect(body.launch?.self_app?.disclosures?.gender).toBe(true)
  })

  test("self launch callback uses the live dev tunnel origin instead of a stale configured origin", async () => {
    const ctx = await createRouteTestContext({
      ENVIRONMENT: "staging",
      PIRATE_API_PUBLIC_ORIGIN: "https://stale-maritime-complete-lesser.trycloudflare.com",
    })
    cleanup = ctx.cleanup

    const session = await exchangeJwt(ctx.env, "verification-self-fresh-tunnel-user")

    const createdVerification = await requestJson("https://fresh-maritime-complete-lesser.trycloudflare.com/verification-sessions", {
      provider: "self",
      requested_capabilities: ["nationality"],
      verification_intent: "community_join",
    }, ctx.env, session.accessToken)
    expect(createdVerification.status).toBe(201)
    const body = await json(createdVerification) as {
      launch?: { self_app?: { endpoint?: string } }
    }
    expect(body.launch?.self_app?.endpoint).toMatch(
      /^https:\/\/fresh-maritime-complete-lesser\.trycloudflare\.com\/verification-sessions\/ver_[^/]+\/receive-self-proof$/u,
    )
  })

  test("verification completion fails when self does not return the requested gender claim", async () => {
    const ctx = await createRouteTestContext()
    cleanup = ctx.cleanup

    const session = await exchangeJwt(ctx.env, "verification-gender-missing-claim-user")
    setSelfProviderForTests({
      startSession: async () => ({
        upstreamSessionRef: "self-test-ref",
        launch: {
          app_name: "Pirate",
          endpoint: "https://self.xyz",
          endpoint_type: "https",
          scope: "community_join",
          session_id: "self-test-ref",
          user_id: "test",
          user_id_type: "uuid",
          disclosures: { gender: true },
        },
      }),
      getSessionOutcome: async () => ({
        status: "verified",
        claims: { age_over_18: true, nationality: null, gender: null, nullifier: "self-test-ref" },
      }),
    } satisfies import("../../../src/lib/verification/self-provider").SelfProvider)

    const createdVerification = await requestJson("http://pirate.test/verification-sessions", {
      provider: "self",
      requested_capabilities: ["gender"],
      verification_intent: "community_join",
    }, ctx.env, session.accessToken)
    expect(createdVerification.status).toBe(201)
    const createdBody = await json(createdVerification) as { id: string }

    const completedVerification = await requestJson(
      `http://pirate.test/verification-sessions/${createdBody.id}/complete`,
      {},
      ctx.env,
      session.accessToken,
    )
    setSelfProviderForTests(null)

    expect(completedVerification.status).toBe(200)
    const completedBody = await json(completedVerification) as {
      status: string
      failure_reason: string | null
    }
    expect(completedBody.status).toBe("failed")
    expect(completedBody.failure_reason).toBe("missing_required_claims:gender")
  })

  test("self verification callback completes an SDK session payload", async () => {
    const ctx = await createRouteTestContext()
    cleanup = ctx.cleanup

    const session = await exchangeJwt(ctx.env, "verification-receive-self-proof-user")
    setSelfProviderForTests({
      startSession: async () => ({
        upstreamSessionRef: "receive-self-proof-test-ref",
        launch: {
          app_name: "Pirate",
          endpoint: "https://api.pirate.test/verification-sessions/ver_self_callback/receive-self-proof",
          endpoint_type: "staging_https",
          scope: "community_join",
          session_id: "receive-self-proof-test-ref",
          user_id: "00000000-0000-4000-8000-000000000001",
          user_id_type: "uuid",
          disclosures: { nationality: true },
          version: 2,
        },
      }),
      getSessionOutcome: async (input) => {
        expect(input.attestationId).toBe("1")
        const payload = JSON.parse(String(input.providerPayloadRef)) as { userContextData?: string }
        expect(payload.userContextData).toBe("0xself")
        return {
          status: "verified",
          claims: {
            age_over_18: true,
            minimum_age: null,
            nationality: "USA",
            gender: null,
            nullifier: "receive-self-proof-test-ref",
          },
        }
      },
    } satisfies import("../../../src/lib/verification/self-provider").SelfProvider)

    const createdVerification = await requestJson("http://pirate.test/verification-sessions", {
      provider: "self",
      requested_capabilities: ["nationality"],
      verification_intent: "community_join",
    }, ctx.env, session.accessToken)
    expect(createdVerification.status).toBe(201)
    const createdBody = await json(createdVerification) as { id: string }

    const callback = await app.request(
      `http://pirate.test/verification-sessions/${createdBody.id}/receive-self-proof`,
      {
        method: "POST",
        headers: { "content-type": "application/json" },
        body: JSON.stringify({
          provider: "self",
          event_type: "proof_submitted",
          payload: {
            attestationId: "1",
            proof: {},
            publicSignals: [],
            userContextData: "0xself",
          },
        }),
      },
      ctx.env,
    )
    setSelfProviderForTests(null)

    expect(callback.status).toBe(200)
    const callbackBody = await json(callback) as {
      result: boolean
      status: string
      id: string
    }
    expect(callbackBody.result).toBe(true)
    expect(callbackBody.status).toBe("verified")
    expect(callbackBody.id).toBe(createdBody.id)
  })

  test("verification and namespace endpoints work through the full route stack", async () => {
    const ctx = await createRouteTestContext({
      HNS_VERIFIER_BASE_URL: "http://hns-verifier.test",
      HNS_VERIFIER_AUTH_TOKEN: "test-hns-token",
    })
    cleanup = ctx.cleanup

    const session = await exchangeJwt(ctx.env, "verification-user")

    const createdVerification = await requestJson("http://pirate.test/verification-sessions", {
      provider: "self",
    }, ctx.env, session.accessToken)
    expect(createdVerification.status).toBe(201)
    const verificationBody = await json(createdVerification) as {
      id: string
      status: string
    }
    expect(verificationBody.status).toBe("pending")

    const fetchedVerification = await app.request(
      `http://pirate.test/verification-sessions/${verificationBody.id}`,
      {
        headers: {
          authorization: `Bearer ${session.accessToken}`,
        },
      },
      ctx.env,
    )
    expect(fetchedVerification.status).toBe(200)

    const completedVerification = await requestJson(
      `http://pirate.test/verification-sessions/${verificationBody.id}/complete`,
      {
        proof_hash: "proof-hash-1",
      },
      ctx.env,
      session.accessToken,
    )
    expect(completedVerification.status).toBe(200)
    const completedVerificationBody = await json(completedVerification) as {
      status: string
      attestation_id: string | null
    }
    expect(completedVerificationBody.status).toBe("verified")
    expect(completedVerificationBody.attestation_id).toBe(undefined)

    const originalFetch = globalThis.fetch
    await withFetchMock(async (input, init) => {
      const url = typeof input === "string" ? input : input.toString()
      if (url.startsWith("http://hns-verifier.test")) {
        if (url.includes("/inspect-public?")) {
          return Response.json({
            root_exists: true,
            expiry_horizon_sufficient: true,
            routing_enabled: true,
            pirate_dns_authority_verified: true,
            nameservers: ["ns1.pirate.sc."],
            operation_class: "pirate_delegated_namespace",
            observation_provider: "web3dns_json_doh",
            failure_reason: null,
          })
        }
        if (url.endsWith("/verify-txt-public")) {
          return Response.json({
            verified: true,
            observation_provider: "web3dns_json_doh",
            failure_reason: null,
          })
        }
        if (url.endsWith("/ensure-zone")) {
          return Response.json({
            root_label: "piratetestroot",
            zone_name: "piratetestroot.",
            zone_created: true,
            nameservers: ["ns1.pirate."],
            observation_provider: "powerdns_sqlite",
          })
        }
      }
      return originalFetch(input, init)
    }, async () => {
      const createdNamespaceSession = await requestJson("http://pirate.test/namespace-verification-sessions", {
        family: "hns",
        root_label: "PirateTestRoot",
      }, ctx.env, session.accessToken)
      expect(createdNamespaceSession.status).toBe(201)
      const namespaceSessionBody = await json(createdNamespaceSession) as {
        id: string
        status: string
        challenge_host: string | null
        challenge_txt_value: string | null
      }
      expect(namespaceSessionBody.status).toBe("challenge_required")
      expect(typeof namespaceSessionBody.challenge_host).toBe("string")
      expect(typeof namespaceSessionBody.challenge_txt_value).toBe("string")

      const completedNamespaceSession = await requestJson(
        `http://pirate.test/namespace-verification-sessions/${namespaceSessionBody.id}/complete`,
        {},
        ctx.env,
        session.accessToken,
      )
      expect(completedNamespaceSession.status).toBe(200)
      const completedNamespaceBody = await json(completedNamespaceSession) as {
        status: string
        namespace_verification: string | null
      }
      expect(completedNamespaceBody.status).toBe("verified")
      expect(typeof completedNamespaceBody.namespace_verification).toBe("string")

      const fetchedNamespaceVerification = await app.request(
        `http://pirate.test/namespace-verifications/${completedNamespaceBody.namespace_verification}`,
        {
          headers: {
            authorization: `Bearer ${session.accessToken}`,
          },
        },
        ctx.env,
      )
      expect(fetchedNamespaceVerification.status).toBe(200)
      const fetchedNamespaceBody = await json(fetchedNamespaceVerification) as {
        status: string
        capabilities: { club_attach_allowed: boolean | null }
      }
      expect(fetchedNamespaceBody.status).toBe("verified")
      expect(fetchedNamespaceBody.capabilities.club_attach_allowed).toBe(true)
    })
  })

  test("passport wallet score refresh updates only wallet_score capability", async () => {
    const ctx = await createRouteTestContext({
      PASSPORT_API_KEY: "passport-key",
      PASSPORT_SCORER_ID: "123",
    })
    cleanup = ctx.cleanup

    const walletAddress = "0x1111111111111111111111111111111111111111"
    const jwt = await mintUpstreamJwt(ctx.env, {
      sub: "verification-passport-refresh-user",
      wallet_addresses: [walletAddress],
      selected_wallet_address: walletAddress,
    })
    const sessionResponse = await requestJson("http://pirate.test/auth/session/exchange", {
      proof: {
        type: "jwt_based_auth",
        jwt,
      },
    }, ctx.env)
    const session = await json(sessionResponse) as {
      access_token: string
      user: { id: string }
      wallet_attachments: Array<{ wallet_attachment: string }>
    }
    const otherWalletAddress = "0x3333333333333333333333333333333333333333"
    const otherJwt = await mintUpstreamJwt(ctx.env, {
      sub: "verification-passport-refresh-other-user",
      wallet_addresses: [otherWalletAddress],
      selected_wallet_address: otherWalletAddress,
    })
    const otherSessionResponse = await requestJson("http://pirate.test/auth/session/exchange", {
      proof: {
        type: "jwt_based_auth",
        jwt: otherJwt,
      },
    }, ctx.env)
    const otherSession = await json(otherSessionResponse) as {
      wallet_attachments: Array<{ wallet_attachment: string }>
    }

    setPassportProviderForTests({
      refreshWalletScore: async ({ address, now }) => {
        expect(address).toBe(walletAddress)
        return {
          state: "verified",
          provider: "passport",
          proof_type: "wallet_score",
          mechanism: "stamps-api-v2",
          verified_at: now ? Math.floor(now.getTime() / 1000) : null,
          score_decimal: "33.5",
          score_threshold_decimal: "20",
          passing_score: true,
          last_scored_at: now ? Math.floor(now.getTime() / 1000) : null,
          expires_at: Math.floor(((now ?? new Date()).getTime() + 86_400_000) / 1000),
          stamps: [{ stamp_name: "Ens", stamp_score_decimal: "1.2" }],
        }
      },
    })

    const refreshed = await requestJson("http://pirate.test/verification/passport-wallet-score", {}, ctx.env, session.access_token)
    expect(refreshed.status).toBe(200)
    const body = await json(refreshed) as {
      wallet_score: { state: string; score_decimal: string; passing_score: boolean }
      wallet_score_status: { current_score_decimal: string; required_score_decimal: string; passing_score: boolean }
    }
    expect(body.wallet_score.state).toBe("verified")
    expect(body.wallet_score.score_decimal).toBe("33.5")
    expect(body.wallet_score_status).toMatchObject({
      current_score_decimal: "33.5",
      required_score_decimal: "20",
      passing_score: true,
    })

    const row = await ctx.client.execute({
      sql: `
        SELECT verification_state, capability_provider, verified_at, current_verification_session_id, verification_capabilities_json
        FROM users
        WHERE user_id = ?1
        LIMIT 1
      `,
      args: [session.user.id.replace(/^usr_/, "")],
    })
    expect(row.rows[0]?.verification_state).toBe("unverified")
    expect(row.rows[0]?.capability_provider).toBeNull()
    expect(row.rows[0]?.verified_at).toBeNull()
    expect(row.rows[0]?.current_verification_session_id).toBeNull()
    const capabilities = JSON.parse(String(row.rows[0]?.verification_capabilities_json)) as {
      wallet_score?: { score_decimal?: string; passing_score?: boolean }
    }
    expect(capabilities.wallet_score?.score_decimal).toBe("33.5")
    expect(capabilities.wallet_score?.passing_score).toBe(true)

    const rejectedWallet = await requestJson("http://pirate.test/verification/passport-wallet-score", {
      wallet_attachment: otherSession.wallet_attachments[0]?.wallet_attachment,
    }, ctx.env, session.access_token)
    expect(rejectedWallet.status).toBe(400)
    const rejectedWalletBody = await json(rejectedWallet) as { message: string }
    expect(rejectedWalletBody.message).toBe("Wallet attachment does not belong to the authenticated user")

    const limited = await requestJson("http://pirate.test/verification/passport-wallet-score", {}, ctx.env, session.access_token)
    expect(limited.status).toBe(429)
  })

  test("passport wallet score refresh can return updated join eligibility", async () => {
    const ctx = await createRouteTestContext({
      PASSPORT_API_KEY: "passport-key",
      PASSPORT_SCORER_ID: "123",
    })
    cleanup = ctx.cleanup

    const creator = await exchangeJwt(ctx.env, "verification-passport-community-creator")
    const namespaceVerificationId = await prepareVerifiedNamespace(ctx.env, creator.accessToken)
    const communityCreate = await requestJson("http://pirate.test/communities", {
      display_name: "Passport Score Club",
      namespace: {
        namespace_verification: namespaceVerificationId,
      },
      membership_mode: "gated",
      gate_policy: {
        version: 1,
        expression: {
          op: "gate",
          gate: {
            type: "wallet_score",
            provider: "passport",
            minimum_score: 20,
          },
        },
      },
    }, ctx.env, creator.accessToken)
    expect(communityCreate.status).toBe(202)
    const communityBody = await json(communityCreate) as { community: { id: string } }

    const walletAddress = "0x2222222222222222222222222222222222222222"
    const jwt = await mintUpstreamJwt(ctx.env, {
      sub: "verification-passport-community-joiner",
      wallet_addresses: [walletAddress],
      selected_wallet_address: walletAddress,
    })
    const sessionResponse = await requestJson("http://pirate.test/auth/session/exchange", {
      proof: {
        type: "jwt_based_auth",
        jwt,
      },
    }, ctx.env)
    const session = await json(sessionResponse) as { access_token: string }
    setPassportProviderForTests({
      refreshWalletScore: async ({ now }) => ({
        state: "verified",
        provider: "passport",
        proof_type: "wallet_score",
        mechanism: "stamps-api-v2",
        verified_at: now ? Math.floor(now.getTime() / 1000) : null,
        score_decimal: "25",
        score_threshold_decimal: "20",
        passing_score: true,
        last_scored_at: now ? Math.floor(now.getTime() / 1000) : null,
        expires_at: Math.floor(((now ?? new Date()).getTime() + 86_400_000) / 1000),
        stamps: null,
      }),
    })

    const refreshed = await requestJson("http://pirate.test/verification/passport-wallet-score", {
      community: communityBody.community.id,
    }, ctx.env, session.access_token)
    expect(refreshed.status).toBe(200)
    const body = await json(refreshed) as {
      join_eligibility?: { status: string; wallet_score_status?: { current_score_decimal?: string | null; required_score_decimal?: string | null } }
      wallet_score_status?: { current_score_decimal?: string | null; required_score_decimal?: string | null }
    }
    expect(body.join_eligibility?.status).toBe("joinable")
    expect(body.wallet_score_status).toMatchObject({
      current_score_decimal: "25",
      required_score_decimal: "20",
    })
  })

  test("passport wallet score refresh returns failing eligibility when score is below gate threshold", async () => {
    const ctx = await createRouteTestContext({
      PASSPORT_API_KEY: "passport-key",
      PASSPORT_SCORER_ID: "123",
    })
    cleanup = ctx.cleanup

    const creator = await exchangeJwt(ctx.env, "verification-passport-low-score-creator")
    const namespaceVerificationId = await prepareVerifiedNamespace(ctx.env, creator.accessToken)
    const communityCreate = await requestJson("http://pirate.test/communities", {
      display_name: "Passport High Score Club",
      namespace: {
        namespace_verification: namespaceVerificationId,
      },
      membership_mode: "gated",
      gate_policy: {
        version: 1,
        expression: {
          op: "gate",
          gate: {
            type: "wallet_score",
            provider: "passport",
            minimum_score: 20,
          },
        },
      },
    }, ctx.env, creator.accessToken)
    expect(communityCreate.status).toBe(202)
    const communityBody = await json(communityCreate) as { community: { id: string } }

    const walletAddress = "0x4444444444444444444444444444444444444444"
    const jwt = await mintUpstreamJwt(ctx.env, {
      sub: "verification-passport-low-score-joiner",
      wallet_addresses: [walletAddress],
      selected_wallet_address: walletAddress,
    })
    const sessionResponse = await requestJson("http://pirate.test/auth/session/exchange", {
      proof: {
        type: "jwt_based_auth",
        jwt,
      },
    }, ctx.env)
    const session = await json(sessionResponse) as { access_token: string }
    setPassportProviderForTests({
      refreshWalletScore: async ({ now }) => ({
        state: "verified",
        provider: "passport",
        proof_type: "wallet_score",
        mechanism: "stamps-api-v2",
        verified_at: now ? Math.floor(now.getTime() / 1000) : null,
        score_decimal: "10",
        score_threshold_decimal: "20",
        passing_score: false,
        last_scored_at: now ? Math.floor(now.getTime() / 1000) : null,
        expires_at: Math.floor(((now ?? new Date()).getTime() + 86_400_000) / 1000),
        stamps: null,
      }),
    })

    const refreshed = await requestJson("http://pirate.test/verification/passport-wallet-score", {
      community: communityBody.community.id,
    }, ctx.env, session.access_token)
    expect(refreshed.status).toBe(200)
    const body = await json(refreshed) as {
      join_eligibility?: { status: string; failure_reason?: string | null }
      wallet_score_status?: { current_score_decimal?: string | null; required_score_decimal?: string | null; passing_score?: boolean | null }
    }
    expect(body.join_eligibility?.status).toBe("verification_required")
    expect(body.wallet_score_status).toMatchObject({
      current_score_decimal: "10",
      required_score_decimal: "20",
      passing_score: false,
    })
  })

  test("very bridge session proxy forwards authenticated widget session creation", async () => {
    const ctx = await createRouteTestContext({
      VERY_APP_ID: "very-app",
      VERY_BRIDGE_API_URL: "https://bridge.very.test/api/v1/",
    })
    cleanup = ctx.cleanup

    const session = await exchangeJwt(ctx.env, "verification-very-bridge-session-user")
    const createdVerification = await requestJson("http://pirate.test/verification-sessions", {
      provider: "very",
      verification_intent: "community_creation",
    }, ctx.env, session.accessToken)
    expect(createdVerification.status).toBe(201)
    const createdBody = await json(createdVerification) as { id: string }
    await withFetchMock(async (input, init) => {
      expect(String(input)).toBe("https://bridge.very.test/api/v1/sessions")
      expect(init?.method).toBe("POST")
      expect(init?.body).toBe("{\"iv\":\"iv-1\",\"payload\":\"payload-1\"}")
      return Response.json({
        iv: "iv-1",
        key: "key-1",
        sessionAuthToken: "token-1",
        sessionId: "very-session-1",
      })
    }, async () => {
      const response = await app.request(
        `http://pirate.test/verification-sessions/${createdBody.id}/very-bridge/sessions`,
        {
          method: "POST",
          headers: {
            authorization: `Bearer ${session.accessToken}`,
            "content-type": "application/json",
          },
          body: "{\"iv\":\"iv-1\",\"payload\":\"payload-1\"}",
        },
        ctx.env,
      )

      expect(response.status).toBe(200)
      const body = await json(response) as { sessionId?: string }
      expect(body.sessionId).toBe("very-session-1")
    })
  })

  test("very completion does not trust stored bridge completion when verifier cannot validate binding", async () => {
    const ctx = await createRouteTestContext({
      VERY_API_URL: "https://very.test",
      VERY_APP_ID: "very-app",
      VERY_BRIDGE_API_URL: "https://bridge.very.test/api/v1/",
      VERY_TRUST_BRIDGE_COMPLETION_ON_VERIFIER_5XX: "true",
    })
    cleanup = ctx.cleanup

    const session = await exchangeJwt(ctx.env, "verification-very-bridge-fallback-user")
    const createdVerification = await requestJson("http://pirate.test/verification-sessions", {
      provider: "very",
      verification_intent: "community_creation",
    }, ctx.env, session.accessToken)
    expect(createdVerification.status).toBe(201)
    const createdBody = await json(createdVerification) as { id: string }

    await withFetchMock(async (input, init) => {
      const url = String(input)
      if (url === "https://bridge.very.test/api/v1/sessions") {
        expect(init?.method).toBe("POST")
        return Response.json({
          sessionId: "0e16c1fe-78f7-4116-83bf-a2072aca6c7c",
          sessionAuthToken: "token-1",
        })
      }
      if (url === "https://very.test/api/v1/verify") {
        expect(init?.method).toBe("POST")
        const body = JSON.parse(String(init?.body))
        expect(body).toEqual({ proof: "very-zk-proof-500" })
        return new Response(JSON.stringify({
          code: "INTERNAL_ERROR",
          message: "Internal server error",
        }), {
          status: 500,
          headers: { "content-type": "application/json" },
        })
      }
      if (url === "https://bridge.very.test/api/v1/session/0e16c1fe-78f7-4116-83bf-a2072aca6c7c") {
        expect(init?.method).toBe("GET")
        return Response.json({
          status: "completed",
          response: {
            iv: "iv-1",
            payload: "payload-1",
          },
        })
      }
      throw new Error(`Unexpected fetch ${url}`)
    }, async () => {
      const bridgeSession = await app.request(
        `http://pirate.test/verification-sessions/${createdBody.id}/very-bridge/sessions`,
        {
          method: "POST",
          headers: {
            authorization: `Bearer ${session.accessToken}`,
            "content-type": "application/json",
          },
          body: "{\"iv\":\"iv-1\",\"payload\":\"payload-1\"}",
        },
        ctx.env,
      )
      expect(bridgeSession.status).toBe(200)

      const completedVerification = await requestJson(
        `http://pirate.test/verification-sessions/${createdBody.id}/complete`,
        {
          provider_payload_ref: "very-zk-proof-500",
        },
        ctx.env,
        session.accessToken,
      )
      expect(completedVerification.status).toBe(502)
      const completedBody = await json(completedVerification) as {
        code: string
        message: string
      }
      expect(completedBody.code).toBe("provider_unavailable")
      expect(completedBody.message).toContain("status 500")
    })
  })

  test("very bridge status proxy returns widget-readable errors when upstream fails", async () => {
    const ctx = await createRouteTestContext({
      VERY_APP_ID: "very-app",
      VERY_BRIDGE_API_URL: "https://bridge.very.test/api/v1/",
    })
    cleanup = ctx.cleanup

    const session = await exchangeJwt(ctx.env, "verification-very-bridge-status-user")
    const createdVerification = await requestJson("http://pirate.test/verification-sessions", {
      provider: "very",
      verification_intent: "community_creation",
    }, ctx.env, session.accessToken)
    expect(createdVerification.status).toBe(201)
    const createdBody = await json(createdVerification) as { id: string }
    await withFetchMock(async (input, init) => {
      expect(String(input)).toBe("https://bridge.very.test/api/v1/session/very-session-1")
      expect(init?.method).toBe("GET")
      return new Response("Service Unavailable", { status: 503 })
    }, async () => {
      const response = await app.request(
        `http://pirate.test/verification-sessions/${createdBody.id}/very-bridge/session/very-session-1`,
        {
          headers: {
            authorization: `Bearer ${session.accessToken}`,
          },
        },
        ctx.env,
      )

      expect(response.status).toBe(502)
      const body = await json(response) as { status?: string; userMessage?: string }
      expect(body.status).toBe("error")
      expect(body.userMessage).toBe("Very bridge response was invalid")
    })
  })

  test("very bridge status proxy surfaces upstream poll timeouts", async () => {
    const ctx = await createRouteTestContext({
      VERY_APP_ID: "very-app",
      VERY_BRIDGE_API_URL: "https://bridge.very.test/api/v1/",
    })
    cleanup = ctx.cleanup

    const session = await exchangeJwt(ctx.env, "verification-very-bridge-timeout-user")
    const createdVerification = await requestJson("http://pirate.test/verification-sessions", {
      provider: "very",
      verification_intent: "community_creation",
    }, ctx.env, session.accessToken)
    expect(createdVerification.status).toBe(201)
    const createdBody = await json(createdVerification) as { id: string }
    let statusPolls = 0
    await withFetchMock(async (input, init) => {
      expect(String(input)).toBe("https://bridge.very.test/api/v1/session/very-session-timeout")
      expect(init?.method).toBe("GET")
      statusPolls += 1
      if (statusPolls === 1) {
        return Response.json({ status: "received" })
      }
      return Response.json({
        status: "error",
        userMessage: "Very bridge request timed out",
      }, { status: 504 })
    }, async () => {
      const firstResponse = await app.request(
        `http://pirate.test/verification-sessions/${createdBody.id}/very-bridge/session/very-session-timeout`,
        {
          headers: {
            authorization: `Bearer ${session.accessToken}`,
          },
        },
        ctx.env,
      )
      expect(firstResponse.status).toBe(200)
      const firstBody = await json(firstResponse) as { status?: string }
      expect(firstBody.status).toBe("received")

      const timeoutResponse = await app.request(
        `http://pirate.test/verification-sessions/${createdBody.id}/very-bridge/session/very-session-timeout`,
        {
          headers: {
            authorization: `Bearer ${session.accessToken}`,
          },
        },
        ctx.env,
      )
      expect(timeoutResponse.status).toBe(504)
      const timeoutBody = await json(timeoutResponse) as { status?: string }
      expect(timeoutBody.status).toBe("error")
    })
  })

  test("very completion does not trust bridge completion when verifier returns 5xx and fallback flag is disabled", async () => {
    const ctx = await createRouteTestContext({
      VERY_API_URL: "https://very.test",
      VERY_APP_ID: "very-app",
      VERY_BRIDGE_API_URL: "https://bridge.very.test/api/v1/",
    })
    cleanup = ctx.cleanup

    const session = await exchangeJwt(ctx.env, "verification-very-bridge-no-fallback-user")
    const createdVerification = await requestJson("http://pirate.test/verification-sessions", {
      provider: "very",
      verification_intent: "community_creation",
    }, ctx.env, session.accessToken)
    expect(createdVerification.status).toBe(201)
    const createdBody = await json(createdVerification) as { id: string }

    await withFetchMock(async (input, init) => {
      const url = String(input)
      if (url === "https://bridge.very.test/api/v1/sessions") {
        expect(init?.method).toBe("POST")
        return Response.json({
          sessionId: "0e16c1fe-78f7-4116-83bf-a2072aca6c7c",
          sessionAuthToken: "token-1",
        })
      }
      if (url === "https://very.test/api/v1/verify") {
        expect(init?.method).toBe("POST")
        return new Response(JSON.stringify({
          code: "INTERNAL_ERROR",
          message: "Internal server error",
        }), {
          status: 500,
          headers: { "content-type": "application/json" },
        })
      }
      throw new Error(`Unexpected fetch ${url}`)
    }, async () => {
      const bridgeSession = await app.request(
        `http://pirate.test/verification-sessions/${createdBody.id}/very-bridge/sessions`,
        {
          method: "POST",
          headers: {
            authorization: `Bearer ${session.accessToken}`,
            "content-type": "application/json",
          },
          body: "{\"iv\":\"iv-1\",\"payload\":\"payload-1\"}",
        },
        ctx.env,
      )
      expect(bridgeSession.status).toBe(200)

      const completedVerification = await requestJson(
        `http://pirate.test/verification-sessions/${createdBody.id}/complete`,
        {
          provider_payload_ref: "very-zk-proof-500",
        },
        ctx.env,
        session.accessToken,
      )
      expect(completedVerification.status).toBe(502)
      const completedBody = await json(completedVerification) as {
        code: string
        message: string
      }
      expect(completedBody.code).toBe("provider_unavailable")
      expect(completedBody.message).toContain("status 500")
    })
  })

  test("very verification completes only after the provider confirms the submitted proof", async () => {
    const ctx = await createRouteTestContext({
      VERY_API_URL: "https://very.test",
      VERY_APP_ID: "very-app",
    })
    cleanup = ctx.cleanup

    const session = await exchangeJwt(ctx.env, "verification-very-user")

    let verifierCalls = 0
    let expectedPseudonym = "0"
    await withFetchMock(async (input, init) => {
      verifierCalls += 1
      const url = typeof input === "string" ? input : input.toString()
      expect(url).toBe("https://very.test/api/v1/verify")
      expect(init?.method).toBe("POST")
      const body = JSON.parse(String(init?.body))
      expect(body).toEqual({ proof: "very-zk-proof-123" })
      return new Response(JSON.stringify({
        status: "valid",
        data: {
          palm_scan: true,
          externalNullifier: "pirate-unique-human-v0",
          pseudonym: expectedPseudonym,
          nullifier: "very-nullifier-route-1",
        },
      }), {
        status: 200,
        headers: { "content-type": "application/json" },
      })
    }, async () => {
      const createdVerification = await requestJson("http://pirate.test/verification-sessions", {
        provider: "very",
        verification_intent: "community_creation",
      }, ctx.env, session.accessToken)
      expect(createdVerification.status).toBe(201)
      const createdBody = await json(createdVerification) as {
        id: string
        status: string
        provider_mode: string | null
        launch?: { very_widget?: { verify_url?: string; session_binding?: { binding_value?: string } } }
      }
      expectedPseudonym = createdBody.launch?.very_widget?.session_binding?.binding_value ?? "0"
      expect(createdBody.status).toBe("pending")
      expect(createdBody.provider_mode).toBe("widget")
      expect(createdBody.launch?.very_widget?.verify_url).toBe("http://pirate.test/verification-sessions/very-widget-verify")
      expect(createdBody.launch?.very_widget?.session_binding).toBe(undefined)

      const widgetVerification = await requestJson(
        createdBody.launch?.very_widget?.verify_url ?? "",
        {
          proof: "very-zk-proof-123",
        },
        ctx.env,
      )
      expect(widgetVerification.status).toBe(200)
      const widgetVerificationBody = await json(widgetVerification) as { status: string }
      expect(widgetVerificationBody.status).toBe("valid")
      expect(verifierCalls).toBe(0)

      const completedVerification = await requestJson(
        `http://pirate.test/verification-sessions/${createdBody.id}/complete`,
        {
          proof: "very-zk-proof-123",
        },
        ctx.env,
        session.accessToken,
      )
      expect(completedVerification.status).toBe(200)
      const completedBody = await json(completedVerification) as {
        status: string
        proof_hash: string | null
        attestation_id: string | null
      }
      expect(completedBody.status).toBe("verified")
      expect(typeof completedBody.proof_hash).toBe("string")
      expect(completedBody.attestation_id).toBe(undefined)
      expect(verifierCalls).toBe(1)
    })
  })

  test("very verification rejects a reused active nullifier for another user", async () => {
    const ctx = await createRouteTestContext({
      VERY_APP_ID: "very-app",
    })
    cleanup = ctx.cleanup

    setVeryProviderForTests({
      startSession: async (input) => ({
        upstreamSessionRef: `very-test-ref:${input.verificationSessionId}`,
        launch: {
          app_id: "very-app",
          context: "verification",
          type_id: "palm_scan",
          query: {},
          verify_url: "https://verify.very.org/test",
          session_binding: {
            uniqueness_domain: "pirate-unique-human-v0",
            binding_value: "0",
            binding_field: "pseudonym",
            challenge_expires_at: Math.floor(Date.parse(input.challengeExpiresAt) / 1000),
          },
        },
      }),
      getSessionOutcome: async (input) => ({
        status: "verified",
        attestationData: {
          externalNullifier: input.expectedBinding?.uniqueness_domain ?? "pirate-unique-human-v0",
          pseudonym: input.expectedBinding?.binding_value ?? "0",
          nullifier: "very-reused-nullifier",
        },
      }),
    } satisfies import("../../../src/lib/verification/very-provider").VeryProvider)

    const first = await exchangeJwt(ctx.env, "very-nullifier-first-user")
    const firstSession = await requestJson("http://pirate.test/verification-sessions", {
      provider: "very",
    }, ctx.env, first.accessToken)
    expect(firstSession.status).toBe(201)
    const firstBody = await json(firstSession) as { id: string }
    const firstComplete = await requestJson(
      `http://pirate.test/verification-sessions/${firstBody.id}/complete`,
      { proof: "first-proof" },
      ctx.env,
      first.accessToken,
    )
    expect(firstComplete.status).toBe(200)

    const second = await exchangeJwt(ctx.env, "very-nullifier-second-user")
    const secondSession = await requestJson("http://pirate.test/verification-sessions", {
      provider: "very",
    }, ctx.env, second.accessToken)
    expect(secondSession.status).toBe(201)
    const secondBody = await json(secondSession) as { id: string }
    const secondComplete = await requestJson(
      `http://pirate.test/verification-sessions/${secondBody.id}/complete`,
      { proof: "second-proof" },
      ctx.env,
      second.accessToken,
    )

    setVeryProviderForTests(null)

    expect(secondComplete.status).toBe(403)
    const secondCompleteBody = await json(secondComplete) as { message: string }
    expect(secondCompleteBody.message).toBe("Identity proof is already linked to another user")
  })

  test("very verification preserves verifier diagnostics when completion fails", async () => {
    const ctx = await createRouteTestContext({
      VERY_API_URL: "https://very.test",
      VERY_APP_ID: "very-app",
    })
    cleanup = ctx.cleanup

    const session = await exchangeJwt(ctx.env, "verification-very-failure-user")

    await withFetchMock(async (input, init) => {
      const url = typeof input === "string" ? input : input.toString()
      expect(url).toBe("https://very.test/api/v1/verify")
      expect(init?.method).toBe("POST")
      const body = JSON.parse(String(init?.body))
      expect(body).toEqual({ proof: "very-zk-proof-500" })
      return new Response(JSON.stringify({
        code: "INTERNAL_ERROR",
        message: "Internal server error",
      }), {
        status: 500,
        headers: { "content-type": "application/json" },
      })
    }, async () => {
      const createdVerification = await requestJson("http://pirate.test/verification-sessions", {
        provider: "very",
        verification_intent: "community_creation",
      }, ctx.env, session.accessToken)
      expect(createdVerification.status).toBe(201)
      const createdBody = await json(createdVerification) as { id: string }

      const completedVerification = await requestJson(
        `http://pirate.test/verification-sessions/${createdBody.id}/complete`,
        {
          proof: "very-zk-proof-500",
        },
        ctx.env,
        session.accessToken,
      )
      expect(completedVerification.status).toBe(502)
      const completedBody = await json(completedVerification) as {
        code: string
        message: string
        retryable?: boolean
        details?: { _diag?: Record<string, unknown> }
      }
      expect(completedBody.code).toBe("provider_unavailable")
      expect(completedBody.message).toBe("Very verification request failed with status 500")
      expect(completedBody.retryable).toBe(true)
      expect(completedBody.details?._diag?.responseStatus).toBe(500)
      expect(completedBody.details?._diag?.code).toBe("INTERNAL_ERROR")
      expect(completedBody.details?._diag?.message).toBe("Internal server error")
      expect(completedBody.details?._diag?.bodyKeys).toEqual(["code", "message"])
    })
  })
})
