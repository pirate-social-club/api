import { randomUUID } from "node:crypto"
import { apiRoutes, type CreatePostRequest, type LocalizedPostResponse, type Post } from "@pirate/api-contracts"
import { getFlag, requireFlag } from "../args.js"
import { parseVoteValue, requireAdminForActor } from "../command-utils.js"
import { apiRequest } from "../http.js"
import { exitWithUsage, printJson } from "../output.js"
import { resolveSeedActorUserId } from "../seed-accounts.js"
import { apiAuthHeadersForSession, requireStoredSession } from "../session.js"
import type { ParsedArgs } from "../types.js"

export async function runPost(
  action: string | undefined,
  rest: string[],
  args: ParsedArgs,
): Promise<void> {
  const session = requireStoredSession()
  switch (action) {
    case "create": {
      const communityId = rest[0]
      if (!communityId) {
        exitWithUsage("Usage: pirate post create <community_id> --title <title> --body <body>")
      }
      const title = requireFlag(args, "title")
      const bodyText = requireFlag(args, "body")
      const idempotencyKey = getFlag(args, "idempotency-key") || randomUUID()
      const body: CreatePostRequest = {
        idempotency_key: idempotencyKey,
        post_type: "text",
        identity_mode: "public",
        title,
        body: bodyText,
      }
      const result = await apiRequest<Post>({
        baseUrl: session.baseUrl,
        path: apiRoutes.communityPosts(communityId),
        method: "POST",
        ...apiAuthHeadersForSession(session),
        body,
      })
      printJson(result)
      return
    }
    case "get": {
      const postId = rest[0]
      if (!postId) {
        exitWithUsage("Usage: pirate post get <post_id> [--locale <locale>]")
      }
      const locale = getFlag(args, "locale")
      const suffix = locale ? `?locale=${encodeURIComponent(locale)}` : ""
      const result = await apiRequest<LocalizedPostResponse>({
        baseUrl: session.baseUrl,
        path: `${apiRoutes.post(postId)}${suffix}`,
        ...apiAuthHeadersForSession(session),
      })
      printJson(result)
      return
    }
    case "vote": {
      const postId = rest[0]
      if (!postId) {
        exitWithUsage("Usage: pirate post vote <post_id> --value <1|-1> [--as <alias>|--as-user-id <usr_...>]")
      }
      const value = parseVoteValue(requireFlag(args, "value"))
      const asUserId = resolveSeedActorUserId(args)
      requireAdminForActor(asUserId, session.mode)
      const result = await apiRequest<unknown>({
        baseUrl: session.baseUrl,
        path: apiRoutes.postVote(postId),
        method: "POST",
        ...apiAuthHeadersForSession(session, asUserId),
        body: { value },
      })
      printJson(result)
      return
    }
    default:
      exitWithUsage("Usage: pirate post <create|get|vote>")
  }
}
