import { apiRoutes } from "@pirate/api-contracts"
import { requireFlag } from "../args.js"
import { parseVoteValue, requireAdminForActor } from "../command-utils.js"
import { apiRequest } from "../http.js"
import { exitWithUsage, printJson } from "../output.js"
import { resolveSeedActorUserId } from "../seed-accounts.js"
import { apiAuthHeadersForSession, requireStoredSession } from "../session.js"
import type { ParsedArgs } from "../types.js"

export async function runComment(
  action: string | undefined,
  rest: string[],
  args: ParsedArgs,
): Promise<void> {
  const session = requireStoredSession()
  switch (action) {
    case "vote": {
      const commentId = rest[0]
      if (!commentId) {
        exitWithUsage("Usage: pirate comment vote <comment_id> --value <1|-1> [--as <alias>|--as-user-id <usr_...>]")
      }
      const value = parseVoteValue(requireFlag(args, "value"))
      const asUserId = resolveSeedActorUserId(args)
      requireAdminForActor(asUserId, session.mode)
      const result = await apiRequest<unknown>({
        baseUrl: session.baseUrl,
        path: apiRoutes.commentVote(commentId),
        method: "POST",
        ...apiAuthHeadersForSession(session, asUserId),
        body: { value },
      })
      printJson(result)
      return
    }
    default:
      exitWithUsage("Usage: pirate comment <vote>")
  }
}
