import {
  apiRoutes,
  type Community,
  type CommunityCreateAcceptedResponse,
  type CreateCommunityRequest,
} from "@pirate/api-contracts"
import { requireFlag } from "../args.js"
import { apiRequest } from "../http.js"
import { exitWithUsage, printJson } from "../output.js"
import { requireStoredSession } from "../session.js"
import type { ParsedArgs } from "../types.js"

export async function runCommunity(
  action: string | undefined,
  rest: string[],
  args: ParsedArgs,
): Promise<void> {
  const session = requireStoredSession()
  switch (action) {
    case "create": {
      const displayName = requireFlag(args, "display-name")
      const namespaceVerificationId = requireFlag(args, "namespace-verification-id")
      const body: CreateCommunityRequest = {
        display_name: displayName,
        membership_mode: "open",
        governance_mode: "centralized",
        default_age_gate_policy: "none",
        allow_anonymous_identity: false,
        handle_policy: {
          policy_template: "standard",
        },
        namespace: {
          namespace_verification_id: namespaceVerificationId,
        },
      }
      const result = await apiRequest<CommunityCreateAcceptedResponse>({
        baseUrl: session.baseUrl,
        path: apiRoutes.communities,
        method: "POST",
        accessToken: session.accessToken,
        body,
      })
      printJson(result)
      return
    }
    case "get": {
      const communityId = rest[0]
      if (!communityId) {
        exitWithUsage("Usage: pirate community get <community_id>")
      }
      const result = await apiRequest<Community>({
        baseUrl: session.baseUrl,
        path: apiRoutes.community(communityId),
        accessToken: session.accessToken,
      })
      printJson(result)
      return
    }
    default:
      exitWithUsage("Usage: pirate community <create|get>")
  }
}
