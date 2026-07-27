/**
 * Removable staging fixture for authenticated home-feed fanout benchmarks.
 *
 * This tool never creates communities. It writes tagged video posts only to
 * explicitly supplied existing staging communities, records every created post
 * before continuing, and cleanup deletes only those recorded IDs.
 *
 * Dry-run is the default. Mutations require --apply.
 */
import { readFile, unlink, writeFile } from "node:fs/promises"
import { resolve } from "node:path"
import { SignJWT } from "jose"
import {
  STAGING_TEST_JWT_AUDIENCE,
  STAGING_TEST_JWT_ISSUER,
} from "../src/lib/auth/staging-test-auth"

type FixturePost = {
  author_user_id: string
  community_id: string
  post_id: string
}

type FixtureState = {
  api_base: string
  author_user_ids: string[]
  community_ids: string[]
  created_at: string
  posts: FixturePost[]
  schema_version: 1
  storage_ref: string
  viewer_user_id: string
}

const DEFAULT_STATE_PATH = resolve(process.cwd(), ".staging-home-feed-benchmark-fixture.json")
const AUTHOR_COUNT = 15
const POSTS_PER_COMMUNITY = 3
const REQUIRED_COMMUNITIES = 9

function arg(name: string): string | undefined {
  const index = process.argv.indexOf(`--${name}`)
  return index >= 0 ? process.argv[index + 1] : undefined
}

function args(name: string): string[] {
  const values: string[] = []
  process.argv.forEach((value, index) => {
    if (value === `--${name}` && process.argv[index + 1]) {
      values.push(process.argv[index + 1]!.trim())
    }
  })
  return values.filter(Boolean)
}

function flag(name: string): boolean {
  return process.argv.includes(`--${name}`)
}

function publicId(value: string, prefix: string): string {
  return value.startsWith(`${prefix}_`) ? value : `${prefix}_${value}`
}

function internalId(value: string, prefix: string): string {
  return value.replace(new RegExp(`^${prefix}_`, "u"), "")
}

async function requestJson<T>(input: {
  apiBase: string
  body?: unknown
  headers?: Record<string, string>
  method: "POST"
  path: string
}): Promise<T> {
  const response = await fetch(new URL(input.path, input.apiBase), {
    method: input.method,
    headers: {
      ...(input.body === undefined ? {} : { "content-type": "application/json" }),
      ...input.headers,
    },
    body: input.body === undefined ? undefined : JSON.stringify(input.body),
  })
  const text = await response.text()
  if (!response.ok) {
    throw new Error(`${input.method} ${input.path} failed with ${response.status}: ${text.slice(0, 800)}`)
  }
  return (text ? JSON.parse(text) : null) as T
}

async function resolveSyntheticUser(apiBase: string, subject: string, secret: string): Promise<string> {
  const now = Math.floor(Date.now() / 1000)
  const jwt = await new SignJWT({})
    .setProtectedHeader({ alg: "HS256", typ: "JWT" })
    .setIssuer(STAGING_TEST_JWT_ISSUER)
    .setAudience(STAGING_TEST_JWT_AUDIENCE)
    .setSubject(subject)
    .setIssuedAt(now)
    .setExpirationTime(now + 900)
    .sign(new TextEncoder().encode(secret))
  const exchanged = await requestJson<{
    user: { id?: string; user_id?: string }
  }>({
    apiBase,
    method: "POST",
    path: "/auth/session/exchange",
    body: { proof: { type: "staging_test_jwt", jwt } },
  })
  const userId = exchanged.user.user_id ?? exchanged.user.id
  if (!userId) throw new Error(`session exchange omitted user id for ${subject}`)
  return internalId(userId, "usr")
}

async function writeState(path: string, state: FixtureState): Promise<void> {
  await writeFile(path, `${JSON.stringify(state, null, 2)}\n`, { flag: "w" })
}

async function readState(path: string): Promise<FixtureState> {
  return JSON.parse(await readFile(path, "utf8")) as FixtureState
}

