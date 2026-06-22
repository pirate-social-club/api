import { describe, expect, test } from "bun:test"
import { Hono } from "hono"
import { errorResponse, HttpError } from "../../src/lib/errors"
import type { ActorContext, AdminActorContext, AuthenticatedEnv } from "../../src/lib/auth-middleware"
import { registerCommunityKaraokeSessionRoutes } from "../../src/routes/communities-karaoke-session-routes"
import type { Env } from "../../src/types"

const SIGNING_KEY = "karaoke-gateway-test-signing-key-32-characters-minimum"
const USER_ACTOR: ActorContext = { authType: "user", userId: "user-1" }
const DEVICE_ACTOR: ActorContext = { authType: "device", userId: "user-1" }
const ADMIN_ACTOR: AdminActorContext = {
  adminOverride: { adminActorId: "admin-1", scope: "full" },
  authType: "admin",
  userId: "user-1",
}
const AGENT_DELEGATED_ACTOR: ActorContext = {
  authType: "agent_delegated",
  delegatedAgentId: "agent-1",
  delegatedCredentialOwnershipRecordId: "aos-1",
  userId: "user-1",
}

function makeEnv(overrides: Partial<Env> = {}): Env {
  const namespace = {
    idFromName(name: string) { return name },
    get() {
      return { fetch: async () => new Response(null, { status: 204 }) }
    },
  }
  return {
    ENVIRONMENT: "test",
    KARAOKE_GATEWAY_SIGNING_KEY: SIGNING_KEY,
    KARAOKE_SESSION_RUNTIME: namespace as unknown as Env["KARAOKE_SESSION_RUNTIME"],
    ...overrides,
  } as unknown as Env
}

function buildApp(actor: ActorContext | AdminActorContext): Hono<AuthenticatedEnv> {
  const app = new Hono<AuthenticatedEnv>()
  app.use("*", async (c, next) => {
    c.set("actor", actor)
    await next()
  })
  app.onError((error) => {
    if (!(error instanceof HttpError)) throw error
    const response = errorResponse(error)
    return new Response(JSON.stringify(response.body), {
      headers: { "content-type": "application/json" },
      status: response.status,
    })
  })
  registerCommunityKaraokeSessionRoutes(app)
  return app
}

const VALID_IDEMPOTENCY_KEY = "5a59af75-bf63-41d7-b181-fc3620d2c7c7"
const POST_ID = "post_00000000-0000-4000-8000-000000000001"
const COMMUNITY_ID = "com_00000000-0000-4000-8000-000000000001"
const PATH = `http://pirate.test/${COMMUNITY_ID}/posts/${POST_ID}/karaoke/sessions`

async function json(response: Response): Promise<{ code: string; message: string }> {
  return await response.json() as { code: string; message: string }
}

describe("karaoke session creation route pre-conditions", () => {
  test("rejects an admin actor before consulting the runtime namespace", async () => {
    const app = buildApp(ADMIN_ACTOR)
    const response = await app.request(PATH, {
      headers: { "idempotency-key": VALID_IDEMPOTENCY_KEY },
      method: "POST",
    }, makeEnv())

    expect(response.status).toBe(403)
    const body = await json(response)
    expect(body.code).toBe("karaoke_session_actor_not_allowed")
  })

  test("rejects an agent-delegated actor before consulting the runtime namespace", async () => {
    const app = buildApp(AGENT_DELEGATED_ACTOR)
    const response = await app.request(PATH, {
      headers: { "idempotency-key": VALID_IDEMPOTENCY_KEY },
      method: "POST",
    }, makeEnv())

    expect(response.status).toBe(403)
    const body = await json(response)
    expect(body.code).toBe("karaoke_session_actor_not_allowed")
  })

  test("accepts a user actor and accepts a device actor at the pre-condition stage", async () => {
    for (const actor of [USER_ACTOR, DEVICE_ACTOR]) {
      const env = makeEnv()
      const app = buildApp(actor)
      const response = await app.request(PATH, {
        headers: { "idempotency-key": VALID_IDEMPOTENCY_KEY },
        method: "POST",
      }, env)

      expect(response.status).not.toBe(403)
      const body = await json(response)
      expect(body.code).not.toBe("karaoke_session_actor_not_allowed")
    }
  })

  test("returns 503 when the runtime namespace is not bound", async () => {
    const env = makeEnv({ KARAOKE_SESSION_RUNTIME: undefined })
    const app = buildApp(USER_ACTOR)
    const response = await app.request(PATH, {
      headers: { "idempotency-key": VALID_IDEMPOTENCY_KEY },
      method: "POST",
    }, env)

    expect(response.status).toBe(503)
    const body = await json(response)
    expect(body.code).toBe("karaoke_runtime_unavailable")
  })

  test("returns 503 when the gateway signing key is missing", async () => {
    const env = makeEnv({ KARAOKE_GATEWAY_SIGNING_KEY: "" })
    const app = buildApp(USER_ACTOR)
    const response = await app.request(PATH, {
      headers: { "idempotency-key": VALID_IDEMPOTENCY_KEY },
      method: "POST",
    }, env)

    expect(response.status).toBe(503)
    const body = await json(response)
    expect(body.code).toBe("karaoke_runtime_unavailable")
  })

  test("returns 503 when the gateway signing key is shorter than 32 characters", async () => {
    const env = makeEnv({ KARAOKE_GATEWAY_SIGNING_KEY: "too-short" })
    const app = buildApp(USER_ACTOR)
    const response = await app.request(PATH, {
      headers: { "idempotency-key": VALID_IDEMPOTENCY_KEY },
      method: "POST",
    }, env)

    expect(response.status).toBe(503)
    const body = await json(response)
    expect(body.code).toBe("karaoke_runtime_unavailable")
  })

  test("returns 400 when the Idempotency-Key header is missing", async () => {
    const env = makeEnv()
    const app = buildApp(USER_ACTOR)
    const response = await app.request(PATH, { method: "POST" }, env)

    expect(response.status).toBe(400)
    const body = await json(response)
    expect(body.code).toBe("bad_request")
    expect(body.message).toMatch(/idempotency/i)
  })

  test("returns 400 when the Idempotency-Key is not a UUID", async () => {
    const env = makeEnv()
    const app = buildApp(USER_ACTOR)
    const response = await app.request(PATH, {
      headers: { "idempotency-key": "not-a-uuid" },
      method: "POST",
    }, env)

    expect(response.status).toBe(400)
    const body = await json(response)
    expect(body.code).toBe("bad_request")
    expect(body.message).toMatch(/idempotency/i)
  })

  test("returns 400 when the Idempotency-Key is whitespace", async () => {
    const env = makeEnv()
    const app = buildApp(USER_ACTOR)
    const response = await app.request(PATH, {
      headers: { "idempotency-key": "   " },
      method: "POST",
    }, env)

    expect(response.status).toBe(400)
    const body = await json(response)
    expect(body.code).toBe("bad_request")
  })
})
