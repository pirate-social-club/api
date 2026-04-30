import {
  apiRoutes,
  type Community,
  type CommunityCreateAcceptedResponse,
  type CreateCommunityRequest,
  type Job,
} from "@pirate/api-contracts"
import { existsSync, readdirSync, readFileSync } from "node:fs"
import { basename, join, resolve } from "node:path"
import { getFlag, hasFlag } from "../args.js"
import { readJsonFile, readJsonObject, stringField } from "../command-utils.js"
import { readSeedAccounts } from "../config.js"
import { apiRequest, PirateHttpError } from "../http.js"
import { exitWithUsage, printJson } from "../output.js"
import { buildSeedPostBodyFromManifest } from "../seed-post-body.js"
import { apiAuthHeadersForSession, requireStoredSession } from "../session.js"
import type { ParsedArgs } from "../types.js"
import { waitForCommunityJob } from "./community-jobs.js"
import { normalizeReferenceLinksPayload, parseRulesFile } from "./community-settings.js"

export async function applyCommunityManifest(rest: string[], args: ParsedArgs): Promise<void> {
  const folder = rest[0]
  if (!folder) {
    exitWithUsage("Usage: pirate community apply <folder> [--community-id <id>] [--dry-run]")
  }
  const resolvedFolder = resolve(folder)
  if (!existsSync(resolvedFolder)) {
    throw new Error(`Folder not found: ${resolvedFolder}`)
  }

  const session = requireStoredSession()
  const communityIdOverride = getFlag(args, "community-id")
  const dryRun = hasFlag(args, "dry-run")

  const manifestPath = join(resolvedFolder, "community.yaml")
  const plan = existsSync(manifestPath)
    ? buildManifestPlan(resolvedFolder, manifestPath, communityIdOverride)
    : buildConventionalFolderPlan(resolvedFolder, communityIdOverride)

  if (dryRun) {
    printJson({
      community_id: plan.communityId ?? "unresolved",
      lookup_identifier: plan.lookupIdentifier,
      create: plan.create,
      plan: plan.steps,
    })
    return
  }

  const results: Array<{ step: string; status: string; detail?: unknown }> = []
  let failed = false

  const target = await resolveManifestCommunityTarget(session, plan)
  const targetCommunityId = target.communityId
  if (target.created) {
    results.push({
      step: "create",
      status: "ok",
      detail: {
        community: target.created.community,
        job: target.job ?? target.created.job,
      },
    })
  }

  const context: ManifestExecutionContext = {
    postAliases: new Map(),
    commentAliases: new Map(),
  }

  for (const step of plan.steps) {
    try {
      const result = await executeManifestStep(session, targetCommunityId, step, context)
      results.push({ step: step.kind, status: "ok", detail: result })
    } catch (error) {
      results.push({ step: step.kind, status: "failed", detail: error instanceof Error ? error.message : String(error) })
      failed = true
      break
    }
  }

  printJson({ community_id: targetCommunityId, results })
  if (failed) {
    process.exitCode = 1
  }
}

type SettingManifestStep = {
  kind: "update" | "gates" | "rules" | "links" | "labels" | "safety" | "donation-policy"
  body: unknown
  method: "POST"
  pathSuffix: string
}

type NamespaceManifestStep = {
  kind: "namespace"
  namespaceVerificationId: string
}

type ActorManifestStep = {
  kind: "join" | "follow"
  requiresAdmin: true
  asUserId: string
  body?: unknown
}

type ProfileUpdateManifestStep = {
  kind: "profile-update"
  requiresAdmin: true
  asUserId: string
  body: unknown
}

type SeedPostManifestStep = {
  kind: "seed-post"
  requiresAdmin: true
  asUserId: string
  alias: string | null
  body: unknown
}

type SeedCommentManifestStep = {
  kind: "seed-comment"
  requiresAdmin: true
  asUserId: string
  alias: string | null
  postId: string | null
  postAlias: string | null
  body: unknown
}

type VoteManifestStep = {
  kind: "post-vote" | "comment-vote"
  requiresAdmin: true
  asUserId: string
  targetId: string | null
  postAlias: string | null
  commentAlias: string | null
  value: -1 | 1
}

type ManifestStep =
  | NamespaceManifestStep
  | SettingManifestStep
  | ActorManifestStep
  | ProfileUpdateManifestStep
  | SeedPostManifestStep
  | SeedCommentManifestStep
  | VoteManifestStep

type ManifestPlan = {
  communityId: string | null
  lookupIdentifier: string | null
  create: ManifestCreateInput | null
  steps: ManifestStep[]
}

