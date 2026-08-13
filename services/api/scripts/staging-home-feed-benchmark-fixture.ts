/**
 * Removable staging fixture for authenticated home-feed fanout benchmarks.
 *
 * This tool never creates communities. It writes tagged video posts only to
 * explicitly supplied existing staging communities, records every created post
 * before continuing, and cleanup deletes only those recorded IDs.
 *
 * Video post creation validates that the referenced storage_ref is a
 * primary_video artifact uploaded by the posting author in that community, so
 * each synthetic author joins the community and uploads the benchmark video
 * (direct multipart is mandatory for primary_video) before posting. Upload
 * artifacts have no public delete route; cleanup removes every recorded post
 * and reports the orphaned upload IDs it leaves behind (~2 KB each).
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
  upload_id?: string
}

type FixtureState = {
  api_base: string
  author_user_ids: string[]
  community_ids: string[]
  created_at: string
  orphaned_upload_count?: number
  posts: FixturePost[]
  schema_version: 1
  video_file?: string
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

function internalUserId(value: string): string {
  return value.startsWith("usr_usr_") ? value.slice("usr_".length) : value
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

function adminHeaders(adminCredential: string, authorUserId: string): Record<string, string> {
  return {
    "x-admin-as-user-id": authorUserId,
    "x-admin-operation-class": "home_feed_benchmark_fixture",
    Authorization: `Operator ${adminCredential}`,
  }
}

async function joinCommunity(input: {
  adminCredential: string
  apiBase: string
  authorUserId: string
  communityId: string
}): Promise<void> {
  await requestJson<{ status?: string }>({
    apiBase: input.apiBase,
    method: "POST",
    path: `/communities/${encodeURIComponent(publicId(input.communityId, "com"))}/join`,
    headers: adminHeaders(input.adminCredential, input.authorUserId),
    body: {},
  })
}

/**
 * primary_video artifacts only accept direct multipart: intent → signed part
 * PUT (content-type must match the intent, ETag passed back verbatim) →
 * complete. Returns the storage_ref the post's media_refs must reference.
 */
async function uploadVideoArtifact(input: {
  adminCredential: string
  apiBase: string
  authorUserId: string
  communityId: string
  videoBytes: Uint8Array<ArrayBuffer>
}): Promise<{ storageRef: string; uploadId: string }> {
  const headers = adminHeaders(input.adminCredential, input.authorUserId)
  const communityPath = encodeURIComponent(publicId(input.communityId, "com"))
  const hashHex = Buffer.from(await crypto.subtle.digest("SHA-256", input.videoBytes)).toString("hex")
  const intent = await requestJson<{
    id: string
    storage_ref: string
    upload_session?: { id: string; total_parts: number; upload_id: string }
  }>({
    apiBase: input.apiBase,
    method: "POST",
    path: `/communities/${communityPath}/song-artifact-uploads`,
    headers,
    body: {
      artifact_kind: "primary_video",
      content_hash: `0x${hashHex}`,
      mime_type: "video/mp4",
      size_bytes: input.videoBytes.byteLength,
      upload_mode: "direct_multipart",
    },
  })
  const session = intent.upload_session
  if (!session) throw new Error(`upload intent ${intent.id} returned no multipart session`)
  if (session.total_parts !== 1) {
    throw new Error(`benchmark video must fit in one multipart part, got ${session.total_parts}`)
  }
  const uploadPath = `/communities/${communityPath}/song-artifact-uploads/${encodeURIComponent(intent.id)}`
  const signed = await fetch(new URL(`${uploadPath}/sessions/${encodeURIComponent(session.id)}/parts/1/signed-url`, input.apiBase), { headers })
  if (!signed.ok) throw new Error(`part signed-url failed with ${signed.status}`)
  const signedUrl = (await signed.json() as { url: string }).url
  const putResponse = await fetch(signedUrl, {
    method: "PUT",
    headers: { "content-type": "video/mp4" },
    body: new Blob([input.videoBytes], { type: "video/mp4" }),
  })
  const etag = putResponse.headers.get("etag")?.trim()
  if (!putResponse.ok || !etag) {
    throw new Error(`part upload failed with ${putResponse.status}${etag ? "" : " (missing ETag)"}`)
  }
  await requestJson<unknown>({
    apiBase: input.apiBase,
    method: "POST",
    path: `${uploadPath}/sessions/${encodeURIComponent(session.id)}/complete`,
    headers,
    body: {
      content_hash: `0x${hashHex}`,
      parts: [{ etag, part_number: 1 }],
      upload_id: session.upload_id,
    },
  })
  return { storageRef: intent.storage_ref, uploadId: intent.id }
}

