import type { SessionSnapshot } from "../lib/auth/auth-db-rows"

export type BotUserProvisionResponse = SessionSnapshot & {
  created: boolean
  user_id: string
  handle: string
  wallet_address: string
}

export type BotUserTokenResponse = {
  access_token: string
  user_id: string
  token_type: "Bearer"
}

export function serializeBotUserProvisionResponse(response: BotUserProvisionResponse): BotUserProvisionResponse {
  return response
}

export function serializeBotUserTokenResponse(response: BotUserTokenResponse): BotUserTokenResponse {
  return response
}
