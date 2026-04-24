import { readFile } from "node:fs/promises"
import { resolve } from "node:path"
import { SignJWT } from "jose"
import { readDevVarsFromCwd } from "./_lib/dev-vars"

type SeedMode = "local-smoke" | "dev-seed" | "staging-seed" | "prod-launch-seed"
type HttpMethod = "GET" | "POST" | "PUT" | "PATCH"

type ProfileSeed = {
  display_name?: string
  bio?: string | null
  avatar_ref?: string | null
  cover_ref?: string | null
  preferred_locale?: string | null
  desired_handle?: string
}

type SeedUser = {
  key: string
  subject?: string
  access_token_env?: string
  synthetic?: boolean
  verify_unique_human?: boolean
  verification_provider?: "self" | "very"
  profile?: ProfileSeed
}

type VoteSeed = { voter: string; value: -1 | 1 }
type CommentSeed = {
  key: string
  author: string
  body: string
  replies?: CommentSeed[]
  votes?: VoteSeed[]
}
type PostSeed = {
  key: string
  author: string
  body: Record<string, unknown>
  comments?: CommentSeed[]
  votes?: VoteSeed[]
}
type NamespaceSeed = {
  family: "hns" | "spaces"
  root_label: string
  namespace_verification_id?: string
  provenance?: string
}
type CommunitySeed = {
  key: string
  community_id?: string
  owner: string
  namespace?: NamespaceSeed
  create?: Record<string, unknown>
  members?: string[]
  followers?: string[]
  machine_access_policy?: Record<string, unknown>
  posts?: PostSeed[]
}
type SeedManifest = {
  name: string
  description?: string
  users: SeedUser[]
  communities: CommunitySeed[]
}
type SessionUser = SeedUser & { accessToken: string; userId: string }
type SeedContext = {
  apiUrl: string
  execute: boolean
  mode: SeedMode
  users: Map<string, SessionUser>
  communities: Map<string, string>
  posts: Map<string, string>
  comments: Map<string, string>
  report: string[]
  warnings: string[]
}

type ManifestStats = {
  users: number
  communities: number
  posts: number
  comments: number
  replies: number
  votes: number
}

const localDevVars = readDevVarsFromCwd()
const resolvedEnv: Record<string, string | undefined> = {
  ...localDevVars,
  ...process.env,
}

function readArg(name: string): string | null {
  const index = process.argv.indexOf(name)
  return index === -1 ? null : process.argv[index + 1] ?? null
}

function hasFlag(name: string): boolean {
  return process.argv.includes(name)
}

function record(value: unknown): value is Record<string, unknown> {
  return value != null && typeof value === "object" && !Array.isArray(value)
}

function str(value: unknown, label: string): string {
  if (typeof value !== "string" || !value.trim()) throw new Error(`${label} must be a non-empty string`)
  return value.trim()
}

function modeFromArg(value: string | null): SeedMode {
  if (value === "local-smoke" || value === "dev-seed" || value === "staging-seed" || value === "prod-launch-seed") return value
  throw new Error("--mode must be local-smoke, dev-seed, staging-seed, or prod-launch-seed")
}

function optionalString(value: unknown): string | undefined {
  return typeof value === "string" && value.trim() ? value.trim() : undefined
}

function stringArray(value: unknown, label: string): string[] {
  if (value == null) return []
  if (!Array.isArray(value)) throw new Error(`${label} must be an array`)
  return value.map((entry, index) => str(entry, `${label}[${index}]`))
}

function expandEnv(value: unknown): unknown {
  if (typeof value === "string") {
    return value.replace(/\$\{([A-Z0-9_]+)\}/gu, (_match, name: string) => envValue(name))
  }
  if (Array.isArray(value)) return value.map(expandEnv)
  if (!record(value)) return value
  return Object.fromEntries(Object.entries(value).map(([key, entry]) => [key, expandEnv(entry)]))
}

function collectMissingEnvRefs(value: unknown, path = "manifest"): string[] {
  const missing: string[] = []
  if (typeof value === "string") {
    for (const match of value.matchAll(/\$\{([A-Z0-9_]+)\}/gu)) {
      const name = match[1]!
      if (!envValue(name).trim()) missing.push(`${path}: ${name}`)
    }
    return missing
  }
  if (Array.isArray(value)) {
    value.forEach((entry, index) => missing.push(...collectMissingEnvRefs(entry, `${path}[${index}]`)))
    return missing
  }
  if (record(value)) {
    for (const [key, entry] of Object.entries(value)) {
      missing.push(...collectMissingEnvRefs(entry, `${path}.${key}`))
    }
  }
  return missing
}

