import {
  apiRoutes,
  type Community,
  type CommunityPreview,
  type CommunityCreateAcceptedResponse,
  type CreateCommunityRequest,
  type SessionExchangeResponse,
} from "@pirate/api-contracts"
import { createHmac } from "node:crypto"
import { getFlag, hasFlag, requireFlag } from "../args.js"
import { readOptionalTextFile } from "../command-utils.js"
import { readSeedAccounts, writeSeedAccounts } from "../config.js"
import { apiRequest } from "../http.js"
import { exitWithUsage, printJson } from "../output.js"
import { apiAuthHeadersForSession, requireStoredSession, resolveBaseUrl } from "../session.js"
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
  if (action === "accounts") {
    await runCommunityAccounts(rest, args)
    return
  }

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
    case "roles": {
      await runCommunityRoles(rest, args)
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
      exitWithUsage("Usage: pirate community <create|attach-namespace|get|lookup|update|preview|roles|accounts|apply|rules|gates|links|labels|safety|settings|donation-policy|seed-post|seed-comment|join|follow|launch-spaces|finalize-spaces>")
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

async function runCommunityRoles(rest: string[], args: ParsedArgs): Promise<void> {
  const session = requireStoredSession()
  const action = rest[0]
  const communityId = rest[1]
  if ((action !== "grant" && action !== "revoke") || !communityId) {
    exitWithUsage("Usage: pirate community roles <grant|revoke> <community_id|@slug> --role <admin|moderator> --user-id <usr_...>")
  }

  const role = requireFlag(args, "role")
  if (role !== "admin" && role !== "moderator") {
    exitWithUsage("Usage: pirate community roles <grant|revoke> <community_id|@slug> --role <admin|moderator> --user-id <usr_...>")
  }

  const userId = resolveCommunityRoleTargetUserId(args)
  const path = action === "grant"
    ? apiRoutes.communityRoleGrant(communityId)
    : apiRoutes.communityRoleRevoke(communityId)
  const result = await apiRequest<Community>({
    baseUrl: session.baseUrl,
    path,
    method: "POST",
    ...apiAuthHeadersForSession(session),
    body: {
      user_id: userId,
      role,
    },
  })
  printJson(result)
}

function resolveCommunityRoleTargetUserId(args: ParsedArgs): string {
  const explicit = getFlag(args, "user-id")
  if (explicit) {
    return explicit
  }

  const alias = getFlag(args, "account") ?? getFlag(args, "as")
  if (!alias) {
    exitWithUsage("Usage: pirate community roles <grant|revoke> <community_id|@slug> --role <admin|moderator> --user-id <usr_...>")
  }

  const accountsFile = getFlag(args, "accounts-file") ?? undefined
  const accounts = readSeedAccounts(accountsFile)
  const resolved = accounts[alias]
  if (!resolved) {
    throw new Error(`Unknown seed account alias ${alias}`)
  }
  return resolved
}

async function runCommunityAccounts(rest: string[], args: ParsedArgs): Promise<void> {
  const action = rest[0]
  if (action !== "ensure") {
    exitWithUsage("Usage: pirate community accounts ensure --alias <name> --subject <jwt-subject> [--display-name <name>] [--handle <label>]")
  }

  const baseUrl = resolveBaseUrl(getFlag(args, "base-url"))
  const alias = requireFlag(args, "alias")
  const subject = requireFlag(args, "subject")
  const jwt = mintBootstrapAccountJwt(args, subject)
  const session = await apiRequest<SessionExchangeResponse>({
    baseUrl,
    path: apiRoutes.authSessionExchange,
    method: "POST",
    body: {
      proof: {
        type: "jwt_based_auth",
        jwt,
      },
    },
  })

  const profilePatch = buildAccountProfilePatch(args)
  let profile: unknown = session.profile
  if (Object.keys(profilePatch).length > 0) {
    profile = await apiRequest<unknown>({
      baseUrl,
      path: apiRoutes.profilesMe,
      method: "PATCH",
      accessToken: session.access_token,
      body: profilePatch,
    })
  }

  const handle = getFlag(args, "handle")
  let globalHandle: unknown = null
  if (handle) {
    globalHandle = await apiRequest<unknown>({
      baseUrl,
      path: "/profiles/me/global-handle/rename",
      method: "POST",
      accessToken: session.access_token,
      body: {
        desired_label: handle,
      },
    })
  }

  const accountsFile = getFlag(args, "accounts-file") ?? undefined
  const accounts = readSeedAccounts(accountsFile)
  if (accounts[alias] && accounts[alias] !== session.user.user_id && !hasFlag(args, "force")) {
    throw new Error(`Seed account alias ${alias} already points to ${accounts[alias]}; pass --force to replace it`)
  }
  accounts[alias] = session.user.user_id
  writeSeedAccounts(accounts, accountsFile)

  printJson({
    alias,
    user_id: session.user.user_id,
    subject,
    seed_accounts_path: accountsFile ?? null,
    profile,
    global_handle: globalHandle,
  })
}

function buildAccountProfilePatch(args: ParsedArgs): Record<string, unknown> {
  const body: Record<string, unknown> = {}
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
  return body
}

function mintBootstrapAccountJwt(args: ParsedArgs, subject: string): string {
  const secret =
    getFlag(args, "jwt-secret")
    ?? process.env.AUTH_UPSTREAM_JWT_SHARED_SECRET
    ?? process.env.PIRATE_UPSTREAM_JWT_SHARED_SECRET
  const issuer =
    getFlag(args, "issuer")
    ?? process.env.AUTH_UPSTREAM_JWT_ISSUER
    ?? process.env.PIRATE_UPSTREAM_JWT_ISSUER
  const audience =
    getFlag(args, "audience")
    ?? process.env.AUTH_UPSTREAM_JWT_AUDIENCE
    ?? process.env.PIRATE_UPSTREAM_JWT_AUDIENCE
    ?? "pirate-api"
  const ttlSeconds = Number(getFlag(args, "ttl-seconds") ?? 3600)
  if (!secret) {
    exitWithUsage("Missing JWT secret. Set AUTH_UPSTREAM_JWT_SHARED_SECRET or pass --jwt-secret.")
  }
  if (!issuer) {
    exitWithUsage("Missing JWT issuer. Set AUTH_UPSTREAM_JWT_ISSUER or pass --issuer.")
  }
  if (!Number.isInteger(ttlSeconds) || ttlSeconds <= 0) {
    throw new Error("--ttl-seconds must be a positive integer")
  }

  const nowSeconds = Math.floor(Date.now() / 1000)
  const encodedHeader = encodeJwtPart({ alg: "HS256", typ: "JWT" })
  const encodedPayload = encodeJwtPart({
    iss: issuer,
    aud: audience,
    sub: subject,
    iat: nowSeconds,
    exp: nowSeconds + ttlSeconds,
  })
  const signingInput = `${encodedHeader}.${encodedPayload}`
  const signature = createHmac("sha256", secret)
    .update(signingInput)
    .digest("base64url")
  return `${signingInput}.${signature}`
}

function encodeJwtPart(value: Record<string, unknown>): string {
  return Buffer.from(JSON.stringify(value)).toString("base64url")
}