type ManifestExecutionContext = {
  postAliases: Map<string, string>
  commentAliases: Map<string, string>
}

type ManifestCreateInput = {
  displayName: string
  description: string | null
  namespaceVerificationId: string
  membershipMode: "open" | "request" | "gated"
  governanceMode: "centralized"
  defaultAgeGatePolicy: "none" | "18_plus"
  allowAnonymousIdentity: boolean
  humanVerificationLane: "self" | "very" | null
  agentPostingPolicy: "disallow" | "review" | "allow_with_disclosure" | "allow" | null
  agentPostingScope: "replies_only" | "top_level_and_replies" | null
  agentDailyPostCap: number | null
  agentDailyReplyCap: number | null
  acceptedAgentOwnershipProviders: Array<"self_agent_id" | "clawkey"> | null
}

const MANIFEST_FIELDS = new Set([
  "community_id",
  "route_slug",
  "namespace",
  "display_name",
  "description",
  "description_file",
  "namespace_verification_id",
  "membership_mode",
  "governance_mode",
  "default_age_gate_policy",
  "allow_anonymous_identity",
  "human_verification_lane",
  "agent_posting_policy",
  "agent_posting_scope",
  "agent_daily_post_cap",
  "agent_daily_reply_cap",
  "accepted_agent_ownership_providers",
  "gates_file",
  "rules_file",
  "reference_links_file",
  "labels_file",
  "safety_file",
  "donation_policy_file",
  "seed_accounts_file",
  "profile_updates_file",
  "joins_file",
  "follows_file",
  "seed_posts_file",
  "seed_comments_file",
  "post_votes_file",
  "comment_votes_file",
])

const CONVENTIONAL_FILES = new Map<string, string>([
  ["description_file", "description.txt"],
  ["rules_file", "rules.txt"],
  ["gates_file", "gates.json"],
  ["reference_links_file", "links.json"],
  ["labels_file", "labels.json"],
  ["safety_file", "safety.json"],
  ["donation_policy_file", "donation.json"],
  ["seed_accounts_file", "seed-accounts.json"],
  ["profile_updates_file", "profile-updates.json"],
  ["joins_file", "joins.json"],
  ["follows_file", "follows.json"],
  ["seed_posts_file", "seed-posts.json"],
  ["seed_comments_file", "seed-comments.json"],
  ["post_votes_file", "post-votes.json"],
  ["comment_votes_file", "comment-votes.json"],
])

const CONVENTIONAL_METADATA_FILES = new Set(["name.txt", "namespace-verification-id.txt"])

export function buildManifestPlan(folder: string, manifestPath: string, communityIdOverride: string | null): ManifestPlan {
  const rawManifest = readFileSync(manifestPath, "utf8")
  return buildManifestPlanFromObject(folder, parseSimpleYaml(rawManifest), communityIdOverride, true)
}

