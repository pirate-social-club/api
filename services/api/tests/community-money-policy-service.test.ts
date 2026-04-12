import { afterEach, beforeEach, describe, expect, test } from "bun:test"
import app from "../src/index"
import {
  assertCommunityFundingQuoteEligible,
} from "../src/lib/communities/community-money-policy-service"
import { getControlPlaneCommunityRepository } from "../src/lib/communities/control-plane-community-repository"
import { createRouteTestContext, json, mintUpstreamJwt, resetRuntimeCaches } from "./helpers"
import type { Env } from "../src/types"

let cleanup: (() => Promise<void>) | null = null

function requestJson(
  url: string,
  body: unknown,
  env: Env,
  token?: string,
  method = "POST",
): Promise<Response> {
  return Promise.resolve(app.request(
    url,
    {
      method,
      headers: {
        "content-type": "application/json",
        ...(token ? { authorization: `Bearer ${token}` } : {}),
      },
      body: JSON.stringify(body),
    },
    env,
  ))
}

async function exchangeJwt(env: Env, sub: string): Promise<{ accessToken: string; userId: string }> {
  const jwt = await mintUpstreamJwt(env, { sub })
  const response = await requestJson("http://pirate.test/auth/session/exchange", {
    proof: {
      type: "jwt_based_auth",
      jwt,
    },
  }, env)
  const body = await json(response) as { access_token: string; user: { user_id: string } }
  return { accessToken: body.access_token, userId: body.user.user_id }
}

async function prepareVerifiedNamespace(env: Env, accessToken: string): Promise<string> {
  const verificationSession = await requestJson("http://pirate.test/verification-sessions", {
    provider: "self",
  }, env, accessToken)
  const verificationBody = await json(verificationSession) as { verification_session_id: string }
  await requestJson(
    `http://pirate.test/verification-sessions/${verificationBody.verification_session_id}/complete`,
    {},
    env,
    accessToken,
  )

  const namespaceSession = await requestJson("http://pirate.test/namespace-verification-sessions", {
    family: "hns",
    root_label: "MoneyPolicyQuoteRoot",
  }, env, accessToken)
  const namespaceBody = await json(namespaceSession) as { namespace_verification_session_id: string }
  const completed = await requestJson(
    `http://pirate.test/namespace-verification-sessions/${namespaceBody.namespace_verification_session_id}/complete`,
    {},
    env,
    accessToken,
  )
  const completedBody = await json(completed) as { namespace_verification_id: string }
  return completedBody.namespace_verification_id
}

async function createCommunityForMoneyPolicyTest(env: Env, accessToken: string): Promise<string> {
  const namespaceVerificationId = await prepareVerifiedNamespace(env, accessToken)
  const response = await requestJson("http://pirate.test/communities", {
    display_name: "Money Policy Quote Club",
    namespace: {
      namespace_verification_id: namespaceVerificationId,
    },
  }, env, accessToken)
  const body = await json(response) as { community: { community_id: string } }
  return body.community.community_id
}

