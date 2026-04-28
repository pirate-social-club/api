import { apiRoutes } from "@pirate/api-contracts"
import { getFlag, hasFlag } from "../args.js"
import { readJsonObject, readOptionalTextFile, requireAdminForActor } from "../command-utils.js"
import { apiRequest } from "../http.js"
import { exitWithUsage, printJson } from "../output.js"
import { resolveSeedActorUserId } from "../seed-accounts.js"
import { apiAuthHeadersForSession, requireStoredSession } from "../session.js"
import type { ParsedArgs } from "../types.js"

export async function runProfile(
  action: string | undefined,
  args: ParsedArgs,
): Promise<void> {
  const session = requireStoredSession()
  switch (action) {
    case "me": {
      const asUserId = resolveSeedActorUserId(args)
      requireAdminForActor(asUserId, session.mode)
      const result = await apiRequest<unknown>({
        baseUrl: session.baseUrl,
        path: apiRoutes.profilesMe,
        ...apiAuthHeadersForSession(session, asUserId),
      })
      printJson(result)
      return
    }
    case "update": {
      const asUserId = resolveSeedActorUserId(args)
      requireAdminForActor(asUserId, session.mode)
      const body = buildProfileUpdateBody(args)
      if (Object.keys(body).length === 0) {
        exitWithUsage("Usage: pirate profile update [--as <alias>|--as-user-id <usr_...>] [--file <profile.json>] [--display-name <name>] [--bio <text>|--bio-file <file>] [--preferred-locale <locale>] [--avatar-ref <ref>] [--avatar-source ens|upload|none]")
      }
      const result = await apiRequest<unknown>({
        baseUrl: session.baseUrl,
        path: apiRoutes.profilesMe,
        method: "PATCH",
        ...apiAuthHeadersForSession(session, asUserId),
        body,
      })
      printJson(result)
      return
    }
    default:
      exitWithUsage("Usage: pirate profile <me|update>")
  }
}

function buildProfileUpdateBody(args: ParsedArgs): Record<string, unknown> {
  const file = getFlag(args, "file")
  const body = file ? readJsonObject(file, "Profile file") : {}
  const displayName = getFlag(args, "display-name")
  const bio = getFlag(args, "bio") ?? readOptionalTextFile(getFlag(args, "bio-file"))
  const preferredLocale = getFlag(args, "preferred-locale")
  const avatarRef = getFlag(args, "avatar-ref")
  const avatarSource = getFlag(args, "avatar-source")
  if (displayName != null) body.display_name = displayName
  if (bio != null) body.bio = bio
  if (preferredLocale != null) body.preferred_locale = preferredLocale
  if (avatarRef != null) body.avatar_ref = avatarRef
  if (avatarSource != null) body.avatar_source = avatarSource
  if (hasFlag(args, "display-verified-nationality-badge")) {
    body.display_verified_nationality_badge = true
  }
  if (hasFlag(args, "hide-verified-nationality-badge")) {
    body.display_verified_nationality_badge = false
  }
  return body
}
