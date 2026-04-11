import { afterEach, describe, expect, test } from "bun:test"

import app from "../src/index"
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

async function exchangeJwt(env: Env, sub: string): Promise<{ accessToken: string }> {
  const jwt = await mintUpstreamJwt(env, { sub })
  const response = await requestJson("http://pirate.test/auth/session/exchange", {
    proof: {
      type: "jwt_based_auth",
      jwt,
    },
  }, env)
  const body = await json(response) as { access_token: string }
  return { accessToken: body.access_token }
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
    root_label: `TokenGateRoute-${Math.random().toString(16).slice(2)}`,
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

describe("community token gate routes", () => {
  afterEach(async () => {
    if (cleanup) {
      await cleanup()
      cleanup = null
    }
    resetRuntimeCaches()
  })

  test("community create accepts and persists ERC-721 membership gates", async () => {
    const ctx = await createRouteTestContext()
    cleanup = ctx.cleanup

    const creator = await exchangeJwt(ctx.env, "community-token-gate-creator")
    const namespaceVerificationId = await prepareVerifiedNamespace(ctx.env, creator.accessToken)

    const communityCreate = await requestJson("http://pirate.test/communities", {
      display_name: "Pirate Token Gate Club",
      namespace: {
        namespace_verification_id: namespaceVerificationId,
      },
      membership_mode: "gated",
      gate_rules: [
        {
          scope: "membership",
          gate_family: "token_holding",
          gate_type: "erc721_holding",
          chain_namespace: "eip155:1",
          gate_config: {
            contract_address: "0x00000000000000000000000000000000000000aa",
          },
        },
      ],
    }, ctx.env, creator.accessToken)

    expect(communityCreate.status).toBe(202)
    const communityCreateBody = await json(communityCreate) as {
      community: { community_id: string }
    }

    const gateRules = await app.request(
      `http://pirate.test/communities/${communityCreateBody.community.community_id}/gate-rules`,
      {
        method: "GET",
        headers: {
          authorization: `Bearer ${creator.accessToken}`,
        },
      },
      ctx.env,
    )

    expect(gateRules.status).toBe(200)
    const gateRulesBody = await json(gateRules) as {
      gate_rules: Array<{
        gate_family: string
        gate_type: string
        chain_namespace: string | null
        gate_config: Record<string, unknown> | null
      }>
    }
    expect(gateRulesBody.gate_rules).toHaveLength(1)
    expect(gateRulesBody.gate_rules[0]?.gate_family).toBe("token_holding")
    expect(gateRulesBody.gate_rules[0]?.gate_type).toBe("erc721_holding")
    expect(gateRulesBody.gate_rules[0]?.chain_namespace).toBe("eip155:1")
    expect(gateRulesBody.gate_rules[0]?.gate_config).toEqual({
      contract_address: "0x00000000000000000000000000000000000000AA",
    })
  })

  test("community create accepts and persists ERC-1155 posting gates", async () => {
    const ctx = await createRouteTestContext()
    cleanup = ctx.cleanup

    const creator = await exchangeJwt(ctx.env, "community-token-gate-erc1155-creator")
    const namespaceVerificationId = await prepareVerifiedNamespace(ctx.env, creator.accessToken)

    const communityCreate = await requestJson("http://pirate.test/communities", {
      display_name: "Pirate Token Gate 1155 Club",
      namespace: {
        namespace_verification_id: namespaceVerificationId,
      },
      gate_rules: [
        {
          scope: "posting",
          gate_family: "token_holding",
          gate_type: "erc1155_holding",
          chain_namespace: "eip155:137",
          gate_config: {
            contract_address: "0x00000000000000000000000000000000000000aa",
            token_id: 42,
            min_balance: 3,
          },
        },
      ],
    }, ctx.env, creator.accessToken)

    expect(communityCreate.status).toBe(202)
    const communityCreateBody = await json(communityCreate) as {
      community: { community_id: string }
    }

    const gateRules = await app.request(
      `http://pirate.test/communities/${communityCreateBody.community.community_id}/gate-rules`,
      {
        method: "GET",
        headers: {
          authorization: `Bearer ${creator.accessToken}`,
        },
      },
      ctx.env,
    )

    expect(gateRules.status).toBe(200)
    const gateRulesBody = await json(gateRules) as {
      gate_rules: Array<{
        gate_family: string
        gate_type: string
        chain_namespace: string | null
        gate_config: Record<string, unknown> | null
      }>
    }
    expect(gateRulesBody.gate_rules).toHaveLength(1)
    expect(gateRulesBody.gate_rules[0]?.gate_family).toBe("token_holding")
    expect(gateRulesBody.gate_rules[0]?.gate_type).toBe("erc1155_holding")
    expect(gateRulesBody.gate_rules[0]?.chain_namespace).toBe("eip155:137")
    expect(gateRulesBody.gate_rules[0]?.gate_config).toEqual({
      contract_address: "0x00000000000000000000000000000000000000AA",
      token_id: "42",
      min_balance: "3",
    })
  })
})
