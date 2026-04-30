import { apiRoutes } from "@pirate/api-contracts"
import { getFlag, requireFlag } from "../args.js"
import { readOptionalTextFile, requireAdminForActor } from "../command-utils.js"
import { apiRequest } from "../http.js"
import { exitWithUsage, printJson } from "../output.js"
import { resolveSeedActorUserId } from "../seed-accounts.js"
import { buildSeedPostBodyFromArgs } from "../seed-post-body.js"
import { apiAuthHeadersForSession, requireStoredSession } from "../session.js"
import type { ParsedArgs } from "../types.js"

export async function seedPost(rest: string[], args: ParsedArgs): Promise<void> {
  const session = requireStoredSession()
  const communityId = rest[0]
  if (!communityId) {
    exitWithUsage("Usage: pirate community seed-post <community_id|@slug> (--as <alias>|--as-user-id <usr_...>) --idempotency-key <key> [--post-type text|link|image|video|song] [--title <title>|--title-file <file>] [--body <text>|--body-file <file>] [--link-url <url>] [--media-ref <ref> --mime-type <type>|--media-refs-file <file>] [--song-artifact-bundle-id <id>]")
  }
  const asUserId = resolveSeedActorUserId(args)
  requireAdminForActor(asUserId, session.mode)
  const body = buildSeedPostBodyFromArgs(args)
  const result = await apiRequest<unknown>({
    baseUrl: session.baseUrl,
    path: apiRoutes.communityPosts(communityId),
    method: "POST",
    ...apiAuthHeadersForSession(session, asUserId),
    adminOperationClass: session.mode === "admin" ? "launch_seed" : null,
    body,
  })
  printJson(result)
}

export async function seedComment(rest: string[], args: ParsedArgs): Promise<void> {
  const session = requireStoredSession()
  const communityId = rest[0]
  const postId = rest[1]
  if (!communityId || !postId) {
    exitWithUsage("Usage: pirate community seed-comment <community_id|@slug> <post_id> (--as <alias>|--as-user-id <usr_...>) --idempotency-key <key> (--body <text>|--body-file <file>) [--accounts-file <path>]")
  }
  const idempotencyKey = requireFlag(args, "idempotency-key")
  const asUserId = resolveSeedActorUserId(args)
  requireAdminForActor(asUserId, session.mode)
  const bodyText = getFlag(args, "body") ?? readOptionalTextFile(getFlag(args, "body-file"))
  if (!bodyText?.trim()) {
    exitWithUsage("Seed comments require --body or --body-file")
  }
  const result = await apiRequest<unknown>({
    baseUrl: session.baseUrl,
    path: apiRoutes.communityPostComments(communityId, postId),
    method: "POST",
    ...apiAuthHeadersForSession(session, asUserId),
    adminOperationClass: session.mode === "admin" ? "launch_seed" : null,
    body: {
      idempotency_key: idempotencyKey,
      body: bodyText,
      identity_mode: "public",
    },
  })
  printJson(result)
}

export async function joinCommunity(rest: string[], args: ParsedArgs): Promise<void> {
  const session = requireStoredSession()
  const communityId = rest[0]
  if (!communityId) {
    exitWithUsage("Usage: pirate community join <community_id|@slug> [--as <alias>|--as-user-id <usr_...>] [--note <text>]")
  }
  const asUserId = resolveSeedActorUserId(args)
  requireAdminForActor(asUserId, session.mode)
  const result = await apiRequest<unknown>({
    baseUrl: session.baseUrl,
    path: apiRoutes.communityJoin(communityId),
    method: "POST",
    ...apiAuthHeadersForSession(session, asUserId),
    body: { note: getFlag(args, "note") ?? null },
  })
  printJson(result)
}

export async function followCommunity(rest: string[], args: ParsedArgs): Promise<void> {
  const session = requireStoredSession()
  const communityId = rest[0]
  if (!communityId) {
    exitWithUsage("Usage: pirate community follow <community_id|@slug> [--as <alias>|--as-user-id <usr_...>]")
  }
  const asUserId = resolveSeedActorUserId(args)
  requireAdminForActor(asUserId, session.mode)
  const result = await apiRequest<unknown>({
    baseUrl: session.baseUrl,
    path: apiRoutes.communityFollow(communityId),
    method: "POST",
    ...apiAuthHeadersForSession(session, asUserId),
  })
  printJson(result)
}