function buildManifestPlanFromObject(
  folder: string,
  manifest: Record<string, unknown>,
  communityIdOverride: string | null,
  requireCompleteCreateMetadata: boolean,
): ManifestPlan {
  validateManifestFields(manifest)
  const steps: ManifestStep[] = []
  const seedPostAliases = new Set<string>()
  const seedCommentAliases = new Set<string>()
  const seedPostIdempotencyKeys = new Set<string>()
  const seedCommentIdempotencyKeys = new Set<string>()
  const accountsFile = manifest["seed_accounts_file"] as string | undefined
  const seedAccounts = accountsFile
    ? readSeedAccounts(resolveRequiredManifestFile(folder, accountsFile))
    : readSeedAccounts()

  const descriptionFile = manifest["description_file"] as string | undefined
  const descriptionText = descriptionFile
    ? readFileSync(resolveRequiredManifestFile(folder, descriptionFile), "utf8")
    : manifestStringField(manifest, "description")
  const namespaceVerificationId = manifestStringField(manifest, "namespace_verification_id")
  if (namespaceVerificationId) {
    steps.push({ kind: "namespace", namespaceVerificationId })
  }

  const updateBody: Record<string, unknown> = {}
  const displayName = manifestStringField(manifest, "display_name")
  if (displayName) {
    updateBody.display_name = displayName
  }
  if (descriptionText) {
    updateBody.description = descriptionText
  }
  if ("human_verification_lane" in manifest) {
    updateBody.human_verification_lane = manifestNullableEnumField(manifest, "human_verification_lane", ["self", "very"])
  }
  if ("agent_posting_policy" in manifest) {
    updateBody.agent_posting_policy = manifestNullableEnumField(manifest, "agent_posting_policy", ["disallow", "review", "allow_with_disclosure", "allow"])
  }
  if ("agent_posting_scope" in manifest) {
    updateBody.agent_posting_scope = manifestNullableEnumField(manifest, "agent_posting_scope", ["replies_only", "top_level_and_replies"])
  }
  if ("agent_daily_post_cap" in manifest) {
    updateBody.agent_daily_post_cap = manifestNullableIntField(manifest, "agent_daily_post_cap")
  }
  if ("agent_daily_reply_cap" in manifest) {
    updateBody.agent_daily_reply_cap = manifestNullableIntField(manifest, "agent_daily_reply_cap")
  }
  if ("accepted_agent_ownership_providers" in manifest) {
    updateBody.accepted_agent_ownership_providers = parseAcceptedAgentOwnershipProviders(manifest)
  }
  if (Object.keys(updateBody).length > 0) {
    steps.push({ kind: "update", body: updateBody, method: "POST", pathSuffix: "" })
  }

  const gatesFile = manifest["gates_file"] as string | undefined
  if (gatesFile) {
    const gatesPath = resolveRequiredManifestFile(folder, gatesFile)
    steps.push({ kind: "gates", body: readJsonFile(gatesPath), method: "POST", pathSuffix: "gates" })
  }

  const rulesFile = manifest["rules_file"] as string | undefined
  if (rulesFile) {
    const rulesPath = resolveRequiredManifestFile(folder, rulesFile)
    steps.push({ kind: "rules", body: parseRulesFile(rulesPath), method: "POST", pathSuffix: "rules" })
  }

  const linksFile = manifest["reference_links_file"] as string | undefined
  if (linksFile) {
    const linksPath = resolveRequiredManifestFile(folder, linksFile)
    steps.push({ kind: "links", body: normalizeReferenceLinksPayload(readJsonFile(linksPath)), method: "POST", pathSuffix: "reference-links" })
  }

  const labelsFile = manifest["labels_file"] as string | undefined
  if (labelsFile) {
    const labelsPath = resolveRequiredManifestFile(folder, labelsFile)
    steps.push({ kind: "labels", body: readJsonFile(labelsPath), method: "POST", pathSuffix: "labels" })
  }

  const safetyFile = manifest["safety_file"] as string | undefined
  if (safetyFile) {
    const safetyPath = resolveRequiredManifestFile(folder, safetyFile)
    steps.push({ kind: "safety", body: readJsonFile(safetyPath), method: "POST", pathSuffix: "safety" })
  }

  const donationPolicyFile = manifest["donation_policy_file"] as string | undefined
  if (donationPolicyFile) {
    const donationPath = resolveRequiredManifestFile(folder, donationPolicyFile)
    steps.push({ kind: "donation-policy", body: readJsonFile(donationPath), method: "POST", pathSuffix: "donation-policy" })
  }

  const profileUpdatesFile = manifest["profile_updates_file"] as string | undefined
  if (profileUpdatesFile) {
    for (const item of readManifestArray(resolveRequiredManifestFile(folder, profileUpdatesFile), "profile_updates")) {
      steps.push({
        kind: "profile-update",
        requiresAdmin: true,
        asUserId: resolveManifestActorUserId(item, seedAccounts),
        body: buildProfileUpdateManifestBody(folder, item),
      })
    }
  }

  const joinsFile = manifest["joins_file"] as string | undefined
  if (joinsFile) {
    for (const item of readManifestArray(resolveRequiredManifestFile(folder, joinsFile), "joins")) {
      steps.push({
        kind: "join",
        requiresAdmin: true,
        asUserId: resolveManifestActorUserId(item, seedAccounts),
        body: { note: manifestStringField(item, "note") },
      })
    }
  }

  const followsFile = manifest["follows_file"] as string | undefined
  if (followsFile) {
    for (const item of readManifestArray(resolveRequiredManifestFile(folder, followsFile), "follows")) {
      steps.push({
        kind: "follow",
        requiresAdmin: true,
        asUserId: resolveManifestActorUserId(item, seedAccounts),
      })
    }
  }

  const seedPostsFile = manifest["seed_posts_file"] as string | undefined
  if (seedPostsFile) {
    for (const item of readManifestArray(resolveRequiredManifestFile(folder, seedPostsFile), "seed_posts")) {
      const alias = manifestStringField(item, "alias")
      const body = buildSeedPostManifestBody(folder, item)
      trackUnique(seedPostIdempotencyKeys, String(body.idempotency_key), "seed post idempotency_key")
      if (alias) {
        trackUnique(seedPostAliases, alias, "seed post alias")
      }
      steps.push({
        kind: "seed-post",
        requiresAdmin: true,
        asUserId: resolveManifestActorUserId(item, seedAccounts),
        alias,
        body,
      })
    }
  }

  const seedCommentsFile = manifest["seed_comments_file"] as string | undefined
  if (seedCommentsFile) {
    for (const item of readManifestArray(resolveRequiredManifestFile(folder, seedCommentsFile), "seed_comments")) {
      const alias = manifestStringField(item, "alias")
      const postAlias = manifestStringField(item, "post_alias")
      if (postAlias && !seedPostAliases.has(postAlias)) {
        throw new Error(`Seed comment references unknown post_alias ${postAlias}`)
      }
      const body = buildSeedCommentManifestBody(folder, item)
      trackUnique(seedCommentIdempotencyKeys, String(body.idempotency_key), "seed comment idempotency_key")
      if (alias) {
        trackUnique(seedCommentAliases, alias, "seed comment alias")
      }
      steps.push({
        kind: "seed-comment",
        requiresAdmin: true,
        asUserId: resolveManifestActorUserId(item, seedAccounts),
        alias,
        postId: manifestStringField(item, "post_id"),
        postAlias,
        body,
      })
    }
  }

  const postVotesFile = manifest["post_votes_file"] as string | undefined
  if (postVotesFile) {
    for (const item of readManifestArray(resolveRequiredManifestFile(folder, postVotesFile), "post_votes")) {
      const postAlias = manifestStringField(item, "post_alias")
      if (postAlias && !seedPostAliases.has(postAlias)) {
        throw new Error(`Post vote references unknown post_alias ${postAlias}`)
      }
      steps.push({
        kind: "post-vote",
        requiresAdmin: true,
        asUserId: resolveManifestActorUserId(item, seedAccounts),
        targetId: manifestStringField(item, "post_id"),
        postAlias,
        commentAlias: null,
        value: voteValueField(item, "value"),
      })
    }
  }

  const commentVotesFile = manifest["comment_votes_file"] as string | undefined
  if (commentVotesFile) {
    for (const item of readManifestArray(resolveRequiredManifestFile(folder, commentVotesFile), "comment_votes")) {
      const targetId = manifestStringField(item, "comment_id")
      const commentAlias = manifestStringField(item, "comment_alias")
      if (!targetId && !commentAlias) {
        throw new Error("Comment vote manifest item requires comment_id or comment_alias")
      }
      if (commentAlias && !seedCommentAliases.has(commentAlias)) {
        throw new Error(`Comment vote references unknown comment_alias ${commentAlias}`)
      }
      steps.push({
        kind: "comment-vote",
        requiresAdmin: true,
        asUserId: resolveManifestActorUserId(item, seedAccounts),
        targetId,
        postAlias: null,
        commentAlias,
        value: voteValueField(item, "value"),
      })
    }
  }

  const communityId = communityIdOverride ?? manifestStringField(manifest, "community_id")
  const lookupIdentifier = communityId
    ?? manifestStringField(manifest, "route_slug")
    ?? manifestStringField(manifest, "namespace")
    ?? manifestFolderLookupIdentifier(folder)
  const create = communityId
    ? null
    : buildManifestCreateInput(manifest, descriptionText, requireCompleteCreateMetadata)

  return { communityId, lookupIdentifier, create, steps }
}

