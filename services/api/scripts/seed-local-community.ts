#!/usr/bin/env bun

import { resolve } from "node:path"
import app from "../src/index"
import type { Env } from "../src/types"
import { readModeEnv } from "./_lib/dev-vars"

const serviceRoot = resolve(import.meta.dirname, "..")
const fileEnv = readModeEnv(serviceRoot, "local-sqlite")
const env = { ...fileEnv, ...process.env } as Env

function requestJson(
  url: string,
  body: unknown,
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

async function json(response: Response): Promise<unknown> {
  return await response.json()
}

async function main(): Promise<void> {
  const rootLabel = process.argv[2] || "infinity"
  const displayName = process.argv[3] || "Infinity"

  const authResponse = await requestJson("http://pirate.test/auth/session/exchange", {
    proof: {
      type: "jwt_based_auth",
      jwt: await mintJwt(),
    },
  })
  if (authResponse.status !== 200) {
    throw new Error(`auth exchange failed: ${authResponse.status} ${await authResponse.text()}`)
  }
  const authBody = await json(authResponse) as { access_token: string; user: { user_id: string } }
  const accessToken = authBody.access_token

  const verificationSession = await requestJson("http://pirate.test/verification-sessions", {
    provider: "self",
  }, accessToken)
  if (verificationSession.status !== 201) {
    throw new Error(`verification session failed: ${verificationSession.status}`)
  }
  const verificationBody = await json(verificationSession) as { verification_session_id: string }
  await requestJson(
    `http://pirate.test/verification-sessions/${verificationBody.verification_session_id}/complete`,
    {},
    accessToken,
  )

  const namespaceSession = await requestJson("http://pirate.test/namespace-verification-sessions", {
    family: "hns",
    root_label: rootLabel,
  }, accessToken)
  if (namespaceSession.status !== 201) {
    throw new Error(`namespace session failed: ${namespaceSession.status}`)
  }
  const namespaceBody = await json(namespaceSession) as { namespace_verification_session_id: string }
  const completed = await requestJson(
    `http://pirate.test/namespace-verification-sessions/${namespaceBody.namespace_verification_session_id}/complete`,
    {},
    accessToken,
  )
  const completedBody = await json(completed) as { namespace_verification_id: string }

  const communityCreate = await requestJson("http://pirate.test/communities", {
    display_name: displayName,
    governance_mode: "centralized",
    namespace: {
      namespace_verification_id: completedBody.namespace_verification_id,
    },
    handle_policy: {
      policy_template: "standard",
    },
  }, accessToken)
  if (communityCreate.status !== 202) {
    throw new Error(`community create failed: ${communityCreate.status} ${await communityCreate.text()}`)
  }
  const communityCreateBody = await json(communityCreate) as {
    community: { community_id: string; display_name: string }
  }

  process.stdout.write([
    "",
    `seeded community: ${communityCreateBody.community.display_name}`,
    `  community_id = ${communityCreateBody.community.community_id}`,
    `  route_key    = ${rootLabel}`,
    `  url          = /c/${rootLabel}`,
    "",
  ].join("\n"))
}

async function mintJwt(): Promise<string> {
  const { SignJWT } = await import("jose")
  const encoder = new TextEncoder()
  const secret = String(env.AUTH_UPSTREAM_JWT_SHARED_SECRET)
  const issuer = String(env.AUTH_UPSTREAM_JWT_ISSUER)
  const audience = String(env.AUTH_UPSTREAM_JWT_AUDIENCE)
  const nowSeconds = Math.floor(Date.now() / 1000)

  return await new SignJWT()
    .setProtectedHeader({ alg: "HS256", typ: "JWT" })
    .setIssuer(issuer)
    .setAudience(audience)
    .setSubject("dev-seed-user")
    .setIssuedAt(nowSeconds)
    .setExpirationTime(nowSeconds + 3600)
    .sign(encoder.encode(secret))
}

await main()