function parseNamespace(value: unknown, label: string): NamespaceSeed | undefined {
  if (value == null) return undefined
  if (!record(value)) throw new Error(`${label} must be an object`)
  if (value.family !== "hns" && value.family !== "spaces") throw new Error(`${label}.family must be hns or spaces`)
  return {
    family: value.family,
    root_label: str(value.root_label, `${label}.root_label`),
    namespace_verification_id: optionalString(value.namespace_verification_id),
    provenance: optionalString(value.provenance),
  }
}

function parseProfile(value: unknown, label: string): ProfileSeed | undefined {
  if (value == null) return undefined
  if (!record(value)) throw new Error(`${label} must be an object`)
  return {
    display_name: optionalString(value.display_name),
    bio: value.bio === null ? null : optionalString(value.bio),
    avatar_ref: value.avatar_ref === null ? null : optionalString(value.avatar_ref),
    cover_ref: value.cover_ref === null ? null : optionalString(value.cover_ref),
    preferred_locale: value.preferred_locale === null ? null : optionalString(value.preferred_locale),
    desired_handle: optionalString(value.desired_handle),
  }
}

function parseVotes(value: unknown, label: string): VoteSeed[] {
  if (value == null) return []
  if (!Array.isArray(value)) throw new Error(`${label} must be an array`)
  return value.map((vote, index) => {
    if (!record(vote)) throw new Error(`${label}[${index}] must be an object`)
    if (vote.value !== -1 && vote.value !== 1) throw new Error(`${label}[${index}].value must be -1 or 1`)
    return { voter: str(vote.voter, `${label}[${index}].voter`), value: vote.value }
  })
}

function parseComments(value: unknown, label: string): CommentSeed[] {
  if (value == null) return []
  if (!Array.isArray(value)) throw new Error(`${label} must be an array`)
  return value.map((comment, index) => {
    if (!record(comment)) throw new Error(`${label}[${index}] must be an object`)
    return {
      key: str(comment.key, `${label}[${index}].key`),
      author: str(comment.author, `${label}[${index}].author`),
      body: str(comment.body, `${label}[${index}].body`),
      replies: parseComments(comment.replies, `${label}[${index}].replies`),
      votes: parseVotes(comment.votes, `${label}[${index}].votes`),
    }
  })
}

function parsePosts(value: unknown, label: string): PostSeed[] {
  if (value == null) return []
  if (!Array.isArray(value)) throw new Error(`${label} must be an array`)
  return value.map((post, index) => {
    if (!record(post)) throw new Error(`${label}[${index}] must be an object`)
    if (!record(post.body)) throw new Error(`${label}[${index}].body must be an object`)
    return {
      key: str(post.key, `${label}[${index}].key`),
      author: str(post.author, `${label}[${index}].author`),
      body: post.body,
      comments: parseComments(post.comments, `${label}[${index}].comments`),
      votes: parseVotes(post.votes, `${label}[${index}].votes`),
    }
  })
}

function parseManifest(raw: unknown): SeedManifest {
  const value = expandEnv(raw)
  if (!record(value) || !Array.isArray(value.users) || !Array.isArray(value.communities)) {
    throw new Error("Seed manifest requires users[] and communities[]")
  }
  return {
    name: str(value.name, "manifest.name"),
    description: optionalString(value.description),
    users: value.users.map((user, index) => {
      if (!record(user)) throw new Error(`users[${index}] must be an object`)
      return {
        key: str(user.key, `users[${index}].key`),
        subject: optionalString(user.subject),
        access_token_env: optionalString(user.access_token_env),
        synthetic: user.synthetic === true,
        verify_unique_human: user.verify_unique_human !== false,
        verification_provider: user.verification_provider === "self" || user.verification_provider === "very"
          ? user.verification_provider
          : undefined,
        profile: parseProfile(user.profile, `users[${index}].profile`),
      }
    }),
    communities: value.communities.map((community, index) => {
      if (!record(community)) throw new Error(`communities[${index}] must be an object`)
      return {
        key: str(community.key, `communities[${index}].key`),
        community_id: optionalString(community.community_id),
        owner: str(community.owner, `communities[${index}].owner`),
        namespace: parseNamespace(community.namespace, `communities[${index}].namespace`),
        create: record(community.create) ? community.create : undefined,
        members: stringArray(community.members, `communities[${index}].members`),
        followers: stringArray(community.followers, `communities[${index}].followers`),
        machine_access_policy: record(community.machine_access_policy) ? community.machine_access_policy : undefined,
        posts: parsePosts(community.posts, `communities[${index}].posts`),
      }
    }),
  }
}