async function writeState(path: string, state: FixtureState): Promise<void> {
  await writeFile(path, `${JSON.stringify(state, null, 2)}\n`, { flag: "w" })
}

async function readState(path: string): Promise<FixtureState> {
  return JSON.parse(await readFile(path, "utf8")) as FixtureState
}

async function createFixture(input: {
  adminCredential: string
  apiBase: string
  communityIds: string[]
  statePath: string
  videoFile: string
  apply: boolean
}): Promise<void> {
  if (input.communityIds.length !== REQUIRED_COMMUNITIES) {
    throw new Error(`create requires exactly ${REQUIRED_COMMUNITIES} distinct --community values`)
  }
  const videoBytes = Uint8Array.from(await readFile(input.videoFile))
  if (!input.apply) {
    console.log(JSON.stringify({
      apply: false,
      authors: AUTHOR_COUNT,
      communities: input.communityIds,
      posts: input.communityIds.length * POSTS_PER_COMMUNITY,
      state_path: input.statePath,
      video_file: input.videoFile,
      video_size_bytes: videoBytes.byteLength,
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
    video_file: input.videoFile,
    viewer_user_id: viewerUserId,
  }
  await writeState(input.statePath, state)

  const joinedPairs = new Set<string>()
  for (let communityIndex = 0; communityIndex < input.communityIds.length; communityIndex += 1) {
    const communityId = input.communityIds[communityIndex]!
    for (let postIndex = 0; postIndex < POSTS_PER_COMMUNITY; postIndex += 1) {
      const authorUserId = authorUserIds[(communityIndex * POSTS_PER_COMMUNITY + postIndex) % authorUserIds.length]!
      const pairKey = `${authorUserId}\0${communityId}`
      if (!joinedPairs.has(pairKey)) {
        await joinCommunity({
          adminCredential: input.adminCredential,
          apiBase: input.apiBase,
          authorUserId,
          communityId,
        })
        joinedPairs.add(pairKey)
      }
      const upload = await uploadVideoArtifact({
          adminCredential: input.adminCredential,
        apiBase: input.apiBase,
        authorUserId,
        communityId,
        videoBytes,
      })
      const created = await requestJson<{ id?: string; post_id?: string }>({
        apiBase: input.apiBase,
        method: "POST",
        path: `/communities/${encodeURIComponent(publicId(communityId, "com"))}/posts`,
        headers: adminHeaders(input.adminCredential, authorUserId),
        body: {
          idempotency_key: `home-feed-benchmark-v1-${communityIndex + 1}-${postIndex + 1}`,
          identity_mode: "public",
          media_refs: [{
            mime_type: "video/mp4",
            size_bytes: videoBytes.byteLength,
            storage_ref: upload.storageRef,
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
        upload_id: upload.uploadId,
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
  adminCredential: string
  statePath: string
}): Promise<void> {
  const state = await readState(input.statePath)
  const response = await requestJson<{
    items: Array<{
      community: { community_id?: string; id?: string }
      post: { post: { author_user?: string } }
    }>
  }>({
    apiBase: state.api_base,
    method: "POST",
    path: "/admin/debug/home-feed-benchmark",
    headers: { Authorization: `Operator ${input.adminCredential}` },
    body: {
      community_ids: state.community_ids.map((id) => publicId(id, "com")),
      sort: "best",
      user_id: publicId(state.viewer_user_id, "usr"),
    },
  })
  const communityIds = new Set(response.items.map((item) => item.community.community_id ?? item.community.id))
  const authorIds = new Set(response.items
    .map((item) => item.post.post.author_user)
    .filter((authorUser): authorUser is string => Boolean(authorUser)))
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

async function recoverFixture(input: {
  adminCredential: string
  apiBase: string
  communityIds: string[]
  statePath: string
  viewerUserId: string
}): Promise<void> {
  if (input.communityIds.length !== REQUIRED_COMMUNITIES) {
    throw new Error(`recover requires exactly ${REQUIRED_COMMUNITIES} distinct --community values`)
  }
  await readFile(input.statePath, "utf8")
    .then(() => {
      throw new Error(`state file already exists: ${input.statePath}`)
    })
    .catch((error: unknown) => {
      if ((error as { code?: string }).code !== "ENOENT") throw error
    })

  type RecoveryItem = {
    community: { community_id?: string; id?: string }
    post: {
      post: {
        author_user?: string
        id?: string
        post_id?: string
        title?: string
      }
    }
  }
  const recoveredPosts: FixturePost[] = []
  const seenPostIds = new Set<string>()
  let cursor: string | null = null
  do {
    const response: {
      items: RecoveryItem[]
      next_cursor?: string | null
    } = await requestJson({
      apiBase: input.apiBase,
      method: "POST",
      path: "/admin/debug/home-feed-benchmark",
      headers: { Authorization: `Operator ${input.adminCredential}` },
      body: {
        community_ids: input.communityIds.map((id) => publicId(id, "com")),
        cursor,
        sort: "best",
        user_id: publicId(input.viewerUserId, "usr"),
      },
    })
    for (const item of response.items) {
      const post = item.post.post
      if (!post.title?.startsWith("Home feed benchmark ")) continue
      const publicPostId = post.id ?? post.post_id
      const publicCommunityId = item.community.id ?? item.community.community_id
      const publicAuthorUserId = post.author_user
      if (!publicPostId || !publicCommunityId || !publicAuthorUserId) {
        throw new Error("benchmark item omitted post, community, or author identity")
      }
      const postId = internalId(publicPostId, "post")
      if (seenPostIds.has(postId)) continue
      seenPostIds.add(postId)
      recoveredPosts.push({
        author_user_id: internalUserId(publicAuthorUserId),
        community_id: internalId(publicCommunityId, "com"),
        post_id: postId,
      })
    }
    cursor = response.next_cursor ?? null
  } while (cursor)

  const authorUserIds = [...new Set(recoveredPosts.map((post) => post.author_user_id))]
  const recoveredCommunityIds = [...new Set(recoveredPosts.map((post) => post.community_id))]
  if (
    recoveredPosts.length !== REQUIRED_COMMUNITIES * POSTS_PER_COMMUNITY
    || recoveredCommunityIds.length !== REQUIRED_COMMUNITIES
    || authorUserIds.length !== AUTHOR_COUNT
  ) {
    throw new Error(`recovered fixture shape is unsafe: ${JSON.stringify({
      authors: authorUserIds.length,
      communities: recoveredCommunityIds.length,
      posts: recoveredPosts.length,
    })}`)
  }
  const state: FixtureState = {
    api_base: input.apiBase,
    author_user_ids: authorUserIds,
    community_ids: recoveredCommunityIds,
    created_at: new Date().toISOString(),
    orphaned_upload_count: recoveredPosts.length,
    posts: recoveredPosts,
    schema_version: 1,
    viewer_user_id: input.viewerUserId,
  }
  await writeState(input.statePath, state)
  console.log(JSON.stringify({
    authors: authorUserIds.length,
    communities: recoveredCommunityIds.length,
    posts: recoveredPosts.length,
    recovered: true,
    state_path: input.statePath,
  }, null, 2))
}

async function benchmarkFixture(input: {
  adminCredential: string
  iterations: number
  statePath: string
}): Promise<void> {
  const state = await readState(input.statePath)
  const samples: Array<{
    authors: number
    communities: number
    items: number
    server_timing: string | null
    wall_ms: number
  }> = []
  for (let iteration = 0; iteration < input.iterations; iteration += 1) {
    const startedAt = performance.now()
    const response = await fetch(new URL("/admin/debug/home-feed-benchmark", state.api_base), {
      method: "POST",
      headers: {
        "content-type": "application/json",
        Authorization: `Operator ${input.adminCredential}`,
      },
      body: JSON.stringify({
        community_ids: state.community_ids.map((id) => publicId(id, "com")),
        sort: "best",
        user_id: publicId(state.viewer_user_id, "usr"),
      }),
    })
    const body = await response.json() as {
      items?: Array<{
        community: { community_id?: string; id?: string }
        post: { post: { author_user?: string } }
      }>
    }
    const wallMs = Math.round((performance.now() - startedAt) * 100) / 100
    if (!response.ok || !body.items) {
      throw new Error(`benchmark request ${iteration + 1} failed with ${response.status}`)
    }
    const communities = new Set(body.items.map((item) => item.community.id ?? item.community.community_id))
    const authors = new Set(body.items
      .map((item) => item.post.post.author_user)
      .filter((authorUser): authorUser is string => Boolean(authorUser)))
    const sample = {
      authors: authors.size,
      communities: communities.size,
      items: body.items.length,
      server_timing: response.headers.get("server-timing"),
      wall_ms: wallMs,
    }
    if (sample.items !== 25 || sample.communities < 9 || sample.authors < 13) {
      throw new Error(`benchmark request ${iteration + 1} returned an invalid shape: ${JSON.stringify(sample)}`)
    }
    samples.push(sample)
  }
  const sortedWallMs = samples.map((sample) => sample.wall_ms).sort((left, right) => left - right)
  const percentile = (value: number) => sortedWallMs[Math.ceil((value / 100) * sortedWallMs.length) - 1]!
  console.log(JSON.stringify({
    iterations: input.iterations,
    samples,
    summary: {
      max_wall_ms: sortedWallMs.at(-1),
      min_wall_ms: sortedWallMs[0],
      p50_wall_ms: percentile(50),
      p95_wall_ms: percentile(95),
    },
  }, null, 2))
}

async function cleanupFixture(input: {
  adminCredential: string
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
  const orphanedUploadIds = state.posts.map((post) => post.upload_id).filter(Boolean)
  const orphanedUploadCount = Math.max(state.orphaned_upload_count ?? 0, orphanedUploadIds.length)
  while (state.posts.length > 0) {
    const post = state.posts[state.posts.length - 1]!
    await requestJson<unknown>({
      apiBase: state.api_base,
      method: "POST",
      path: `/communities/${encodeURIComponent(publicId(post.community_id, "com"))}/posts/${encodeURIComponent(publicId(post.post_id, "post"))}/delete`,
      headers: {
        "x-admin-as-user-id": post.author_user_id,
        Authorization: `Operator ${input.adminCredential}`,
      },
    })
    state.posts.pop()
    await writeState(input.statePath, state)
  }
  await unlink(input.statePath)
  console.log(JSON.stringify({
    cleaned: true,
    orphaned_upload_count: orphanedUploadCount,
    orphaned_upload_ids: orphanedUploadIds,
    state_path: input.statePath,
  }, null, 2))
}

const command = process.argv[2]
if (!["benchmark", "create", "recover", "verify", "cleanup"].includes(command ?? "")) {
  throw new Error("usage: staging-home-feed-benchmark-fixture.ts <benchmark|create|recover|verify|cleanup> [options]")
}
const apiBase = (arg("api-base") ?? "https://api-staging.pirate.sc").replace(/\/$/u, "")
if (new URL(apiBase).hostname !== "api-staging.pirate.sc") {
  throw new Error("fixture is restricted to https://api-staging.pirate.sc")
}
const adminCredential = String(process.env.PIRATE_ADMIN_OPERATOR_CREDENTIAL ?? "").trim()
if ((command === "benchmark" || command === "recover" || command === "verify" || flag("apply")) && !adminCredential) {
  throw new Error("PIRATE_ADMIN_OPERATOR_CREDENTIAL is required for verification or mutation")
}
const statePath = resolve(arg("state") ?? DEFAULT_STATE_PATH)

if (command === "benchmark") {
  const parsedIterations = Number.parseInt(arg("iterations") ?? "5", 10)
  if (!Number.isInteger(parsedIterations) || parsedIterations < 1 || parsedIterations > 20) {
    throw new Error("benchmark --iterations must be an integer from 1 to 20")
  }
  await benchmarkFixture({
    adminCredential,
    iterations: parsedIterations,
    statePath,
  })
} else if (command === "create") {
  const communityIds = [...new Set(args("community").map((id) => internalId(id, "com")))]
  const videoFile = arg("video-file")?.trim()
  if (!videoFile) throw new Error("create requires --video-file")
  await createFixture({
    adminCredential,
    apiBase,
    apply: flag("apply"),
    communityIds,
    statePath,
    videoFile: resolve(videoFile),
  })
} else if (command === "recover") {
  const communityIds = [...new Set(args("community").map((id) => internalId(id, "com")))]
  const viewerUserId = arg("viewer-user")?.trim()
  if (!viewerUserId) throw new Error("recover requires --viewer-user")
  await recoverFixture({
    adminCredential,
    apiBase,
    communityIds,
    statePath,
    viewerUserId: internalUserId(viewerUserId),
  })
} else if (command === "verify") {
  await verifyFixture({ adminCredential, statePath })
} else {
  await cleanupFixture({ adminCredential, apply: flag("apply"), statePath })
}