export function buildConventionalFolderPlan(folder: string, communityIdOverride: string | null): ManifestPlan {
  validateConventionalFolderFiles(folder)
  const manifest: Record<string, unknown> = {}
  const folderLookup = manifestFolderLookupIdentifier(folder)
  if (folderLookup) {
    manifest.route_slug = folderLookup
  }

  const namePath = join(folder, "name.txt")
  if (existsSync(namePath)) {
    manifest.display_name = readFileSync(namePath, "utf8").trim()
  }
  const namespaceVerificationPath = join(folder, "namespace-verification-id.txt")
  if (existsSync(namespaceVerificationPath)) {
    manifest.namespace_verification_id = readFileSync(namespaceVerificationPath, "utf8").trim()
  }

  for (const [field, fileName] of CONVENTIONAL_FILES) {
    if (existsSync(join(folder, fileName))) {
      manifest[field] = fileName
    }
  }

  return buildManifestPlanFromObject(folder, manifest, communityIdOverride, false)
}

async function executeManifestStep(
  session: StoredSession,
  communityId: string,
  step: ManifestStep,
  context: ManifestExecutionContext,
): Promise<unknown> {
  if (session.mode !== "admin" && "requiresAdmin" in step && step.requiresAdmin) {
    throw new Error(`${step.kind} manifest steps require an admin session`)
  }

  switch (step.kind) {
    case "namespace":
      assertExecutableNamespaceVerificationId(step.namespaceVerificationId)
      return apiRequest<Community>({
        baseUrl: session.baseUrl,
        path: `${apiRoutes.community(communityId)}/namespace`,
        method: "POST",
        ...apiAuthHeadersForSession(session),
        body: { namespace_verification: step.namespaceVerificationId },
      })
    case "update":
      return apiRequest<Community>({
        baseUrl: session.baseUrl,
        path: apiRoutes.community(communityId),
        method: "POST",
        ...apiAuthHeadersForSession(session),
        body: step.body,
      })
    case "rules":
      return apiRequest<Community>({
        baseUrl: session.baseUrl,
        path: `${apiRoutes.community(communityId)}/rules`,
        method: "POST",
        ...apiAuthHeadersForSession(session),
        body: step.body,
      })
    case "gates":
    case "links":
    case "labels":
    case "safety":
    case "donation-policy":
      return apiRequest<Community>({
        baseUrl: session.baseUrl,
        path: `${apiRoutes.community(communityId)}/${step.pathSuffix}`,
        method: step.method,
        ...apiAuthHeadersForSession(session),
        body: step.body,
      })
    case "join":
      return apiRequest<unknown>({
        baseUrl: session.baseUrl,
        path: apiRoutes.communityJoin(communityId),
        method: "POST",
        ...apiAuthHeadersForSession(session, step.asUserId),
        body: step.body ?? {},
      })
    case "follow":
      return apiRequest<unknown>({
        baseUrl: session.baseUrl,
        path: apiRoutes.communityFollow(communityId),
        method: "POST",
        ...apiAuthHeadersForSession(session, step.asUserId),
      })
    case "profile-update":
      return apiRequest<unknown>({
        baseUrl: session.baseUrl,
        path: apiRoutes.profilesMe,
        method: "POST",
        ...apiAuthHeadersForSession(session, step.asUserId),
        body: step.body,
      })
    case "seed-post": {
      const result = await apiRequest<{ post_id?: string }>({
        baseUrl: session.baseUrl,
        path: apiRoutes.communityPosts(communityId),
        method: "POST",
        ...apiAuthHeadersForSession(session, step.asUserId),
        adminOperationClass: "launch_seed",
        body: step.body,
      })
      if (step.alias) {
        const postId = typeof result.post_id === "string" ? result.post_id : null
        if (!postId) {
          throw new Error(`Seed post alias ${step.alias} did not resolve to a post_id`)
        }
        context.postAliases.set(step.alias, postId)
      }
      return result
    }
    case "seed-comment": {
      const postId = resolveManifestPostTarget(step, context)
      const result = await apiRequest<{ comment_id?: string }>({
        baseUrl: session.baseUrl,
        path: apiRoutes.communityPostComments(communityId, postId),
        method: "POST",
        ...apiAuthHeadersForSession(session, step.asUserId),
        adminOperationClass: "launch_seed",
        body: step.body,
      })
      if (step.alias) {
        const commentId = typeof result.comment_id === "string" ? result.comment_id : null
        if (!commentId) {
          throw new Error(`Seed comment alias ${step.alias} did not resolve to a comment_id`)
        }
        context.commentAliases.set(step.alias, commentId)
      }
      return result
    }
    case "post-vote": {
      const postId = step.targetId ?? (step.postAlias ? context.postAliases.get(step.postAlias) ?? null : null)
      if (!postId) {
        throw new Error("Post vote requires post_id or a seed post_alias created earlier in the manifest")
      }
      return apiRequest<unknown>({
        baseUrl: session.baseUrl,
        path: apiRoutes.postVote(postId),
        method: "POST",
        ...apiAuthHeadersForSession(session, step.asUserId),
        body: { value: step.value },
      })
    }
    case "comment-vote": {
      const commentId = step.targetId ?? (step.commentAlias ? context.commentAliases.get(step.commentAlias) ?? null : null)
      if (!commentId) {
        throw new Error("Comment vote requires comment_id or a seed comment_alias created earlier in the manifest")
      }
      return apiRequest<unknown>({
        baseUrl: session.baseUrl,
        path: apiRoutes.commentVote(commentId),
        method: "POST",
        ...apiAuthHeadersForSession(session, step.asUserId),
        body: { value: step.value },
      })
    }
    default: {
      const _exhaustive: never = step
      throw new Error(`Unknown manifest step kind: ${(_exhaustive as { kind?: string }).kind ?? "unknown"}`)
    }
  }
}