function envValue(name: string): string {
  return resolvedEnv[name] || ""
}

function countCommentVotes(comments: CommentSeed[]): number {
  return comments.reduce((sum, comment) => sum + (comment.votes ?? []).length + countCommentVotes(comment.replies ?? []), 0)
}

function assertProductionGuardrails(manifest: SeedManifest): void {
  const synthetic = manifest.users.filter((user) => user.synthetic || user.subject)
  if (synthetic.length > 0) {
    throw new Error(`prod-launch-seed cannot use synthetic users or JWT subjects: ${synthetic.map((user) => user.key).join(", ")}`)
  }
  const missingTokens = manifest.users.filter((user) => !user.access_token_env)
  if (missingTokens.length > 0) {
    throw new Error(`prod-launch-seed users must use access_token_env: ${missingTokens.map((user) => user.key).join(", ")}`)
  }
  const votes = manifest.communities.reduce((sum, community) => {
    return sum + (community.posts ?? []).reduce((postSum, post) => (
      postSum + (post.votes ?? []).length + countCommentVotes(post.comments ?? [])
    ), 0)
  }, 0)
  if (votes > 0) throw new Error("prod-launch-seed cannot apply votes; keep production engagement organic")
}

function collectStats(manifest: SeedManifest): ManifestStats {
  let posts = 0
  let comments = 0
  let replies = 0
  let votes = 0

  for (const community of manifest.communities) {
    for (const post of community.posts ?? []) {
      posts += 1
      votes += (post.votes ?? []).length
      const nested = countCommentsAndReplies(post.comments ?? [], false)
      comments += nested.comments
      replies += nested.replies
      votes += nested.votes
    }
  }

  return {
    users: manifest.users.length,
    communities: manifest.communities.length,
    posts,
    comments,
    replies,
    votes,
  }
}

function countCommentsAndReplies(comments: CommentSeed[], nested: boolean): { comments: number; replies: number; votes: number } {
  return comments.reduce((sum, comment) => {
    const children = countCommentsAndReplies(comment.replies ?? [], true)
    return {
      comments: sum.comments + (nested ? 0 : 1) + children.comments,
      replies: sum.replies + (nested ? 1 : 0) + children.replies,
      votes: sum.votes + (comment.votes ?? []).length + children.votes,
    }
  }, { comments: 0, replies: 0, votes: 0 })
}

function assertUnique(keys: string[], label: string): void {
  const seen = new Set<string>()
  const duplicates = new Set<string>()
  for (const key of keys) {
    if (seen.has(key)) duplicates.add(key)
    seen.add(key)
  }
  if (duplicates.size > 0) {
    throw new Error(`${label} contains duplicate keys: ${[...duplicates].join(", ")}`)
  }
}

