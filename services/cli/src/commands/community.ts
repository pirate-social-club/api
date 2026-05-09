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
import { readJsonFile, readOptionalTextFile } from "../command-utils.js"
import { deriveBotWallet } from "../bot-wallet.js"
import { readSeedAccounts, writeSeedAccountEntries, writeSeedAccounts } from "../config.js"
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
  buildJsonManifestPlan,
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
          namespace_verification: namespaceVerificationId,
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
    case "members": {
      await membersCommunity(rest, args)
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
        method: "POST",
        usage: "Usage: pirate community links set <community_id|@slug> --file <links.json>",
        normalize: normalizeReferenceLinksPayload,
      })
      return
    }
    case "labels": {
      await runCommunityJsonSetting(rest, args, {
        pathSuffix: "labels",
        method: "POST",
        usage: "Usage: pirate community labels set <community_id|@slug> --file <labels.json>",
        normalize: (value) => value,
      })
      return
    }
    case "safety": {
      await runCommunityJsonSetting(rest, args, {
        pathSuffix: "safety",
        method: "POST",
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
        method: "POST",
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
      exitWithUsage("Usage: pirate community <create|attach-namespace|get|lookup|update|preview|members|roles|accounts|apply|rules|gates|links|labels|safety|settings|donation-policy|seed-post|seed-comment|join|follow|launch-spaces|finalize-spaces>")
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
      namespace_verification: namespaceVerificationId,
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
    method: "POST",
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
    community_id: community.id,
    route_slug: community.route_slug ?? null,
    display_name: community.display_name,
    status: community.status,
    provisioning_state: community.provisioning_state,
    created_by_user_id: community.created_by_user,
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

async function membersCommunity(rest: string[], args: ParsedArgs): Promise<void> {
  const session = requireStoredSession()
  const communityId = rest[0]
  if (!communityId) {
    exitWithUsage("Usage: pirate community members <community_id|@slug> [--locale <locale>]")
  }

  const locale = getFlag(args, "locale")
  const suffix = locale ? `?locale=${encodeURIComponent(locale)}` : ""
  const result = await apiRequest<CommunityPreview>({
    baseUrl: session.baseUrl,
    path: `${apiRoutes.communityPreview(communityId)}${suffix}`,
    ...apiAuthHeadersForSession(session),
  })
  const preview = result as Record<string, unknown>
  printJson({
    community_id: typeof preview.id === "string" ? preview.id : communityId,
    route_slug: typeof preview.route_slug === "string" ? preview.route_slug : null,
    display_name: typeof preview.display_name === "string" ? preview.display_name : null,
    membership_mode: typeof preview.membership_mode === "string" ? preview.membership_mode : null,
    member_count: typeof preview.member_count === "number" ? preview.member_count : null,
    follower_count: typeof preview.follower_count === "number" ? preview.follower_count : null,
    viewer_membership_status: typeof preview.viewer_membership_status === "string" ? preview.viewer_membership_status : null,
  })
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
    ? `${apiRoutes.community(communityId)}/roles/grant`
    : `${apiRoutes.community(communityId)}/roles/revoke`
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
  if (action === "provision-batch") {
    await provisionBatchCommunityAccounts(args)
    return
  }
  if (action !== "ensure") {
    exitWithUsage("Usage: pirate community accounts <ensure|provision-batch>")
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
      method: "POST",
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
  if (accounts[alias] && accounts[alias] !== session.user.id && !hasFlag(args, "force")) {
    throw new Error(`Seed account alias ${alias} already points to ${accounts[alias]}; pass --force to replace it`)
  }
  accounts[alias] = session.user.id
  writeSeedAccounts(accounts, accountsFile)

  printJson({
    alias,
    user_id: session.user.id,
    subject,
    seed_accounts_path: accountsFile ?? null,
    profile,
    global_handle: globalHandle,
  })
}

type ProvisionBatchAccountSpec = {
  alias: string | null
  avatar_ref: string | null
  bio: string | null
  communities: string[]
  cover_ref: string | null
  display_name: string | null
  handle: string
}

type BotUserProvisionResponse = {
  created?: boolean
  handle?: string
  user_id?: string
  wallet_address?: string
}

async function provisionBatchCommunityAccounts(args: ParsedArgs): Promise<void> {
  const file = requireFlag(args, "file")
  const walletMasterSecret = process.env.BOT_WALLET_MASTER_SECRET
  const adminToken = getFlag(args, "admin-token") || process.env.PIRATE_ADMIN_TOKEN
  const baseUrl = resolveBaseUrl(getFlag(args, "base-url"))
  if (!walletMasterSecret) {
    exitWithUsage("Missing BOT_WALLET_MASTER_SECRET.")
  }
  if (!adminToken) {
    exitWithUsage("Missing admin token. Use --admin-token <token> or PIRATE_ADMIN_TOKEN.")
  }

  const specs = readProvisionBatchSpecs(file)
  const accountsFile = getFlag(args, "accounts-file") ?? undefined
  const existing = readSeedAccounts(accountsFile)
  const entries: Record<string, unknown> = {}
  const aliases = new Set<string>()
  const succeeded: Array<{ alias: string; handle: string; user_id: string; created: boolean | null }> = []

  for (const spec of specs) {
    const alias = spec.alias ?? deriveSeedAccountAlias(spec.handle)
    if (aliases.has(alias)) {
      throw new Error(`Duplicate provision-batch alias ${alias}`)
    }
    aliases.add(alias)
    const wallet = deriveBotWallet({ handle: spec.handle, walletMasterSecret })
    if (existing[alias] && !hasFlag(args, "force")) {
      throw new Error(`Seed account alias ${alias} already points to ${existing[alias]}; pass --force to replace it`)
    }
    try {
      const response = await apiRequest<BotUserProvisionResponse>({
        baseUrl,
        path: "/admin/bot-users/provision",
        method: "POST",
        adminToken,
        body: {
          handle: wallet.handle,
          wallet_address: wallet.walletAddress,
          ...(spec.display_name ? { display_name: spec.display_name } : {}),
          ...(spec.bio ? { bio: spec.bio } : {}),
          ...(spec.avatar_ref ? { avatar_ref: spec.avatar_ref } : {}),
          ...(spec.cover_ref ? { cover_ref: spec.cover_ref } : {}),
        },
      })
      const userId = response.user_id
      if (!userId) {
        throw new Error(`Provision response for ${spec.handle} did not include user_id`)
      }
      entries[alias] = {
        user_id: userId,
        provider: "bot_wallet",
        handle: response.handle ?? wallet.handle,
        wallet_address: response.wallet_address ?? wallet.walletAddress,
        ...(spec.communities.length > 0 ? { communities: spec.communities } : {}),
      }
      succeeded.push({
        alias,
        handle: response.handle ?? wallet.handle,
        user_id: userId,
        created: typeof response.created === "boolean" ? response.created : null,
      })
    } catch (error) {
      printJson({
        status: "failed",
        failed: { alias, handle: spec.handle, error: error instanceof Error ? error.message : String(error) },
        succeeded,
        seed_accounts_path: accountsFile ?? null,
      })
      process.exitCode = 1
      return
    }
  }

  writeSeedAccountEntries(entries, accountsFile)
  printJson({
    status: "ok",
    count: succeeded.length,
    seed_accounts_path: accountsFile ?? null,
    accounts: succeeded,
  })
}

function readProvisionBatchSpecs(file: string): ProvisionBatchAccountSpec[] {
  const parsed = readJsonFile(file)
  const rawSpecs = Array.isArray(parsed)
    ? parsed
    : parsed && typeof parsed === "object" && Array.isArray((parsed as Record<string, unknown>).accounts)
      ? (parsed as Record<string, unknown>).accounts
      : null
  if (!Array.isArray(rawSpecs)) {
    throw new Error("provision-batch file must be a JSON array or an object with an accounts array")
  }
  return rawSpecs.map((item, index) => {
    if (!item || typeof item !== "object" || Array.isArray(item)) {
      throw new Error(`provision-batch account ${index + 1} must be an object`)
    }
    const record = item as Record<string, unknown>
    const handle = stringSpecField(record, "handle", index, true) as string
    const communities = Array.isArray(record.communities)
      ? record.communities.map((value) => {
        if (typeof value !== "string" || !value.trim()) {
          throw new Error(`provision-batch account ${index + 1} communities must contain only non-empty strings`)
        }
        return value.trim()
      })
      : []
    return {
      alias: stringSpecField(record, "alias", index),
      avatar_ref: stringSpecField(record, "avatar_ref", index),
      bio: stringSpecField(record, "bio", index),
      communities,
      cover_ref: stringSpecField(record, "cover_ref", index),
      display_name: stringSpecField(record, "display_name", index),
      handle,
    }
  })
}

function stringSpecField(
  record: Record<string, unknown>,
  field: string,
  index: number,
  required = false,
): string | null {
  const value = record[field]
  if (value == null) {
    if (required) {
      throw new Error(`provision-batch account ${index + 1} missing required ${field}`)
    }
    return null
  }
  if (typeof value !== "string" || !value.trim()) {
    throw new Error(`provision-batch account ${index + 1} ${field} must be a non-empty string`)
  }
  return value.trim()
}

function deriveSeedAccountAlias(handle: string): string {
  return handle.trim().toLowerCase().replace(/\.pirate$/, "")
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