export function assertExecutableNamespaceVerificationId(value: string): void {
  if (value.includes("REPLACE_WITH")) {
    throw new Error("namespace_verification_id is still a placeholder; replace it with the real nv_* id before apply")
  }
}

async function resolveManifestCommunityTarget(
  session: StoredSession,
  plan: ManifestPlan,
): Promise<{ communityId: string; created: CommunityCreateAcceptedResponse | null; job: Job | null }> {
  if (plan.lookupIdentifier) {
    try {
      const community = await apiRequest<Community>({
        baseUrl: session.baseUrl,
        path: apiRoutes.community(plan.lookupIdentifier),
        ...apiAuthHeadersForSession(session),
      })
      return { communityId: community.id, created: null, job: null }
    } catch (error) {
      if (!(error instanceof PirateHttpError) || error.status !== 404) {
        throw error
      }
      if (plan.communityId) {
        throw error
      }
    }
  }

  if (!plan.create) {
    throw new Error("Community ID not resolved. Use --community-id, community_id, route_slug/namespace for lookup, or add display_name and namespace_verification_id for create.")
  }

  const created = await createCommunityFromManifest(session, plan.create)
  const job = await waitForCommunityJob(session, created.job.id)
  return { communityId: created.community.id, created, job }
}

async function createCommunityFromManifest(
  session: StoredSession,
  input: ManifestCreateInput,
): Promise<CommunityCreateAcceptedResponse> {
  const body: CreateCommunityRequest = {
    display_name: input.displayName,
    description: input.description,
    membership_mode: input.membershipMode,
    governance_mode: input.governanceMode,
    default_age_gate_policy: input.defaultAgeGatePolicy,
    allow_anonymous_identity: input.allowAnonymousIdentity,
    human_verification_lane: input.humanVerificationLane,
    agent_posting_policy: input.agentPostingPolicy,
    agent_posting_scope: input.agentPostingScope,
    agent_daily_post_cap: input.agentDailyPostCap,
    agent_daily_reply_cap: input.agentDailyReplyCap,
    accepted_agent_ownership_providers: input.acceptedAgentOwnershipProviders,
    handle_policy: {
      policy_template: "standard",
    },
    namespace: {
      namespace_verification: input.namespaceVerificationId,
    },
  }

  return apiRequest<CommunityCreateAcceptedResponse>({
    baseUrl: session.baseUrl,
    path: apiRoutes.communities,
    method: "POST",
    ...apiAuthHeadersForSession(session),
    body,
  })
}