function validateManifest(input: {
  manifest: SeedManifest
  mode: SeedMode
  execute: boolean
  missingEnvRefs: string[]
}): string[] {
  const warnings: string[] = []
  const userKeys = new Set(input.manifest.users.map((user) => user.key))
  assertUnique(input.manifest.users.map((user) => user.key), "users")
  assertUnique(input.manifest.communities.map((community) => community.key), "communities")
  assertUnique(
    input.manifest.users.flatMap((user) => user.profile?.desired_handle ? [user.profile.desired_handle.toLowerCase()] : []),
    "profile desired handles",
  )

  const requireKnownUser = (key: string, label: string) => {
    if (!userKeys.has(key)) throw new Error(`${label} references unknown user ${key}`)
  }

  for (const community of input.manifest.communities) {
    requireKnownUser(community.owner, `community ${community.key}.owner`)
    if (!community.community_id && !community.create) {
      throw new Error(`community ${community.key} needs create payload or community_id`)
    }
    if ((input.mode === "dev-seed" || input.mode === "staging-seed" || input.mode === "prod-launch-seed") && !community.community_id) {
      warnings.push(`community ${community.key} has no community_id; re-executing this manifest can create duplicate communities`)
    }
    if (community.namespace?.provenance?.includes("imported") && !community.namespace.namespace_verification_id) {
      const message = `community ${community.key} imported namespace requires namespace_verification_id before execution`
      if (input.execute) throw new Error(message)
      warnings.push(message)
    }
    for (const key of community.members ?? []) requireKnownUser(key, `community ${community.key}.members`)
    for (const key of community.followers ?? []) requireKnownUser(key, `community ${community.key}.followers`)
    assertUnique((community.posts ?? []).map((post) => post.key), `community ${community.key}.posts`)
    for (const post of community.posts ?? []) {
      requireKnownUser(post.author, `post ${community.key}.${post.key}.author`)
      if (typeof post.body.idempotency_key !== "string" || !post.body.idempotency_key.trim()) {
        throw new Error(`post ${community.key}.${post.key} needs body.idempotency_key`)
      }
      for (const vote of post.votes ?? []) requireKnownUser(vote.voter, `post ${community.key}.${post.key}.votes`)
      validateComments({ comments: post.comments ?? [], userKeys, prefix: `${community.key}.${post.key}` })
    }
  }

  if (input.mode === "dev-seed" || input.mode === "staging-seed") {
    const syntheticVerifiedUsers = input.manifest.users.filter((user) => user.synthetic && user.verify_unique_human !== false)
    if (syntheticVerifiedUsers.some((user) => (user.verification_provider ?? "very") === "very")) {
      warnings.push(`${input.mode} synthetic verification uses Very widget-trust; confirm VERY_TRUST_LOCAL_WIDGET_COMPLETION is enabled before --execute`)
    }
    if (syntheticVerifiedUsers.some((user) => user.verification_provider === "self")) {
      warnings.push(`${input.mode} synthetic verification uses Self; confirm SELF_ENDPOINT or PIRATE_API_PUBLIC_ORIGIN is configured and completion proofs will verify before --execute`)
    }
  }

  if (input.missingEnvRefs.length > 0) {
    const message = `missing env placeholders: ${input.missingEnvRefs.join(", ")}`
    if (input.execute) throw new Error(message)
    warnings.push(message)
  }

  return warnings
}

function validateComments(input: {
  comments: CommentSeed[]
  userKeys: Set<string>
  prefix: string
}): void {
  assertUnique(input.comments.map((comment) => comment.key), `${input.prefix}.comments`)
  for (const comment of input.comments) {
    if (!input.userKeys.has(comment.author)) {
      throw new Error(`comment ${input.prefix}.${comment.key}.author references unknown user ${comment.author}`)
    }
    for (const vote of comment.votes ?? []) {
      if (!input.userKeys.has(vote.voter)) {
        throw new Error(`comment ${input.prefix}.${comment.key}.votes references unknown user ${vote.voter}`)
      }
    }
    validateComments({
      comments: comment.replies ?? [],
      userKeys: input.userKeys,
      prefix: `${input.prefix}.${comment.key}`,
    })
  }
}

async function mintJwt(subject: string): Promise<string> {
  const issuer = (envValue("AUTH_UPSTREAM_JWT_ISSUER") || envValue("JWT_BASED_AUTH_ISSUERS") || "pirate-dev").split(",")[0]!.trim()
  const audience = envValue("AUTH_UPSTREAM_JWT_AUDIENCE") || envValue("JWT_BASED_AUTH_AUDIENCE") || "pirate-api"
  const secret = envValue("AUTH_UPSTREAM_JWT_SHARED_SECRET") || envValue("JWT_BASED_AUTH_SHARED_SECRET")
  if (!secret) throw new Error("AUTH_UPSTREAM_JWT_SHARED_SECRET or JWT_BASED_AUTH_SHARED_SECRET is required")
  return await new SignJWT()
    .setProtectedHeader({ alg: "HS256", typ: "JWT" })
    .setIssuer(issuer)
    .setAudience(audience)
    .setSubject(subject)
    .setIssuedAt()
    .setExpirationTime("15m")
    .sign(new TextEncoder().encode(secret))
}

