import { afterEach, beforeEach, describe, expect, test } from "bun:test"
import app from "../src/index"
import { createRouteTestContext, json, resetRuntimeCaches } from "./helpers"
import { setVeryProviderForTests } from "../src/lib/verification/very-provider"
import type { VeryProvider } from "../src/lib/verification/very-provider"
import {
  completeUniqueHumanVerification,
  exchangeJwt,
  prepareVerifiedNamespace,
  requestJson,
  setPassportWalletScore,
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

describe("community membership routes", () => {
  test("community join requires a platform trust credential even for open communities", async () => {
    const ctx = await createRouteTestContext()
    cleanup = ctx.cleanup

    const verifiedCreator = await exchangeJwt(ctx.env, "community-join-creator")
    const namespaceVerificationId = await prepareVerifiedNamespace(ctx.env, verifiedCreator.accessToken)

    const communityCreate = await requestJson("http://pirate.test/communities", {
      display_name: "Pirate Join Club",
      namespace: {
        namespace_verification_id: namespaceVerificationId,
      },
      membership_mode: "open",
    }, ctx.env, verifiedCreator.accessToken)
    expect(communityCreate.status).toBe(202)
    const communityCreateBody = await json(communityCreate) as {
      community: { community_id: string }
    }

    const unverifiedUser = await exchangeJwt(ctx.env, "community-unverified-joiner")
    const deniedJoin = await app.request(
      `http://pirate.test/communities/${communityCreateBody.community.community_id}/join`,
      {
        method: "POST",
        headers: {
          authorization: `Bearer ${unverifiedUser.accessToken}`,
        },
      },
      ctx.env,
    )

    expect(deniedJoin.status).toBe(403)
    const deniedBody = await json(deniedJoin) as { code: string; message: string }
    expect(deniedBody.code).toBe("gate_failed")
    expect(deniedBody.message).toBe("A platform trust credential is required to join this community")

    const verifiedJoiner = await exchangeJwt(ctx.env, "community-verified-joiner")
    await completeUniqueHumanVerification(ctx.env, verifiedJoiner.accessToken)

    const allowedJoin = await app.request(
      `http://pirate.test/communities/${communityCreateBody.community.community_id}/join`,
      {
        method: "POST",
        headers: {
          authorization: `Bearer ${verifiedJoiner.accessToken}`,
        },
      },
      ctx.env,
    )

    expect(allowedJoin.status).toBe(200)
    const allowedBody = await json(allowedJoin) as { community_id: string; status: string }
    expect(allowedBody.community_id).toBe(communityCreateBody.community.community_id)
    expect(allowedBody.status).toBe("joined")
  })

  test("community join accepts a passport wallet score that passes the platform threshold", async () => {
    const ctx = await createRouteTestContext()
    cleanup = ctx.cleanup

    const verifiedCreator = await exchangeJwt(ctx.env, "community-wallet-score-creator")
    const namespaceVerificationId = await prepareVerifiedNamespace(ctx.env, verifiedCreator.accessToken)

    const communityCreate = await requestJson("http://pirate.test/communities", {
      display_name: "Pirate Wallet Score Club",
      namespace: {
        namespace_verification_id: namespaceVerificationId,
      },
      membership_mode: "open",
    }, ctx.env, verifiedCreator.accessToken)
    expect(communityCreate.status).toBe(202)
    const communityCreateBody = await json(communityCreate) as {
      community: { community_id: string }
    }

    const walletScoreJoiner = await exchangeJwt(ctx.env, "community-wallet-score-joiner")
    await setPassportWalletScore(ctx.env, walletScoreJoiner.userId, {
      score: 123.4,
      scoreThreshold: 20,
      passingScore: true,
    })

    const allowedJoin = await app.request(
      `http://pirate.test/communities/${communityCreateBody.community.community_id}/join`,
      {
        method: "POST",
        headers: {
          authorization: `Bearer ${walletScoreJoiner.accessToken}`,
        },
      },
      ctx.env,
    )

    expect(allowedJoin.status).toBe(200)
    const allowedBody = await json(allowedJoin) as { community_id: string; status: string }
    expect(allowedBody.community_id).toBe(communityCreateBody.community.community_id)
    expect(allowedBody.status).toBe("joined")
  })

  test("gated community join enforces membership proof requirements", async () => {
    const ctx = await createRouteTestContext({
      VERY_API_URL: "https://very.test",
      VERY_APP_ID: "very-test-app",
    })
    cleanup = ctx.cleanup

    const verifiedCreator = await exchangeJwt(ctx.env, "community-gated-creator")
    const namespaceVerificationId = await prepareVerifiedNamespace(ctx.env, verifiedCreator.accessToken)

    const communityCreate = await requestJson("http://pirate.test/communities", {
      display_name: "Pirate Gated Club",
      namespace: {
        namespace_verification_id: namespaceVerificationId,
      },
      membership_mode: "gated",
      gate_rules: [
        {
          scope: "membership",
          gate_family: "identity_proof",
          gate_type: "unique_human",
          proof_requirements: [
            {
              proof_type: "unique_human",
              accepted_providers: ["self"],
            },
          ],
        },
      ],
    }, ctx.env, verifiedCreator.accessToken)
    expect(communityCreate.status).toBe(202)
    const communityCreateBody = await json(communityCreate) as {
      community: { community_id: string }
    }

    const veryJoiner = await exchangeJwt(ctx.env, "community-gated-very-joiner")
    setVeryProviderForTests({
      startSession: async () => ({
        upstreamSessionRef: "very-test-ref",
        launch: {
          app_id: "test",
          context: "verification",
          type_id: "palm_scan",
          query: {},
          verify_url: "https://verify.very.org/test",
        },
      }),
      getSessionOutcome: async () => ({
        status: "verified",
        attestationData: {},
      }),
    } satisfies VeryProvider)
    await completeUniqueHumanVerification(ctx.env, veryJoiner.accessToken, "very")
    setVeryProviderForTests(null)

    const deniedJoin = await app.request(
      `http://pirate.test/communities/${communityCreateBody.community.community_id}/join`,
      {
        method: "POST",
        headers: {
          authorization: `Bearer ${veryJoiner.accessToken}`,
        },
      },
      ctx.env,
    )

    expect(deniedJoin.status).toBe(403)
    const deniedBody = await json(deniedJoin) as { code: string; message: string }
    expect(deniedBody.code).toBe("gate_failed")
    expect(deniedBody.message).toBe("Community membership requirements are not satisfied")

    const selfJoiner = await exchangeJwt(ctx.env, "community-gated-self-joiner")
    await completeUniqueHumanVerification(ctx.env, selfJoiner.accessToken, "self")

    const allowedJoin = await app.request(
      `http://pirate.test/communities/${communityCreateBody.community.community_id}/join`,
      {
        method: "POST",
        headers: {
          authorization: `Bearer ${selfJoiner.accessToken}`,
        },
      },
      ctx.env,
    )

    expect(allowedJoin.status).toBe(200)
    const allowedBody = await json(allowedJoin) as { community_id: string; status: string }
    expect(allowedBody.community_id).toBe(communityCreateBody.community.community_id)
    expect(allowedBody.status).toBe("joined")
  })

  test("community create rejects invalid accepted_providers combinations for supported public v0 gates", async () => {
    const ctx = await createRouteTestContext()
    cleanup = ctx.cleanup

    const session = await exchangeJwt(ctx.env, "community-invalid-provider-creator")
    const namespaceVerificationId = await prepareVerifiedNamespace(ctx.env, session.accessToken)

    const invalidGenderProvider = await requestJson("http://pirate.test/communities", {
      display_name: "Invalid Gender Provider Club",
      namespace: {
        namespace_verification_id: namespaceVerificationId,
      },
      membership_mode: "gated",
      gate_rules: [
        {
          scope: "membership",
          gate_family: "identity_proof",
          gate_type: "gender",
          proof_requirements: [
            {
              proof_type: "gender",
              accepted_providers: ["passport"],
              config: {
                required_value: "M",
              },
            },
          ],
        },
      ],
    }, ctx.env, session.accessToken)
    expect(invalidGenderProvider.status).toBe(403)
    const invalidGenderProviderBody = await json(invalidGenderProvider) as { code: string; message: string }
    expect(invalidGenderProviderBody.code).toBe("eligibility_failed")
    expect(invalidGenderProviderBody.message).toMatch(/Invalid accepted_providers for gender/)

    const invalidWalletScoreProvider = await requestJson("http://pirate.test/communities", {
      display_name: "Invalid Wallet Provider Club",
      namespace: {
        namespace_verification_id: namespaceVerificationId,
      },
      membership_mode: "gated",
      gate_rules: [
        {
          scope: "membership",
          gate_family: "identity_proof",
          gate_type: "wallet_score",
          proof_requirements: [
            {
              proof_type: "wallet_score",
              accepted_providers: ["self"],
            },
          ],
        },
      ],
    }, ctx.env, session.accessToken)
    expect(invalidWalletScoreProvider.status).toBe(403)
    const invalidWalletScoreProviderBody = await json(invalidWalletScoreProvider) as { code: string; message: string }
    expect(invalidWalletScoreProviderBody.code).toBe("eligibility_failed")
    expect(invalidWalletScoreProviderBody.message).toMatch(/Invalid accepted_providers for wallet_score/)
  })

  test("community create accepts gender gates in public v0", async () => {
    const ctx = await createRouteTestContext()
    cleanup = ctx.cleanup

    const session = await exchangeJwt(ctx.env, "community-gender-gate-creator")
    const namespaceVerificationId = await prepareVerifiedNamespace(ctx.env, session.accessToken)

    const response = await requestJson("http://pirate.test/communities", {
      display_name: "Gender Gated Club",
      namespace: {
        namespace_verification_id: namespaceVerificationId,
      },
      membership_mode: "gated",
      gate_rules: [
        {
          scope: "membership",
          gate_family: "identity_proof",
          gate_type: "gender",
          proof_requirements: [
            {
              proof_type: "gender",
              accepted_providers: ["self"],
              config: {
                required_value: "M",
              },
            },
          ],
        },
      ],
    }, ctx.env, session.accessToken)

    expect(response.status).toBe(202)
    const body = await json(response) as {
      community: { community_id: string }
      job: { status: string }
    }
    expect(typeof body.community.community_id).toBe("string")
    expect(["queued", "succeeded"]).toContain(body.job.status)
  })
})