export function parseSimpleYaml(text: string): Record<string, unknown> {
  const result: Record<string, unknown> = {}
  for (const [index, line] of text.split("\n").entries()) {
    const trimmed = line.trim()
    if (!trimmed || trimmed.startsWith("#")) continue
    if (line.startsWith(" ") || line.startsWith("\t") || trimmed.startsWith("-") || trimmed.endsWith("|") || trimmed.endsWith(">")) {
      throw new Error(`Unsupported YAML syntax on line ${index + 1}; community.yaml only supports flat key: value entries`)
    }
    const colonIndex = trimmed.indexOf(":")
    if (colonIndex < 1) continue
    const key = trimmed.slice(0, colonIndex).trim()
    let value: unknown = trimmed.slice(colonIndex + 1).trim()
    if ((value as string).startsWith('"') && (value as string).endsWith('"')) {
      value = (value as string).slice(1, -1)
    }
    if (value === "") value = null
    result[key] = value
  }
  return result
}

function validateManifestFields(manifest: Record<string, unknown>): void {
  for (const key of Object.keys(manifest)) {
    if (!MANIFEST_FIELDS.has(key)) {
      throw new Error(`Unknown community.yaml field: ${key}`)
    }
  }
}

function validateConventionalFolderFiles(folder: string): void {
  const allowed = new Set([
    "community.yaml",
    ...CONVENTIONAL_METADATA_FILES,
    ...CONVENTIONAL_FILES.values(),
  ])
  for (const entry of readdirSync(folder, { withFileTypes: true })) {
    if (!entry.isFile()) continue
    if (entry.name.startsWith(".")) continue
    if (!allowed.has(entry.name)) {
      throw new Error(`Unknown community folder file: ${entry.name}`)
    }
  }
}

function trackUnique(values: Set<string>, value: string, label: string): void {
  if (values.has(value)) {
    throw new Error(`Duplicate ${label}: ${value}`)
  }
  values.add(value)
}

function manifestFolderLookupIdentifier(folder: string): string | null {
  const name = basename(folder)
  return name.startsWith("@") ? name : null
}