async function requestJson<T>(input: {
  apiUrl: string
  method: HttpMethod
  path: string
  token?: string
  body?: unknown
  ok?: number[]
}): Promise<{ body: T; response: Response }> {
  const headers = new Headers()
  if (input.token) headers.set("authorization", `Bearer ${input.token}`)
  if (input.body !== undefined) headers.set("content-type", "application/json")
  const response = await fetch(new URL(input.path, input.apiUrl), {
    method: input.method,
    headers,
    body: input.body === undefined ? undefined : JSON.stringify(input.body),
  })
  const text = await response.text()
  const body = (text.trim() ? JSON.parse(text) : null) as T
  const ok = input.ok ?? [200, 201, 202]
  if (!ok.includes(response.status)) throw new Error(`${input.method} ${input.path} failed with ${response.status}: ${text}`)
  return { body, response }
}

function user(ctx: SeedContext, key: string): SessionUser {
  const resolved = ctx.users.get(key)
  if (!resolved) throw new Error(`Unknown seed user: ${key}`)
  return resolved
}

async function completeUniqueHuman(ctx: SeedContext, session: SessionUser): Promise<void> {
  const provider = session.verification_provider ?? "very"
  const created = await requestJson<{ verification_session_id: string }>({
    apiUrl: ctx.apiUrl,
    method: "POST",
    path: "/verification-sessions",
    token: session.accessToken,
    body: { provider },
    ok: [201],
  })
  const completed = await requestJson<{ status?: string }>({
    apiUrl: ctx.apiUrl,
    method: "POST",
    path: `/verification-sessions/${encodeURIComponent(created.body.verification_session_id)}/complete`,
    token: session.accessToken,
    body: provider === "very"
      ? { proof: `seed-proof-${session.key}` }
      : { proof_hash: `seed-proof-${session.key}` },
  })
  if (completed.body.status !== "verified") {
    throw new Error(`unique_human completion for ${session.key} ended with status ${completed.body.status ?? "unknown"}`)
  }
  ctx.report.push(`completed ${provider} unique_human for ${session.key}`)
}

async function applyProfile(ctx: SeedContext, session: SessionUser): Promise<void> {
  if (!session.profile) return

  const patchBody: Record<string, unknown> = {}
  for (const key of ["display_name", "bio", "avatar_ref", "cover_ref", "preferred_locale"] as const) {
    if (session.profile[key] !== undefined) patchBody[key] = session.profile[key]
  }
  if (Object.keys(patchBody).length > 0) {
    await requestJson<unknown>({
      apiUrl: ctx.apiUrl,
      method: "PATCH",
      path: "/profiles/me",
      token: session.accessToken,
      body: patchBody,
    })
    ctx.report.push(`updated profile for ${session.key}`)
  }

  if (session.profile.desired_handle) {
    const current = await requestJson<{ global_handle?: { label?: string } }>({
      apiUrl: ctx.apiUrl,
      method: "GET",
      path: "/profiles/me",
      token: session.accessToken,
    })
    const desired = normalizeHandleLabel(session.profile.desired_handle)
    const currentLabel = current.body.global_handle?.label?.toLowerCase() ?? ""
    if (currentLabel === desired) {
      ctx.report.push(`kept existing handle ${desired} for ${session.key}`)
      return
    }
    await requestJson<unknown>({
      apiUrl: ctx.apiUrl,
      method: "POST",
      path: "/profiles/me/global-handle/rename",
      token: session.accessToken,
      body: { desired_label: session.profile.desired_handle },
    })
    ctx.report.push(`renamed handle for ${session.key} -> ${desired}`)
  }
}

function normalizeHandleLabel(value: string): string {
  const normalized = value.trim().toLowerCase()
  return normalized.endsWith(".pirate") ? normalized : `${normalized}.pirate`
}

