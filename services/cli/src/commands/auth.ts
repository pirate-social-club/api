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
        mode: "user",
        base_url: baseUrl,
        access_token: response.access_token,
        user_id: response.user.id,
        issued_at: times.issuedAt,
        expires_at: times.expiresAt,
        token_type: "Bearer",
      })

      process.stdout.write(
        `${JSON.stringify(
          {
            stored_auth_path: getAuthPath(),
            user_id: response.user.id,
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
    case "admin-login": {
      const baseUrl = resolveBaseUrl(getFlag(args, "base-url"))
      const adminToken = getFlag(args, "admin-token") || process.env.PIRATE_ADMIN_TOKEN
      const asUserId = getFlag(args, "as-user") || getFlag(args, "as-user-id") || process.env.PIRATE_ADMIN_AS_USER_ID
      if (!adminToken) {
        exitWithUsage("Missing admin token. Use --admin-token <token> or PIRATE_ADMIN_TOKEN.")
      }
      if (!asUserId) {
        exitWithUsage("Missing acting user. Use --as-user <usr_...> or PIRATE_ADMIN_AS_USER_ID.")
      }

      try {
        await apiRequest<unknown>({
          baseUrl,
          path: apiRoutes.communitiesAdminHealth,
          adminToken,
          adminAsUserId: asUserId,
        })
      } catch (error) {
        throw new Error(`Admin token validation failed: ${error instanceof Error ? error.message : String(error)}`)
      }

      writeAuthState({
        mode: "admin",
        base_url: baseUrl,
        access_token: "",
        admin_token: adminToken,
        admin_as_user_id: asUserId,
        user_id: asUserId,
        issued_at: null,
        expires_at: null,
        token_type: "Bearer",
      })

      process.stdout.write(
        `${JSON.stringify(
          {
            stored_auth_path: getAuthPath(),
            mode: "admin",
            base_url: baseUrl,
            admin_as_user_id: asUserId,
          },
          null,
          2,
        )}\n`,
      )
      return
    }
    case "me": {
      const session = requireStoredSession()
      if (session.mode === "admin") {
        process.stdout.write(`${JSON.stringify({
          mode: "admin",
          base_url: session.baseUrl,
          admin_as_user_id: session.adminAsUserId,
        }, null, 2)}\n`)
        return
      }
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
      exitWithUsage("Usage: pirate auth <login|admin-login|me|logout>")
  }
}