async function createFixture(input: {
  adminToken: string
  apiBase: string
  communityIds: string[]
  statePath: string
  storageRef: string
  apply: boolean
}): Promise<void> {
  if (input.communityIds.length !== REQUIRED_COMMUNITIES) {
    throw new Error(`create requires exactly ${REQUIRED_COMMUNITIES} distinct --community values`)
  }
  if (!input.apply) {
    console.log(JSON.stringify({
      apply: false,
      authors: AUTHOR_COUNT,
      communities: input.communityIds,
      posts: input.communityIds.length * POSTS_PER_COMMUNITY,
      state_path: input.statePath,
      storage_ref: input.storageRef,
    }, null, 2))
    return
  }
  await readFile(input.statePath, "utf8")
    .then(() => {
      throw new Error(`state file already exists: ${input.statePath}; clean it up first`)
    })
    .catch((error: unknown) => {
      if ((error as { code?: string }).code !== "ENOENT") throw error
    })

  const secret = String(process.env.STAGING_TEST_JWT_SHARED_SECRET ?? "").trim()
  if (!secret) throw new Error("STAGING_TEST_JWT_SHARED_SECRET is required")
  const viewerUserId = await resolveSyntheticUser(input.apiBase, "home-feed-benchmark-viewer-v1", secret)
  const authorUserIds: string[] = []
  for (let index = 0; index < AUTHOR_COUNT; index += 1) {
    authorUserIds.push(await resolveSyntheticUser(
      input.apiBase,
      `home-feed-benchmark-author-v1-${String(index + 1).padStart(2, "0")}`,
      secret,
    ))
  }
  const state: FixtureState = {
    api_base: input.apiBase,
    author_user_ids: authorUserIds,
    community_ids: input.communityIds,
    created_at: new Date().toISOString(),
    posts: [],
    schema_version: 1,
    storage_ref: input.storageRef,
    viewer_user_id: viewerUserId,
  }
  await writeState(input.statePath, state)

  for (let communityIndex = 0; communityIndex < input.communityIds.length; communityIndex += 1) {
    const communityId = input.communityIds[communityIndex]!
    for (let postIndex = 0; postIndex < POSTS_PER_COMMUNITY; postIndex += 1) {
      const authorUserId = authorUserIds[(communityIndex * POSTS_PER_COMMUNITY + postIndex) % authorUserIds.length]!
      const created = await requestJson<{ id?: string; post_id?: string }>({
        apiBase: input.apiBase,
        method: "POST",
        path: `/communities/${encodeURIComponent(publicId(communityId, "com"))}/posts`,
        headers: {
          "x-admin-as-user-id": authorUserId,
          "x-admin-operation-class": "home_feed_benchmark_fixture",
          "x-admin-token": input.adminToken,
        },
        body: {
          idempotency_key: `home-feed-benchmark-v1-${communityIndex + 1}-${postIndex + 1}`,
          identity_mode: "public",
          media_refs: [{
            mime_type: "video/mp4",
            size_bytes: 1,
            storage_ref: input.storageRef,
          }],
          post_type: "video",
          rights_basis: "original",
          title: `Home feed benchmark ${communityIndex + 1}.${postIndex + 1}`,
          visibility: "public",
        },
      })
      const postId = created.post_id ?? created.id
      if (!postId) throw new Error(`post create omitted id for community ${communityId}`)
      state.posts.push({
        author_user_id: authorUserId,
        community_id: internalId(communityId, "com"),
        post_id: internalId(postId, "post"),
      })
      await writeState(input.statePath, state)
    }
  }
  console.log(JSON.stringify({
    created_posts: state.posts.length,
    state_path: input.statePath,
    viewer_user_id: state.viewer_user_id,
  }, null, 2))
}

async function verifyFixture(input: {
  adminToken: string
  statePath: string
}): Promise<void> {
  const state = await readState(input.statePath)
  const response = await requestJson<{
    items: Array<{
      community: { community_id?: string; id?: string }
      post: { post: { author_user?: { id?: string; user_id?: string } } }
    }>
  }>({
    apiBase: state.api_base,
    method: "POST",
    path: "/admin/debug/home-feed-benchmark",
    headers: { "x-admin-token": input.adminToken },
    body: {
      community_ids: state.community_ids.map((id) => publicId(id, "com")),
      sort: "best",
      user_id: publicId(state.viewer_user_id, "usr"),
    },
  })
  const communityIds = new Set(response.items.map((item) => item.community.community_id ?? item.community.id))
  const authorIds = new Set(response.items.map((item) => (
    item.post.post.author_user?.user_id ?? item.post.post.author_user?.id
  )).filter(Boolean))
  const report = {
    authors: authorIds.size,
    communities: communityIds.size,
    items: response.items.length,
  }
  console.log(JSON.stringify(report, null, 2))
  if (report.items !== 25 || report.communities < 9 || report.authors < 13) {
    throw new Error(`fixture page shape is not benchmark-ready: ${JSON.stringify(report)}`)
  }
}

async function cleanupFixture(input: {
  adminToken: string
  statePath: string
  apply: boolean
}): Promise<void> {
  const state = await readState(input.statePath)
  if (!input.apply) {
    console.log(JSON.stringify({
      apply: false,
      delete_posts: state.posts.length,
      state_path: input.statePath,
    }, null, 2))
    return
  }
  while (state.posts.length > 0) {
    const post = state.posts[state.posts.length - 1]!
    await requestJson<unknown>({
      apiBase: state.api_base,
      method: "POST",
      path: `/communities/${encodeURIComponent(publicId(post.community_id, "com"))}/posts/${encodeURIComponent(publicId(post.post_id, "post"))}/delete`,
      headers: {
        "x-admin-as-user-id": post.author_user_id,
        "x-admin-token": input.adminToken,
      },
    })
    state.posts.pop()
    await writeState(input.statePath, state)
  }
  await unlink(input.statePath)
  console.log(JSON.stringify({ cleaned: true, state_path: input.statePath }, null, 2))
}

const command = process.argv[2]
if (!["create", "verify", "cleanup"].includes(command ?? "")) {
  throw new Error("usage: staging-home-feed-benchmark-fixture.ts <create|verify|cleanup> [options]")
}
const apiBase = (arg("api-base") ?? "https://api-staging.pirate.sc").replace(/\/$/u, "")
if (new URL(apiBase).hostname !== "api-staging.pirate.sc") {
  throw new Error("fixture is restricted to https://api-staging.pirate.sc")
}
const adminToken = String(process.env.PIRATE_ADMIN_TOKEN ?? "").trim()
if ((command === "verify" || flag("apply")) && !adminToken) {
  throw new Error("PIRATE_ADMIN_TOKEN is required for verification or mutation")
}
const statePath = resolve(arg("state") ?? DEFAULT_STATE_PATH)

if (command === "create") {
  const communityIds = [...new Set(args("community").map((id) => internalId(id, "com")))]
  const storageRef = arg("storage-ref")?.trim()
  if (!storageRef) throw new Error("create requires --storage-ref")
  await createFixture({
    adminToken,
    apiBase,
    apply: flag("apply"),
    communityIds,
    statePath,
    storageRef,
  })
} else if (command === "verify") {
  await verifyFixture({ adminToken, statePath })
} else {
  await cleanupFixture({ adminToken, apply: flag("apply"), statePath })
}
