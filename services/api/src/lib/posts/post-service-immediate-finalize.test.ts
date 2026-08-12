import { afterEach, describe, expect, test } from "bun:test"

import {
  scheduleImmediatePostPublishFinalize,
  setCommunityJobProcessorForTests,
} from "./post-service"
import {
  setControlPlanePostgresPoolFactoryForTests,
  withRequestControlPlaneClients,
} from "../runtime-deps"
import { setBackgroundCommunityJobRepositoryForTests } from "../communities/jobs/background-job-repository"
import { getCommunityRepository } from "../communities/db-community-repository"
import type { CommunityJobRepository } from "../communities/jobs/runner-types"
import type { Env } from "../../env"

type FakePool = {
  queries: string[]
  ended: boolean
  query: (sql: string, values?: unknown[]) => Promise<{ rows: unknown[]; rowCount: number }>
  connect: () => Promise<{ query: FakePool["query"]; release: () => void }>
  end: () => Promise<void>
}

function makeFakePool(pools: FakePool[]): FakePool {
  const pool: FakePool = {
    queries: [],
    ended: false,
    async query(sql) {
      if (pool.ended) {
        throw new Error("Client was closed and is not queryable")
      }
      pool.queries.push(sql)
      return { rows: [], rowCount: 0 }
    },
    async connect() {
      return { query: pool.query, release: () => {} }
    },
    async end() {
      pool.ended = true
    },
  }
  pools.push(pool)
  return pool
}

const env = {
  CONTROL_PLANE_DATABASE_URL: "postgresql://user:pass@control-plane.test/db",
} as unknown as Env

afterEach(() => {
  setControlPlanePostgresPoolFactoryForTests(null)
  setCommunityJobProcessorForTests(null)
  setBackgroundCommunityJobRepositoryForTests(null)
})

describe("scheduleImmediatePostPublishFinalize", () => {
  test("finalize outliving the request uses a background repository, not the request-scoped one", async () => {
    const pools: FakePool[] = []
    setControlPlanePostgresPoolFactoryForTests(() => makeFakePool(pools))

    let releaseBackground!: () => void
    const backgroundGate = new Promise<void>((resolve) => {
      releaseBackground = resolve
    })
    const processed: Array<{ jobId: string; communityRepository: CommunityJobRepository }> = []
    setCommunityJobProcessorForTests(async (input) => {
      // Simulate the finalize attempt (Story mint) outliving the response,
      // then exercise the repository's control-plane client afterwards.
      await backgroundGate
      await input.communityRepository.getCommunityById(input.communityId)
      processed.push({ jobId: input.jobId, communityRepository: input.communityRepository })
      return null
    })

    let backgroundTask: Promise<void> | undefined
    let requestRepository: ReturnType<typeof getCommunityRepository> | undefined
    await withRequestControlPlaneClients(async () => {
      requestRepository = getCommunityRepository(env)
      await requestRepository.getCommunityById("cmt_request")
      scheduleImmediatePostPublishFinalize({
        env,
        communityId: "cmt_request",
        postId: "pst_request",
        jobId: "cjb_request",
        songArtifactBundleId: null,
        waitUntil: (promise) => {
          backgroundTask = promise
        },
      })
    })

    // The request scope has exited and closed its control-plane client while
    // the finalize task is still running — the production failure window.
    expect(pools[0]?.ended).toBe(true)
    expect(backgroundTask).toBeDefined()

    releaseBackground()
    await backgroundTask

    // The finalize path must have run its control-plane work on a fresh
    // background client, not the request repository's closed one.
    expect(processed).toHaveLength(1)
    expect(processed[0]!.communityRepository).not.toBe(requestRepository)
    expect(pools).toHaveLength(2)
    expect(pools[1]!.queries.length).toBeGreaterThan(0)
    // The background scope owns its client lifecycle and closed it on settle.
    expect(pools[1]!.ended).toBe(true)
  })

  test("negative control: reusing the request-scoped repository fails once the response is produced", async () => {
    const pools: FakePool[] = []
    setControlPlanePostgresPoolFactoryForTests(() => makeFakePool(pools))

    let releaseBackground!: () => void
    const backgroundGate = new Promise<void>((resolve) => {
      releaseBackground = resolve
    })
    const processed: string[] = []
    let processorError: unknown = null
    setCommunityJobProcessorForTests(async (input) => {
      await backgroundGate
      try {
        await input.communityRepository.getCommunityById(input.communityId)
      } catch (error) {
        processorError = error
        throw error
      }
      processed.push(input.jobId)
      return null
    })

    let backgroundTask: Promise<void> | undefined
    await withRequestControlPlaneClients(async () => {
      const requestRepository = getCommunityRepository(env)
      await requestRepository.getCommunityById("cmt_request")
      // Reproduce the pre-fix wiring: the background path handed the
      // request-scoped repository instead of constructing its own.
      setBackgroundCommunityJobRepositoryForTests(
        () => requestRepository as unknown as CommunityJobRepository,
      )
      scheduleImmediatePostPublishFinalize({
        env,
        communityId: "cmt_request",
        postId: "pst_request",
        jobId: "cjb_request",
        songArtifactBundleId: null,
        waitUntil: (promise) => {
          backgroundTask = promise
        },
      })
    })

    releaseBackground()
    await backgroundTask

    expect(processed).toHaveLength(0)
    expect(String(processorError)).toContain("Client was closed and is not queryable")
  })
})