async function resolveUsers(ctx: SeedContext, manifest: SeedManifest): Promise<void> {
  for (const seedUser of manifest.users) {
    const envToken = seedUser.access_token_env ? envValue(seedUser.access_token_env) : ""
    if (envToken) {
      const me = await requestJson<{ user_id?: string; user?: { user_id?: string } }>({
        apiUrl: ctx.apiUrl,
        method: "GET",
        path: "/users/me",
        token: envToken,
      })
      const userId = me.body.user_id ?? me.body.user?.user_id
      if (!userId) throw new Error(`/users/me did not return user_id for ${seedUser.key}`)
      const session = { ...seedUser, accessToken: envToken, userId }
      ctx.users.set(seedUser.key, session)
      ctx.report.push(`resolved token user ${seedUser.key} -> ${userId}`)
      await applyProfile(ctx, session)
      continue
    }
    if (!seedUser.subject) throw new Error(`User ${seedUser.key} needs subject or access_token_env`)
    const jwt = await mintJwt(seedUser.subject)
    const exchanged = await requestJson<{ access_token: string; user: { user_id: string } }>({
      apiUrl: ctx.apiUrl,
      method: "POST",
      path: "/auth/session/exchange",
      body: { proof: { type: "jwt_based_auth", jwt } },
    })
    const session = { ...seedUser, accessToken: exchanged.body.access_token, userId: exchanged.body.user.user_id }
    ctx.users.set(seedUser.key, session)
    ctx.report.push(`exchanged jwt user ${seedUser.key} -> ${session.userId}`)
    await applyProfile(ctx, session)
    if (seedUser.verify_unique_human !== false && ctx.mode !== "prod-launch-seed") await completeUniqueHuman(ctx, session)
  }
}

async function resolveNamespace(ctx: SeedContext, owner: SessionUser, namespace: NamespaceSeed | undefined): Promise<string | null> {
  if (!namespace) return null
  if (namespace.namespace_verification_id) return namespace.namespace_verification_id
  if (namespace.provenance?.includes("imported")) {
    throw new Error(`Imported namespace ${namespace.root_label} requires namespace.namespace_verification_id`)
  }
  if (ctx.mode === "prod-launch-seed") throw new Error("prod-launch-seed requires namespace.namespace_verification_id")
  const started = await requestJson<{ namespace_verification_session_id: string }>({
    apiUrl: ctx.apiUrl,
    method: "POST",
    path: "/namespace-verification-sessions",
    token: owner.accessToken,
    body: { family: namespace.family, root_label: namespace.root_label },
    ok: [201],
  })
  const completed = await requestJson<{ namespace_verification_id: string }>({
    apiUrl: ctx.apiUrl,
    method: "POST",
    path: `/namespace-verification-sessions/${encodeURIComponent(started.body.namespace_verification_session_id)}/complete`,
    token: owner.accessToken,
    body: {},
  })
  ctx.report.push(`completed ${namespace.family} namespace ${namespace.root_label}`)
  return completed.body.namespace_verification_id
}

async function joinAndFollow(ctx: SeedContext, community: CommunitySeed, communityId: string): Promise<void> {
  for (const key of community.members ?? []) {
    await requestJson<unknown>({
      apiUrl: ctx.apiUrl,
      method: "POST",
      path: `/communities/${encodeURIComponent(communityId)}/join`,
      token: user(ctx, key).accessToken,
      body: {},
    })
    ctx.report.push(`joined ${key} to ${community.key}`)
  }
  for (const key of community.followers ?? []) {
    await requestJson<unknown>({
      apiUrl: ctx.apiUrl,
      method: "PUT",
      path: `/communities/${encodeURIComponent(communityId)}/follow`,
      token: user(ctx, key).accessToken,
      body: {},
    })
    ctx.report.push(`followed ${community.key} as ${key}`)
  }
}

async function applyVotes(ctx: SeedContext, target: "post" | "comment", id: string, votes: VoteSeed[]): Promise<void> {
  if (ctx.mode === "prod-launch-seed" && votes.length > 0) throw new Error("prod-launch-seed cannot apply votes")
  for (const vote of votes) {
    await requestJson<unknown>({
      apiUrl: ctx.apiUrl,
      method: "POST",
      path: target === "post" ? `/posts/${encodeURIComponent(id)}/vote` : `/comments/${encodeURIComponent(id)}/vote`,
      token: user(ctx, vote.voter).accessToken,
      body: { value: vote.value },
    })
    ctx.report.push(`applied ${target} vote ${vote.value} by ${vote.voter}`)
  }
}

