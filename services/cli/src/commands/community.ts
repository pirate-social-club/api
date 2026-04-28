import {
  apiRoutes,
  type Community,
  type CommunityPreview,
  type CommunityCreateAcceptedResponse,
  type CreateCommunityRequest,
} from "@pirate/api-contracts"
import { getFlag, hasFlag, requireFlag } from "../args.js"
import { apiRequest } from "../http.js"
import { exitWithUsage, printJson } from "../output.js"
import { apiAuthHeadersForSession, requireStoredSession } from "../session.js"
import type { ParsedArgs } from "../types.js"
import { applyCommunityManifest } from "./community-manifest.js"
import { followCommunity, joinCommunity, seedComment, seedPost } from "./community-seed.js"
import {
  normalizeReferenceLinksPayload,
  runCommunityGates,
  runCommunityJsonSetting,
  runCommunityRules,
  runCommunitySettings,
} from "./community-settings.js"
import { finalizeSpacesCommunity, launchSpacesCommunity } from "./community-spaces.js"

export {
  assertExecutableNamespaceVerificationId,
  buildConventionalFolderPlan,
  buildManifestPlan,
  parseSimpleYaml,
} from "./community-manifest.js"
export { buildSelfNationalityGatePayload } from "./community-settings.js"

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
      const description = getFlag(args, "description")
      const body: CreateCommunityRequest = {
        display_name: displayName,
        description: description ?? null,
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
        ...apiAuthHeadersForSession(session),
        body,
      })
      printJson(result)
      return
    }
    case "attach-namespace": {
      await attachNamespace(rest, args)
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
        ...apiAuthHeadersForSession(session),
      })
      printJson(result)
      return
    }
    case "lookup": {
      await lookupCommunity(rest)
      return
    }
    case "update": {
      await updateCommunity(rest, args)
      return
    }
    case "preview": {
      await previewCommunity(rest, args)
      return
    }
    case "rules": {
      await runCommunityRules(rest, args)
      return
    }
    case "gates": {
      await runCommunityGates(rest, args)
      return
    }
    case "links": {
      await runCommunityJsonSetting(rest, args, {
        pathSuffix: "reference-links",
        method: "PUT",
        usage: "Usage: pirate community links set <community_id|@slug> --file <links.json>",
        normalize: normalizeReferenceLinksPayload,
      })
      return
    }
    case "labels": {
      await runCommunityJsonSetting(rest, args, {
        pathSuffix: "labels",
        method: "PATCH",
        usage: "Usage: pirate community labels set <community_id|@slug> --file <labels.json>",
        normalize: (value) => value,
      })
      return
    }
    case "safety": {
      await runCommunityJsonSetting(rest, args, {
        pathSuffix: "safety",
        method: "PUT",
        usage: "Usage: pirate community safety set <community_id|@slug> --file <safety.json>",
        normalize: (value) => value,
      })
      return
    }
    case "settings": {
      await runCommunitySettings(rest, args)
      return
    }
    case "donation-policy": {
      await runCommunityJsonSetting(rest, args, {
        pathSuffix: "donation-policy",
        method: "PATCH",
        usage: "Usage: pirate community donation-policy set <community_id|@slug> --file <donation-policy.json>",
        normalize: (value) => value,
      })
      return
    }
    case "seed-post": {
      await seedPost(rest, args)
      return
    }
    case "seed-comment": {
      await seedComment(rest, args)
      return
    }
    case "join": {
      await joinCommunity(rest, args)
      return
    }
    case "follow": {
      await followCommunity(rest, args)
      return
    }
    case "apply": {
      await applyCommunityManifest(rest, args)
      return
    }
    case "launch-spaces": {
      await launchSpacesCommunity(rest, args)
      return
    }
    case "finalize-spaces": {
      await finalizeSpacesCommunity(rest, args)
      return
    }
    default:
      exitWithUsage("Usage: pirate community <create|attach-namespace|get|lookup|update|preview|apply|rules|gates|links|labels|safety|settings|donation-policy|seed-post|seed-comment|join|follow|launch-spaces|finalize-spaces>")
  }
}

async function attachNamespace(rest: string[], args: ParsedArgs): Promise<void> {
  const session = requireStoredSession()
  const communityId = rest[0]
  if (!communityId) {
    exitWithUsage("Usage: pirate community attach-namespace <community_id> --namespace-verification-id <nv_...>")
  }
  const namespaceVerificationId = requireFlag(args, "namespace-verification-id")
  const result = await apiRequest<Community>({
    baseUrl: session.baseUrl,
    path: `${apiRoutes.community(communityId)}/namespace`,
    method: "POST",
    ...apiAuthHeadersForSession(session),
    body: {
      namespace_verification_id: namespaceVerificationId,
    },
  })
  printJson(result)
}

async function updateCommunity(rest: string[], args: ParsedArgs): Promise<void> {
  const session = requireStoredSession()
  const communityId = rest[0]
  if (!communityId) {
    exitWithUsage("Usage: pirate community update <community_id> [--display-name <name>] [--description <text>] [--clear-description]")
  }

  const displayName = getFlag(args, "display-name")
  const description = getFlag(args, "description")
  const body: Record<string, unknown> = {}
  if (displayName != null) {
    body.display_name = displayName
  }
  if (description != null) {
    body.description = description
  } else if (hasFlag(args, "clear-description")) {
    body.description = null
  }
  if (Object.keys(body).length === 0) {
    exitWithUsage("Usage: pirate community update <community_id> [--display-name <name>] [--description <text>] [--clear-description]")
  }

  const result = await apiRequest<Community>({
    baseUrl: session.baseUrl,
    path: apiRoutes.community(communityId),
    method: "PATCH",
    ...apiAuthHeadersForSession(session),
    body,
  })
  printJson(result)
}

async function lookupCommunity(rest: string[]): Promise<void> {
  const session = requireStoredSession()
  const communityId = rest[0]
  if (!communityId) {
    exitWithUsage("Usage: pirate community lookup <community_id|@slug>")
  }
  const community = await apiRequest<Community>({
    baseUrl: session.baseUrl,
    path: apiRoutes.community(communityId),
    ...apiAuthHeadersForSession(session),
  })
  printJson({
    community_id: community.community_id,
    route_slug: community.route_slug ?? null,
    display_name: community.display_name,
    status: community.status,
    provisioning_state: community.provisioning_state,
    created_by_user_id: community.created_by_user_id,
    membership_mode: community.membership_mode,
  })
}

async function previewCommunity(rest: string[], args: ParsedArgs): Promise<void> {
  const session = requireStoredSession()
  const communityId = rest[0]
  if (!communityId) {
    exitWithUsage("Usage: pirate community preview <community_id> [--locale <locale>]")
  }

  const locale = getFlag(args, "locale")
  const suffix = locale ? `?locale=${encodeURIComponent(locale)}` : ""
  const result = await apiRequest<CommunityPreview>({
    baseUrl: session.baseUrl,
    path: `${apiRoutes.communityPreview(communityId)}${suffix}`,
    ...apiAuthHeadersForSession(session),
  })
  printJson(result)
}
