import { app } from "../../../src/index"
import { json, mintUpstreamJwt } from "../../helpers"
import type { Env } from "../../../src/types"

export function requestJson(
  url: string,
  method: "POST" | "PATCH",
  body: unknown,
  env: Env,
  token?: string,
): Promise<Response> {
  const normalizedUrl = normalizeProfileTestUrl(url)
  const normalizedMethod = method === "PATCH" ? "POST" : method
  return Promise.resolve(app.request(
    normalizedUrl,
    {
      method: normalizedMethod,
      headers: {
        "content-type": "application/json",
        ...(token ? { authorization: `Bearer ${token}` } : {}),
      },
      body: JSON.stringify(body),
    },
    env,
  ))
}

function normalizeProfileTestUrl(url: string): string {
  return url
    .replace("/profiles/me/global-handle/rename", "/profiles/me/rename-global-handle")
    .replace("/profiles/me/global-handle/upgrade-quote", "/profiles/me/quote-handle-upgrade")
    .replace("/profiles/me/global-handle/reddit-claim", "/profiles/me/global-handle/reddit-claim")
    .replace("/profiles/me/linked-handles/sync", "/profiles/me/sync-linked-handles")
    .replace("/profiles/me/primary-public-handle", "/profiles/me/set-primary-public-handle")
}

export async function exchangeJwt(env: Env, sub: string): Promise<{ accessToken: string; userId: string; publicUserId: string }> {
  const jwt = await mintUpstreamJwt(env, { sub })
  const response = await requestJson("http://pirate.test/auth/session/exchange", "POST", {
    proof: {
      type: "jwt_based_auth",
      jwt,
    },
  }, env)
  const body = await json(response) as { access_token: string; user: { id: string } }
  const publicUserId = body.user.id
  return {
    accessToken: body.access_token,
    userId: publicUserId.replace(/^usr_/, ""),
    publicUserId,
  }
}
