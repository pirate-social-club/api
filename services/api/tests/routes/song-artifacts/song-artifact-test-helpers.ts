import { app } from "../../../src/index"
import { json, mintUpstreamJwt } from "../../helpers"
import type { Env } from "../../../src/types"

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

export async function exchangeJwt(env: Env, sub: string): Promise<{
  accessToken: string
  userId: string
  primaryWalletAttachmentId: string | null
}> {
  const jwt = await mintUpstreamJwt(env, { sub })
  const response = await requestJson("http://pirate.test/auth/session/exchange", {
    proof: {
      type: "jwt_based_auth",
      jwt,
    },
  }, env)
  const body = await json(response) as {
    access_token: string
    user: {
      id: string
      primary_wallet_attachment?: string | null
    }
    wallet_attachments?: Array<{
      wallet_attachment: string
      is_primary?: boolean | null
    }>
  }
  const primaryWalletAttachmentId = body.user.primary_wallet_attachment
    ?? body.wallet_attachments?.find((attachment) => attachment.is_primary)?.wallet_attachment
    ?? body.wallet_attachments?.[0]?.wallet_attachment
    ?? null
  return {
    accessToken: body.access_token,
    userId: body.user.id.replace(/^usr_/, ""),
    primaryWalletAttachmentId,
  }
}

export async function completeUniqueHumanVerification(
  env: Env,
  accessToken: string,
): Promise<void> {
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
}
