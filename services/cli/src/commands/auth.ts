import {
  apiRoutes,
  type SessionExchangeRequest,
  type SessionExchangeResponse,
  type User,
} from "@pirate/api-contracts"
import { getFlag } from "../args.js"
import { clearAuthState, getAuthPath, writeAuthState } from "../config.js"
import { apiRequest } from "../http.js"
import { exitWithUsage } from "../output.js"
import { decodeJwtTimes, requireStoredSession, resolveBaseUrl } from "../session.js"
import type { ParsedArgs } from "../types.js"

export async function runAuth(action: string | undefined, args: ParsedArgs): Promise<void> {
  switch (action) {
    case "login": {
      const baseUrl = resolveBaseUrl(getFlag(args, "base-url"))
      const jwt = getFlag(args, "jwt") || process.env.PIRATE_UPSTREAM_JWT
      if (!jwt) {
        exitWithUsage("Missing upstream JWT. Use --jwt <token> or PIRATE_UPSTREAM_JWT.")
      }

      const body: SessionExchangeRequest = {
        proof: {
          type: "jwt_based_auth",
          jwt,
        },
      }
      const response = await apiRequest<SessionExchangeResponse>({
        baseUrl,
        path: apiRoutes.authSessionExchange,
        method: "POST",
        body,
      })

      const times = decodeJwtTimes(response.access_token)
      writeAuthState({
        base_url: baseUrl,
        access_token: response.access_token,
        user_id: response.user.user_id,
        issued_at: times.issuedAt,
        expires_at: times.expiresAt,
        token_type: "Bearer",
      })

      process.stdout.write(
        `${JSON.stringify(
          {
            stored_auth_path: getAuthPath(),
            user_id: response.user.user_id,
            base_url: baseUrl,
            issued_at: times.issuedAt,
            expires_at: times.expiresAt,
            profile: response.profile,
            onboarding: response.onboarding,
            wallet_attachments: response.wallet_attachments,
          },
          null,
          2,
        )}\n`,
      )
      return
    }
    case "me": {
      const session = requireStoredSession()
      const user = await apiRequest<User>({
        baseUrl: session.baseUrl,
        path: apiRoutes.usersMe,
        accessToken: session.accessToken,
      })
      process.stdout.write(`${JSON.stringify(user, null, 2)}\n`)
      return
    }
    case "logout": {
      clearAuthState()
      process.stdout.write(
        `${JSON.stringify(
          {
            stored_auth_path: getAuthPath(),
            cleared: true,
          },
          null,
          2,
        )}\n`,
      )
      return
    }
    default:
      exitWithUsage("Usage: pirate auth <login|me|logout>")
  }
}
