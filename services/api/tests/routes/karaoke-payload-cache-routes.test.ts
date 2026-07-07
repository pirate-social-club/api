import { afterEach, beforeEach, describe, expect, mock, test } from "bun:test"
import { Hono } from "hono"
import type { AuthenticatedEnv } from "../../src/lib/auth-middleware"
import type { SongKaraokePayload } from "../../src/types"
import {
  registerCommunityKaraokeSessionRoutes,
  setKaraokePayloadRouteDepsForTests,
} from "../../src/routes/communities-karaoke-session-routes"
import publicPosts from "../../src/routes/public-posts"

const COMMUNITY_ID = "com_cmt_test"
const RESOLVED_COMMUNITY_ID = "cmt_test"
const POST_ID = "post_pst_test"
const PATH = `http://pirate.test/${COMMUNITY_ID}/posts/${POST_ID}/karaoke`
const PUBLIC_POST_PATH = `http://pirate.test/public-posts/${POST_ID}/karaoke`
const TEST_ENV = {
  CONTROL_PLANE_DATABASE_URL: "postgres://user:pass@example.test:5432/db",
  ENVIRONMENT: "test",
}
const TEST_EXECUTION_CTX = {
  passThroughOnException() {},
  props: {},
  waitUntil(_promise: Promise<unknown>) {},
}

const state: {
  cacheable: boolean
  cacheStore: Map<string, Response>
  payloadCalls: unknown[]
  postContext: object
  projectionCalls: string[]
  restoreDeps: (() => void) | null
  resolveCommunityCalls: string[]
} = {
  cacheable: true,
  cacheStore: new Map(),
  payloadCalls: [],
  postContext: {},
  projectionCalls: [],
  restoreDeps: null,
  resolveCommunityCalls: [],
}

const payload: SongKaraokePayload = {
  id: "bundle_test",
  object: "song_karaoke_payload",
  post: POST_ID,
  community: COMMUNITY_ID,
  title: "Cached karaoke",
  instrumental_audio_url: "https://media.example/instrumental.mp3",
  karaoke_lines: [],
  raw_lines: [],
}

async function getTestWorkerCache(): Promise<Cache> {
  return {
    match: mock(async (request: Request) => state.cacheStore.get(request.url)),
    put: mock(async (request: Request, response: Response) => {
      state.cacheStore.set(request.url, response)
    }),
  } as unknown as Cache
}

function installRouteDeps(): void {
  state.restoreDeps = setKaraokePayloadRouteDepsForTests({
    getCommunityRepository: mock(() => ({
      getCommunityById: mock(async (communityId: string) => ({
        community_id: communityId,
        provisioning_state: "active",
        status: "active",
      })),
      getCommunityPostProjectionByPostId: mock(async (postId: string) => {
        state.projectionCalls.push(postId)
        return {
          community_id: RESOLVED_COMMUNITY_ID,
          post_id: postId,
        }
      }),
      kind: "community-repository",
    }) as never),
    getPostKaraokePayload: mock(async (input: unknown) => {
      state.payloadCalls.push(input)
      return payload
    }),
    getProfileRepository: mock(() => ({ kind: "profile-repository" }) as never),
    getUserRepository: mock(() => ({ kind: "user-repository" }) as never),
    getWorkerCache: getTestWorkerCache,
    loadPublicPostKaraokePayloadCacheContext: mock(async () => ({
      cacheable: state.cacheable,
      postContext: state.postContext as never,
    })),
    resolveCommunityIdentifier: mock(async (_repository, communityId: string) => {
      state.resolveCommunityCalls.push(communityId)
      return RESOLVED_COMMUNITY_ID
    }),
  })
}

function buildApp(): Hono<AuthenticatedEnv> {
  const app = new Hono<AuthenticatedEnv>()
  registerCommunityKaraokeSessionRoutes(app)
  return app
}

function buildPublicApp(): Hono {
  const app = new Hono()
  app.route("/public-posts", publicPosts)
  return app
}

describe("karaoke payload Worker cache", () => {
  beforeEach(() => {
    state.cacheable = true
    state.cacheStore.clear()
    state.payloadCalls = []
    state.postContext = { id: crypto.randomUUID() }
    state.projectionCalls = []
    state.resolveCommunityCalls = []
    installRouteDeps()
  })

  afterEach(() => {
    state.restoreDeps?.()
    state.restoreDeps = null
  })

  test("caches public karaoke payloads and reuses the eligibility post context on miss", async () => {
    const app = buildApp()

    const first = await app.request(PATH, { headers: { origin: "https://pirate.sc" } }, TEST_ENV, TEST_EXECUTION_CTX)
    expect(first.status).toBe(200)
    expect(first.headers.get("X-Pirate-Worker-Cache")).toBe("MISS")
    expect(state.payloadCalls).toHaveLength(1)
    expect(state.payloadCalls[0]).toMatchObject({ postContext: state.postContext })

    const second = await app.request(PATH, { headers: { origin: "https://pirate.sc" } }, TEST_ENV, TEST_EXECUTION_CTX)
    expect(second.status).toBe(200)
    expect(second.headers.get("X-Pirate-Worker-Cache")).toBe("HIT")
    expect(await second.json()).toEqual(payload)
    expect(state.payloadCalls).toHaveLength(1)
  })

  test("bypasses the Worker cache when the post is not publicly cacheable", async () => {
    state.cacheable = false
    const app = buildApp()

    const first = await app.request(PATH, undefined, TEST_ENV, TEST_EXECUTION_CTX)
    expect(first.status).toBe(200)
    expect(first.headers.get("X-Pirate-Worker-Cache")).toBe("BYPASS")

    const second = await app.request(PATH, undefined, TEST_ENV, TEST_EXECUTION_CTX)
    expect(second.status).toBe(200)
    expect(second.headers.get("X-Pirate-Worker-Cache")).toBe("BYPASS")
    expect(state.payloadCalls).toHaveLength(2)
  })

  test("serves karaoke payloads from a post-id-only public endpoint", async () => {
    const app = buildPublicApp()

    const first = await app.request(PUBLIC_POST_PATH, { headers: { origin: "https://pirate.sc" } }, TEST_ENV, TEST_EXECUTION_CTX)
    expect(first.status).toBe(200)
    expect(first.headers.get("X-Pirate-Worker-Cache")).toBe("MISS")
    expect(state.projectionCalls).toEqual(["pst_test"])
    expect(state.resolveCommunityCalls).toEqual([])
    expect(state.payloadCalls).toHaveLength(1)
    expect(state.payloadCalls[0]).toMatchObject({
      communityId: RESOLVED_COMMUNITY_ID,
      postContext: state.postContext,
      postId: "pst_test",
    })

    const second = await app.request(PUBLIC_POST_PATH, { headers: { origin: "https://pirate.sc" } }, TEST_ENV, TEST_EXECUTION_CTX)
    expect(second.status).toBe(200)
    expect(second.headers.get("X-Pirate-Worker-Cache")).toBe("HIT")
    expect(await second.json()).toEqual(payload)
    expect(state.payloadCalls).toHaveLength(1)
  })
})