async function seedComment(
  ctx: SeedContext,
  community: CommunitySeed,
  communityId: string,
  postId: string,
  comment: CommentSeed,
  key: string,
  parentCommentId?: string,
): Promise<void> {
  const path = parentCommentId
    ? `/comments/${encodeURIComponent(parentCommentId)}/replies`
    : `/communities/${encodeURIComponent(communityId)}/posts/${encodeURIComponent(postId)}/comments`
  const created = await requestJson<{ comment_id: string }>({
    apiUrl: ctx.apiUrl,
    method: "POST",
    path,
    token: user(ctx, comment.author).accessToken,
    body: { body: comment.body },
    ok: [201],
  })
  ctx.comments.set(key, created.body.comment_id)
  ctx.report.push(`created comment ${key} -> ${created.body.comment_id}`)
  await applyVotes(ctx, "comment", created.body.comment_id, comment.votes ?? [])
  for (const reply of comment.replies ?? []) {
    await seedComment(ctx, community, communityId, postId, reply, `${key}.${reply.key}`, created.body.comment_id)
  }
}

function requireLink(response: Response, expectedPath: string): void {
  const link = response.headers.get("link")
  if (!link?.includes(expectedPath)) throw new Error(`Response missing Link header containing ${expectedPath}`)
}

async function verifyPost(ctx: SeedContext, postId: string): Promise<void> {
  const post = await requestJson<{ links?: Record<string, { href?: string }> }>({
    apiUrl: ctx.apiUrl,
    method: "GET",
    path: `/public-posts/${encodeURIComponent(postId)}`,
  })
  requireLink(post.response, `/public-posts/${postId}`)
  if (!post.body.links?.markdown?.href) throw new Error(`Public post ${postId} did not include markdown link`)
  const markdown = await fetch(new URL(`/public-posts/${encodeURIComponent(postId)}?format=markdown`, ctx.apiUrl), {
    headers: { accept: "text/markdown" },
  })
  if (!markdown.ok || !markdown.headers.get("content-type")?.includes("text/markdown")) {
    throw new Error(`Public post markdown check failed for ${postId}`)
  }
  if (post.body.links.top_comments?.href) {
    const top = await requestJson<{ top_comments?: unknown[]; comments?: unknown[]; top_comments_limit?: number }>({
      apiUrl: ctx.apiUrl,
      method: "GET",
      path: `/public-posts/${encodeURIComponent(postId)}/top-comments`,
    })
    const items = top.body.top_comments ?? top.body.comments ?? []
    if (items.length > (top.body.top_comments_limit ?? 10)) throw new Error(`Top comments exceeded limit for ${postId}`)
  }
  ctx.report.push(`verified public post surfaces ${postId}`)
}

async function seedPosts(ctx: SeedContext, community: CommunitySeed, communityId: string): Promise<void> {
  for (const post of community.posts ?? []) {
    const created = await requestJson<{ post_id: string; visibility?: string }>({
      apiUrl: ctx.apiUrl,
      method: "POST",
      path: `/communities/${encodeURIComponent(communityId)}/posts`,
      token: user(ctx, post.author).accessToken,
      body: post.body,
    })
    const key = `${community.key}.${post.key}`
    ctx.posts.set(key, created.body.post_id)
    ctx.report.push(`created post ${key} -> ${created.body.post_id}`)
    await applyVotes(ctx, "post", created.body.post_id, post.votes ?? [])
    for (const comment of post.comments ?? []) {
      await seedComment(ctx, community, communityId, created.body.post_id, comment, `${key}.${comment.key}`)
    }
    const resolvedVisibility = typeof created.body.visibility === "string"
      ? created.body.visibility
      : typeof post.body.visibility === "string"
        ? post.body.visibility
        : null
    if (resolvedVisibility === "public") {
      await verifyPost(ctx, created.body.post_id)
    } else if (resolvedVisibility === null) {
      ctx.warnings.push(`skipped public verification for ${key}; API response and manifest did not declare visibility`)
    }
  }
}