function buildManifestCreateInput(
  manifest: Record<string, unknown>,
  description: string | null,
  requireCompleteMetadata: boolean,
): ManifestCreateInput | null {
  const namespaceVerificationId = manifestStringField(manifest, "namespace_verification_id")
  const displayName = manifestStringField(manifest, "display_name")
  if (!namespaceVerificationId && !displayName) {
    return null
  }
  if (!requireCompleteMetadata && !namespaceVerificationId) {
    return null
  }
  if (!requireCompleteMetadata && !displayName) {
    return null
  }
  if (!namespaceVerificationId) {
    return null
  }
  if (!displayName) {
    throw new Error("Manifest create requires both display_name and namespace_verification_id")
  }
  const governanceMode = manifestStringField(manifest, "governance_mode") ?? "centralized"
  if (governanceMode !== "centralized") {
    throw new Error("Manifest create currently supports governance_mode: centralized")
  }

  return {
    displayName,
    description,
    namespaceVerificationId,
    membershipMode: manifestEnumField(manifest, "membership_mode", ["open", "request", "gated"], "open"),
    governanceMode,
    defaultAgeGatePolicy: manifestEnumField(manifest, "default_age_gate_policy", ["none", "18_plus"], "none"),
    allowAnonymousIdentity: manifestBooleanField(manifest, "allow_anonymous_identity", false),
    humanVerificationLane: manifestNullableEnumField(manifest, "human_verification_lane", ["self", "very"]),
    agentPostingPolicy: manifestNullableEnumField(manifest, "agent_posting_policy", ["disallow", "review", "allow_with_disclosure", "allow"]),
    agentPostingScope: manifestNullableEnumField(manifest, "agent_posting_scope", ["replies_only", "top_level_and_replies"]),
    agentDailyPostCap: manifestNullableIntField(manifest, "agent_daily_post_cap"),
    agentDailyReplyCap: manifestNullableIntField(manifest, "agent_daily_reply_cap"),
    acceptedAgentOwnershipProviders: parseAcceptedAgentOwnershipProviders(manifest),
  }
}

function manifestEnumField<const T extends string>(
  item: Record<string, unknown>,
  field: string,
  allowed: readonly T[],
  fallback: T,
): T {
  const value = manifestStringField(item, field)
  if (!value) return fallback
  if ((allowed as readonly string[]).includes(value)) return value as T
  throw new Error(`${field} must be one of ${allowed.join(", ")}`)
}

function manifestNullableEnumField<const T extends string>(
  item: Record<string, unknown>,
  field: string,
  allowed: readonly T[],
): T | null {
  const value = manifestStringField(item, field)
  if (!value) return null
  if ((allowed as readonly string[]).includes(value)) return value as T
  throw new Error(`${field} must be one of ${allowed.join(", ")}`)
}

function manifestBooleanField(item: Record<string, unknown>, field: string, fallback: boolean): boolean {
  const value = item[field]
  if (value == null) return fallback
  if (value === true || value === "true") return true
  if (value === false || value === "false") return false
  throw new Error(`${field} must be true or false`)
}

function manifestNullableIntField(item: Record<string, unknown>, field: string): number | null {
  const value = item[field]
  if (value == null) return null
  const parsed = typeof value === "number" ? value : parseInt(String(value), 10)
  if (!Number.isInteger(parsed) || parsed < 1) {
    throw new Error(`${field} must be a positive integer`)
  }
  return parsed
}

function parseAcceptedAgentOwnershipProviders(item: Record<string, unknown>): Array<"self_agent_id" | "clawkey"> | null {
  const raw = item.accepted_agent_ownership_providers
  if (raw == null) return null
  if (typeof raw === "string") {
    const values = raw.split(",").map((v) => v.trim()).filter(Boolean)
    return validateAgentOwnershipProviders(values)
  }
  if (Array.isArray(raw)) {
    return validateAgentOwnershipProviders(raw.map(String))
  }
  throw new Error("accepted_agent_ownership_providers must be a comma-separated string or array")
}

function validateAgentOwnershipProviders(values: string[]): Array<"self_agent_id" | "clawkey"> {
  const allowed = new Set(["self_agent_id", "clawkey"])
  for (const v of values) {
    if (!allowed.has(v)) {
      throw new Error(`accepted_agent_ownership_providers contains invalid value: ${v}`)
    }
  }
  return values as Array<"self_agent_id" | "clawkey">
}

function resolveRequiredManifestFile(folder: string, fileName: string): string {
  const resolved = join(folder, fileName)
  if (!existsSync(resolved)) {
    throw new Error(`Manifest references missing file: ${resolved}`)
  }
  return resolved
}

