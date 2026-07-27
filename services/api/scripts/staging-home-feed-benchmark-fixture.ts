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
  upload_id: string
}

type FixtureState = {
  api_base: string
  author_user_ids: string[]
  community_ids: string[]
  created_at: string
  posts: FixturePost[]
  schema_version: 1
  video_file: string
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

function adminHeaders(adminToken: string, authorUserId: string): Record<string, string> {
  return {
    "x-admin-as-user-id": authorUserId,
    "x-admin-operation-class": "home_feed_benchmark_fixture",
    "x-admin-token": adminToken,
  }
}

async function joinCommunity(input: {
  adminToken: string
  apiBase: string
  authorUserId: string
  communityId: string
}): Promise<void> {
  await requestJson<{ status?: string }>({
    apiBase: input.apiBase,
    method: "POST",
    path: `/communities/${encodeURIComponent(publicId(input.communityId, "com"))}/join`,
    headers: adminHeaders(input.adminToken, input.authorUserId),
    body: {},
  })
}

/**
 * primary_video artifacts only accept direct multipart: intent → signed part
 * PUT (content-type must match the intent, ETag passed back verbatim) →
 * complete. Returns the storage_ref the post's media_refs must reference.
 */
async function uploadVideoArtifact(input: {
  adminToken: string
  apiBase: string
  authorUserId: string
  communityId: string
  videoBytes: Uint8Array<ArrayBuffer>
}): Promise<{ storageRef: string; uploadId: string }> {
  const headers = adminHeaders(input.adminToken, input.authorUserId)
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
  adminToken: string
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
          adminToken: input.adminToken,
          apiBase: input.apiBase,
          authorUserId,
          communityId,
        })
        joinedPairs.add(pairKey)
      }
      const upload = await uploadVideoArtifact({
        adminToken: input.adminToken,
        apiBase: input.apiBase,
        authorUserId,
        communityId,
        videoBytes,
      })
      const created = await requestJson<{ id?: string; post_id?: string }>({
        apiBase: input.apiBase,
        method: "POST",
        path: `/communities/${encodeURIComponent(publicId(communityId, "com"))}/posts`,
        headers: adminHeaders(input.adminToken, authorUserId),
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
  const orphanedUploadIds = state.posts.map((post) => post.upload_id).filter(Boolean)
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
  console.log(JSON.stringify({
    cleaned: true,
    orphaned_upload_ids: orphanedUploadIds,
    state_path: input.statePath,
  }, null, 2))
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
  const videoFile = arg("video-file")?.trim()
  if (!videoFile) throw new Error("create requires --video-file")
  await createFixture({
    adminToken,
    apiBase,
    apply: flag("apply"),
    communityIds,
    statePath,
    videoFile: resolve(videoFile),
  })
} else if (command === "verify") {
  await verifyFixture({ adminToken, statePath })
} else {
  await cleanupFixture({ adminToken, apply: flag("apply"), statePath })
}