async function verifyCommunity(ctx: SeedContext, communityId: string, owner: SessionUser): Promise<void> {
  await requestJson<unknown>({
    apiUrl: ctx.apiUrl,
    method: "GET",
    path: `/communities/${encodeURIComponent(communityId)}/posts?limit=10&sort=top`,
    token: owner.accessToken,
  })
  const preview = await requestJson<{ links?: Record<string, { href?: string }> }>({
    apiUrl: ctx.apiUrl,
    method: "GET",
    path: `/public-communities/${encodeURIComponent(communityId)}`,
  })
  requireLink(preview.response, `/public-communities/${communityId}`)
  if (!preview.body.links?.posts?.href) throw new Error(`Public community ${communityId} did not include posts link`)
  const markdown = await fetch(new URL(`/public-communities/${encodeURIComponent(communityId)}?format=markdown`, ctx.apiUrl), {
    headers: { accept: "text/markdown" },
  })
  if (!markdown.ok || !markdown.headers.get("content-type")?.includes("text/markdown")) {
    throw new Error(`Public community markdown check failed for ${communityId}`)
  }
  ctx.report.push(`verified community public/auth surfaces ${communityId}`)
}

async function seedCommunities(ctx: SeedContext, manifest: SeedManifest): Promise<void> {
  for (const community of manifest.communities) {
    if (community.community_id) {
      ctx.communities.set(community.key, community.community_id)
      ctx.report.push(`reusing community ${community.key} -> ${community.community_id}`)
    } else {
      const owner = user(ctx, community.owner)
      const namespaceVerificationId = await resolveNamespace(ctx, owner, community.namespace)
      const body = {
        ...(community.create ?? {}),
        ...(namespaceVerificationId ? { namespace: { namespace_verification_id: namespaceVerificationId } } : {}),
      }
      const created = await requestJson<{ community: { community_id: string } }>({
        apiUrl: ctx.apiUrl,
        method: "POST",
        path: "/communities",
        token: owner.accessToken,
        body,
        ok: [202],
      })
      ctx.communities.set(community.key, created.body.community.community_id)
      ctx.report.push(`created community ${community.key} -> ${created.body.community.community_id}`)
    }
    const communityId = ctx.communities.get(community.key)!
    const owner = user(ctx, community.owner)
    await joinAndFollow(ctx, community, communityId)
    if (community.machine_access_policy) {
      await requestJson<unknown>({
        apiUrl: ctx.apiUrl,
        method: "PATCH",
        path: `/communities/${encodeURIComponent(communityId)}/machine-access-policy`,
        token: owner.accessToken,
        body: community.machine_access_policy,
      })
      ctx.report.push(`patched machine access policy for ${community.key}`)
    }
    await seedPosts(ctx, community, communityId)
    await verifyCommunity(ctx, communityId, owner)
  }
}

async function main(): Promise<void> {
  const mode = modeFromArg(readArg("--mode"))
  const execute = hasFlag("--execute")
  const manifestPath = resolve(readArg("--manifest") ?? resolve(process.cwd(), "scripts", "seed-manifests", `${mode}.json`))
  const apiUrl = readArg("--api-url") ?? process.env.PIRATE_API_URL ?? "http://127.0.0.1:8787"
  const rawManifest = JSON.parse(await readFile(manifestPath, "utf8")) as unknown
  const missingEnvRefs = collectMissingEnvRefs(rawManifest)
  const manifest = parseManifest(rawManifest)
  const warnings = validateManifest({ manifest, mode, execute, missingEnvRefs })
  const stats = collectStats(manifest)

  if (mode === "prod-launch-seed") {
    assertProductionGuardrails(manifest)
    if (execute && !hasFlag("--confirm-production")) throw new Error("prod-launch-seed --execute requires --confirm-production")
  }

  if (!execute) {
    console.log(JSON.stringify({
      mode,
      api_url: apiUrl,
      manifest: manifest.name,
      description: manifest.description ?? null,
      manifest_path: manifestPath,
      dry_run: true,
      planned: stats,
      warnings,
      note: "Pass --execute to create and verify API state.",
    }, null, 2))
    return
  }

  const ctx: SeedContext = {
    apiUrl,
    execute,
    mode,
    users: new Map(),
    communities: new Map(),
    posts: new Map(),
    comments: new Map(),
    report: [],
    warnings,
  }
  await resolveUsers(ctx, manifest)
  await seedCommunities(ctx, manifest)
  console.log(JSON.stringify({
    mode,
    api_url: apiUrl,
    manifest: manifest.name,
    communities: Object.fromEntries(ctx.communities),
    posts: Object.fromEntries(ctx.posts),
    comments: Object.fromEntries(ctx.comments),
    planned: stats,
    warnings: ctx.warnings,
    report: ctx.report,
  }, null, 2))
}

await main()
