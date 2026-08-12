import { afterEach, describe, expect, it } from "bun:test"
import {
  getControlPlaneClient,
  setControlPlanePostgresPoolFactoryForTests,
  withBackgroundControlPlaneClients,
  withRequestControlPlaneClients,
} from "./runtime-deps"
import type { Env } from "../env"

const CONTROL_PLANE_URL = "postgres://user:pw@control-plane.test/db"

type FakePool = {
  id: number
  ended: boolean
  endCalls: number
  queries: string[]
  query: (text: string) => Promise<{ rows: unknown[]; rowCount: number }>
  connect: () => Promise<never>
  end: () => Promise<void>
}

const pools: FakePool[] = []

function installFakePoolFactory(): void {
  let nextId = 0
  setControlPlanePostgresPoolFactoryForTests(() => {
    const pool: FakePool = {
      id: (nextId += 1),
      ended: false,
      endCalls: 0,
      queries: [],
      query: async (text: string) => {
        if (pool.ended) {
          throw new Error(`pool ${pool.id} is closed`)
        }
        pool.queries.push(text)
        return { rows: [], rowCount: 0 }
      },
      connect: async () => {
        throw new Error("not used by these tests")
      },
      end: async () => {
        pool.endCalls += 1
        pool.ended = true
      },
    }
    pools.push(pool)
    return pool as unknown as ReturnType<NonNullable<Parameters<typeof setControlPlanePostgresPoolFactoryForTests>[0]>>
  })
}

function testEnv(): Env {
  return { CONTROL_PLANE_DATABASE_URL: CONTROL_PLANE_URL, ENVIRONMENT: "test" } as unknown as Env
}

function deferred<T>(): { promise: Promise<T>; resolve: (value: T) => void } {
  let resolve!: (value: T) => void
  const promise = new Promise<T>((res) => {
    resolve = res
  })
  return { promise, resolve }
}

afterEach(() => {
  setControlPlanePostgresPoolFactoryForTests(null)
  pools.length = 0
})

describe("withBackgroundControlPlaneClients", () => {
  it("keeps its client usable after the enclosing request scope closes, then closes it exactly once", async () => {
    installFakePoolFactory()
    const env = testEnv()

    const backgroundStarted = deferred<void>()
    const releaseBackground = deferred<void>()
    let backgroundPoolId: number | null = null
    let requestPoolId: number | null = null
    let queryAfterRequestClosed: unknown = null

    // Mirrors the real shape: a request-scoped middleware wraps the handler, the
    // handler schedules background work via waitUntil, and the middleware's scope
    // settles (closing its clients) while the background work is still running.
    let background!: Promise<void>
    await withRequestControlPlaneClients(async () => {
      const requestClient = getControlPlaneClient(env)
      await requestClient.execute("SELECT 1 -- request")
      requestPoolId = pools[0]!.id

      background = withBackgroundControlPlaneClients(async () => {
        const backgroundClient = getControlPlaneClient(env)
        backgroundPoolId = pools[pools.length - 1]!.id
        backgroundStarted.resolve()
        await releaseBackground.promise
        // The request scope has fully closed by this point.
        queryAfterRequestClosed = await backgroundClient.execute("SELECT 1 -- background")
      })

      await backgroundStarted.promise
    })

    // Request scope has closed its own client...
    const requestPool = pools.find((pool) => pool.id === requestPoolId)!
    expect(requestPool.ended).toBe(true)

    // ...and the background task owns a DIFFERENT one that is still open.
    expect(backgroundPoolId).not.toBe(requestPoolId)
    const backgroundPool = pools.find((pool) => pool.id === backgroundPoolId)!
    expect(backgroundPool.ended).toBe(false)

    releaseBackground.resolve()
    await background

    expect(queryAfterRequestClosed).toEqual({ rows: [], rowsAffected: 0, lastInsertRowid: undefined })
    expect(backgroundPool.queries).toEqual(["SELECT 1 -- background"])
    expect(backgroundPool.ended).toBe(true)
    expect(backgroundPool.endCalls).toBe(1)
  })

  it("closes its client exactly once when the background operation throws", async () => {
    installFakePoolFactory()
    const env = testEnv()

    await expect(withBackgroundControlPlaneClients(async () => {
      getControlPlaneClient(env)
      throw new Error("background boom")
    })).rejects.toThrow("background boom")

    expect(pools).toHaveLength(1)
    expect(pools[0]!.ended).toBe(true)
    expect(pools[0]!.endCalls).toBe(1)
  })

  it("still joins an enclosing scope for withRequestControlPlaneClients (nested request work shares one client)", async () => {
    installFakePoolFactory()
    const env = testEnv()

    await withRequestControlPlaneClients(async () => {
      await getControlPlaneClient(env).execute("SELECT 1 -- outer")
      await withRequestControlPlaneClients(async () => {
        await getControlPlaneClient(env).execute("SELECT 1 -- inner")
      })
      // The nested call must NOT have closed the shared client.
      expect(pools[0]!.ended).toBe(false)
    })

    expect(pools).toHaveLength(1)
    expect(pools[0]!.queries).toEqual(["SELECT 1 -- outer", "SELECT 1 -- inner"])
    expect(pools[0]!.endCalls).toBe(1)
  })
})
