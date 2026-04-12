import { afterEach, beforeEach, describe, expect, test } from "bun:test"
import app from "../src/index"
import {
  buildStubSpacesRootPubkey,
  buildStubSpacesSignature,
} from "../src/lib/verification/spaces-verifier"
import { createRouteTestContext, json, mintUpstreamJwt, resetRuntimeCaches } from "./helpers"
import type { Env } from "../src/types"

let cleanup: (() => Promise<void>) | null = null

function requestJson(
  url: string,
  body: unknown,
  env: Env,
  token?: string,
): Promise<Response> {
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

async function completeUniqueHumanVerification(env: Env, accessToken: string): Promise<void> {
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
}

async function prepareVerifiedNamespace(
  env: Env,
  accessToken: string,
  rootLabel = "PirateCommunityRoot",
): Promise<string> {
  await completeUniqueHumanVerification(env, accessToken)
  const namespaceSession = await requestJson("http://pirate.test/namespace-verification-sessions", {
    family: "hns",
    root_label: rootLabel,
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

async function prepareVerifiedSpacesNamespace(
  env: Env,
  accessToken: string,
  rootLabel = "@pirate",
): Promise<string> {
  await completeUniqueHumanVerification(env, accessToken)
  const normalizedRootLabel = rootLabel.replace(/^@/, "").toLowerCase()
  const namespaceSession = await requestJson("http://pirate.test/namespace-verification-sessions", {
    family: "spaces",
    root_label: rootLabel,
  }, env, accessToken)
  const namespaceBody = await json(namespaceSession) as {
    namespace_verification_session_id: string
    challenge_payload?: { digest?: string | null } | null
  }
  const digest = namespaceBody.challenge_payload?.digest ?? null
  const rootPubkey = buildStubSpacesRootPubkey(normalizedRootLabel)
  const signature = buildStubSpacesSignature({
    digest: digest as string,
    rootPubkey,
  })
  const completed = await requestJson(
    `http://pirate.test/namespace-verification-sessions/${namespaceBody.namespace_verification_session_id}/complete`,
    {
      signature_payload: {
        signature,
        algorithm: "bip340_schnorr",
        signer_pubkey: rootPubkey,
        digest,
      },
    },
    env,
    accessToken,
  )
  const completedBody = await json(completed) as { namespace_verification_id: string }
  return completedBody.namespace_verification_id
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

describe("community namespace routes", () => {
  test("public namespace lookup resolves plain normalized root label without auth", async () => {
    const ctx = await createRouteTestContext()
    cleanup = ctx.cleanup

    const owner = await exchangeJwt(ctx.env, "public-community-namespace-read-owner")
    const namespaceVerificationId = await prepareVerifiedNamespace(ctx.env, owner.accessToken, "infinity-namespace")

    const communityCreate = await requestJson("http://pirate.test/communities", {
      display_name: "Infinity Namespace",
      namespace: {
        namespace_verification_id: namespaceVerificationId,
      },
    }, ctx.env, owner.accessToken)
    expect(communityCreate.status).toBe(202)

    const communityResponse = await app.request(
      "http://pirate.test/communities/by-namespace/infinity-namespace",
      {},
      ctx.env,
    )
    expect(communityResponse.status).toBe(200)
  })

  test("public namespace lookup rejects @-prefixed HNS labels without auth", async () => {
    const ctx = await createRouteTestContext()
    cleanup = ctx.cleanup

    const owner = await exchangeJwt(ctx.env, "public-community-read-with-at-owner")
    const namespaceVerificationId = await prepareVerifiedNamespace(ctx.env, owner.accessToken, "at-infinity")

    const communityCreate = await requestJson("http://pirate.test/communities", {
      display_name: "At Infinity",
      namespace: {
        namespace_verification_id: namespaceVerificationId,
      },
    }, ctx.env, owner.accessToken)
    expect(communityCreate.status).toBe(202)

    const communityResponse = await app.request(
      "http://pirate.test/communities/by-namespace/%40at-infinity",
      {},
      ctx.env,
    )
    expect(communityResponse.status).toBe(404)
  })

  test("public namespace lookup resolves @-prefixed Spaces labels without auth", async () => {
    const ctx = await createRouteTestContext({
      ALLOW_STUB_NAMESPACE_VERIFICATION: "true",
    })
    cleanup = ctx.cleanup

    const owner = await exchangeJwt(ctx.env, "public-community-read-spaces-owner")
    const namespaceVerificationId = await prepareVerifiedSpacesNamespace(ctx.env, owner.accessToken, "@pirate")

    const communityCreate = await requestJson("http://pirate.test/communities", {
      display_name: "Pirate",
      namespace: {
        namespace_verification_id: namespaceVerificationId,
      },
    }, ctx.env, owner.accessToken)
    expect(communityCreate.status).toBe(202)

    const communityResponse = await app.request(
      "http://pirate.test/communities/by-namespace/%40pirate",
      {},
      ctx.env,
    )
    expect(communityResponse.status).toBe(200)
    const communityBody = await json(communityResponse) as {
      community_id: string
      display_name: string
      namespace_verification_id: string | null
    }
    expect(communityBody.community_id).toMatch(/^cmt_/)
    expect(communityBody.display_name).toBe("Pirate")
    expect(typeof communityBody.namespace_verification_id).toBe("string")
  })
})