function readManifestArray(filePath: string, key: string): Array<Record<string, unknown>> {
  const parsed = readJsonFile(filePath)
  const value = Array.isArray(parsed)
    ? parsed
    : parsed && typeof parsed === "object" && Array.isArray((parsed as Record<string, unknown>)[key])
      ? (parsed as Record<string, unknown>)[key]
      : null
  if (!Array.isArray(value)) {
    throw new Error(`${filePath} must be a JSON array or an object with a ${key} array`)
  }
  return value.map((item, index) => {
    if (!item || typeof item !== "object" || Array.isArray(item)) {
      throw new Error(`${filePath} item ${index + 1} must be an object`)
    }
    return item as Record<string, unknown>
  })
}

function resolveManifestActorUserId(item: Record<string, unknown>, seedAccounts: Record<string, string>): string {
  const explicit = manifestStringField(item, "as_user_id")
  if (explicit) {
    return explicit
  }
  const alias = manifestStringField(item, "as")
  if (!alias) {
    throw new Error("Manifest seed operation requires as or as_user_id")
  }
  const resolved = seedAccounts[alias]
  if (!resolved) {
    throw new Error(`Unknown seed account alias ${alias}`)
  }
  return resolved
}

function buildProfileUpdateManifestBody(folder: string, item: Record<string, unknown>): Record<string, unknown> {
  const file = manifestStringField(item, "file")
  const body = file ? readJsonObject(resolveRequiredManifestFile(folder, file)) : {}
  const displayName = manifestStringField(item, "display_name")
  const bio = manifestStringField(item, "bio") ?? readManifestTextField(folder, item, "bio_file")
  const preferredLocale = manifestStringField(item, "preferred_locale")
  const avatarRef = manifestStringField(item, "avatar_ref")
  const avatarSource = manifestStringField(item, "avatar_source")
  if (displayName != null) body.display_name = displayName
  if (bio != null) body.bio = bio
  if (preferredLocale != null) body.preferred_locale = preferredLocale
  if (avatarRef != null) body.avatar_ref = avatarRef
  if (avatarSource != null) body.avatar_source = avatarSource
  if (typeof item.display_verified_nationality_badge === "boolean") {
    body.display_verified_nationality_badge = item.display_verified_nationality_badge
  }
  if (Object.keys(body).length === 0) {
    throw new Error("Profile update manifest item must include at least one profile field")
  }
  return body
}

function buildSeedPostManifestBody(folder: string, item: Record<string, unknown>): Record<string, unknown> {
  return buildSeedPostBodyFromManifest(item, (field) => readManifestTextField(folder, item, field))
}

function buildSeedCommentManifestBody(folder: string, item: Record<string, unknown>): Record<string, unknown> {
  const hasPostTarget = Boolean(manifestStringField(item, "post_id") ?? manifestStringField(item, "post_alias"))
  if (!hasPostTarget) {
    throw new Error("Seed comment manifest item requires post_id or post_alias")
  }
  const idempotencyKey = manifestStringField(item, "idempotency_key")
  if (!idempotencyKey) {
    throw new Error("Seed comment manifest item requires idempotency_key")
  }
  const body = manifestStringField(item, "body") ?? readManifestTextField(folder, item, "body_file")
  if (!body?.trim()) {
    throw new Error("Seed comment manifest item requires body or body_file")
  }
  return {
    idempotency_key: idempotencyKey,
    body,
    identity_mode: manifestStringField(item, "identity_mode") ?? "public",
  }
}

function readManifestTextField(folder: string, item: Record<string, unknown>, field: string): string | null {
  const file = manifestStringField(item, field)
  return file ? readFileSync(resolveRequiredManifestFile(folder, file), "utf8") : null
}

function manifestStringField(item: Record<string, unknown>, field: string): string | null {
  return stringField(item, field)
}

function voteValueField(item: Record<string, unknown>, field: string): -1 | 1 {
  const value = item[field]
  if (value === 1 || value === "1") return 1
  if (value === -1 || value === "-1") return -1
  throw new Error(`${field} must be 1 or -1`)
}

function resolveManifestPostTarget(step: SeedCommentManifestStep, context: ManifestExecutionContext): string {
  const postId = step.postId ?? (step.postAlias ? context.postAliases.get(step.postAlias) ?? null : null)
  if (!postId) {
    throw new Error("Seed comment requires post_id or a seed post_alias created earlier in the manifest")
  }
  return postId
}

type StoredSession = ReturnType<typeof requireStoredSession>