describe("community money policy quote preflight", () => {
  beforeEach(() => {
    resetRuntimeCaches()
  })

  afterEach(async () => {
    resetRuntimeCaches()
    if (cleanup) {
      await cleanup()
      cleanup = null
    }
  })

  test("default policy allows direct settlement without a routed funding lane", async () => {
    const ctx = await createRouteTestContext()
    cleanup = ctx.cleanup

    const owner = await exchangeJwt(ctx.env, "money-policy-direct-owner")
    const communityId = await createCommunityForMoneyPolicyTest(ctx.env, owner.accessToken)
    const repository = getControlPlaneCommunityRepository(ctx.env)

    const policy = await assertCommunityFundingQuoteEligible({
      communityId,
      repository,
      fundingAsset: null,
      sourceChain: null,
      routeProvider: null,
      destinationSettlementChain: {
        chainNamespace: "eip155",
        chainId: null,
      },
      destinationSettlementToken: "WIP",
      estimatedSlippageBps: 0,
      estimatedHopCount: 0,
      routeValidForSeconds: null,
    })

    expect(policy.policy_origin).toBe("default")
    expect(policy.route_required).toBe(false)
    expect(policy.destination_settlement_token).toBe("WIP")
  })

  test("explicit route-required policy allows a matching routed funding lane", async () => {
    const ctx = await createRouteTestContext()
    cleanup = ctx.cleanup

    const owner = await exchangeJwt(ctx.env, "money-policy-routed-owner")
    const communityId = await createCommunityForMoneyPolicyTest(ctx.env, owner.accessToken)
    const repository = getControlPlaneCommunityRepository(ctx.env)

    await repository.upsertCommunityMoneyPolicy({
      communityId,
      fundingPreference: "BTC",
      acceptedFundingAssetsJson: JSON.stringify([
        {
          asset_symbol: "cBTC",
          chain_namespace: "eip155",
          chain_id: 5115,
          display_name: "Citrea cBTC",
        },
      ]),
      acceptedSourceChainsJson: JSON.stringify([
        {
          chain_namespace: "eip155",
          chain_id: 5115,
          display_name: "Citrea",
        },
      ]),
      approvedRouteProvidersJson: JSON.stringify(["stargate"]),
      destinationSettlementChainJson: JSON.stringify({
        chain_namespace: "eip155",
        chain_id: null,
        display_name: "Story",
      }),
      destinationSettlementToken: "WIP",
      treasuryDenomination: "WIP",
      maxSlippageBps: 150,
      quoteTtlSeconds: 180,
      routeRequired: true,
      routeStatusPolicy: "fail",
      routeHopTolerance: 1,
      updatedAt: new Date().toISOString(),
    })

    const policy = await assertCommunityFundingQuoteEligible({
      communityId,
      repository,
      fundingAsset: {
        assetSymbol: "cBTC",
        chainNamespace: "eip155",
        chainId: 5115,
      },
      sourceChain: {
        chainNamespace: "eip155",
        chainId: 5115,
      },
      routeProvider: "stargate",
      destinationSettlementChain: {
        chainNamespace: "eip155",
        chainId: null,
      },
      destinationSettlementToken: "WIP",
      estimatedSlippageBps: 100,
      estimatedHopCount: 1,
      routeValidForSeconds: 180,
    })

    expect(policy.policy_origin).toBe("explicit")
    expect(policy.route_required).toBe(true)
    expect(policy.funding_preference).toBe("BTC")
  })

  test("explicit route-required policy fails closed for invalid route input", async () => {
    const ctx = await createRouteTestContext()
    cleanup = ctx.cleanup

    const owner = await exchangeJwt(ctx.env, "money-policy-routed-reject-owner")
    const communityId = await createCommunityForMoneyPolicyTest(ctx.env, owner.accessToken)
    const repository = getControlPlaneCommunityRepository(ctx.env)

    await repository.upsertCommunityMoneyPolicy({
      communityId,
      fundingPreference: "BTC",
      acceptedFundingAssetsJson: JSON.stringify([
        {
          asset_symbol: "cBTC",
          chain_namespace: "eip155",
          chain_id: 5115,
          display_name: "Citrea cBTC",
        },
      ]),
      acceptedSourceChainsJson: JSON.stringify([
        {
          chain_namespace: "eip155",
          chain_id: 5115,
          display_name: "Citrea",
        },
      ]),
      approvedRouteProvidersJson: JSON.stringify(["stargate"]),
      destinationSettlementChainJson: JSON.stringify({
        chain_namespace: "eip155",
        chain_id: null,
        display_name: "Story",
      }),
      destinationSettlementToken: "WIP",
      treasuryDenomination: "WIP",
      maxSlippageBps: 150,
      quoteTtlSeconds: 180,
      routeRequired: true,
      routeStatusPolicy: "fail",
      routeHopTolerance: 1,
      updatedAt: new Date().toISOString(),
    })

    try {
      await assertCommunityFundingQuoteEligible({
        communityId,
        repository,
        fundingAsset: {
          assetSymbol: "cBTC",
          chainNamespace: "eip155",
          chainId: 5115,
        },
        sourceChain: {
          chainNamespace: "eip155",
          chainId: 5115,
        },
        routeProvider: "across",
        destinationSettlementChain: {
          chainNamespace: "eip155",
          chainId: null,
        },
        destinationSettlementToken: "WIP",
        estimatedSlippageBps: 200,
        estimatedHopCount: 2,
        routeValidForSeconds: 60,
      })
      throw new Error("expected funding quote preflight to fail")
    } catch (error) {
      const err = error as { code?: string }
      expect(err.code).toBe("eligibility_failed")
    }
  })
})
