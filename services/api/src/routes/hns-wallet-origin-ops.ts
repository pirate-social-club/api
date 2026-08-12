import { Hono, type Context } from "hono"

import type { Env } from "../env"
import { authenticateAdminAccessOnly } from "../lib/auth-middleware"
import { ADMIN_OPERATIONS_MANAGE_SCOPE } from "../lib/operator-credential-auth"
import { authError, badRequestError, providerUnavailable } from "../lib/errors"
import {
  hnsWalletOriginAuthorityStub,
  type HnsWalletOriginAuthoritySnapshot,
} from "../lib/hns-wallet-origin-authority-do"
import {
  readHnsWalletOriginAuthority,
  hardDenyHnsRootRouting,
  registerHnsWalletOrigin,
  revokeHnsWalletOrigin,
  type HnsWalletOriginAuthorityState,
} from "../lib/hns-wallet-origin-authority"
import { getControlPlaneClient } from "../lib/runtime-deps"

const routes = new Hono<{ Bindings: Env }>()
type HnsWalletOriginOpsContext = Context<{ Bindings: Env }>

function bodyString(body: Record<string, unknown>, field: string): string {
  const value = body[field]
  if (typeof value !== "string" || !value.trim()) {
    throw badRequestError(`${field}_required`)
  }
  return value.trim()
}

function actorId(body: Record<string, unknown>): string {
  const value = bodyString(body, "operator_actor_id")
  if (!/^[a-z][a-z0-9_]{2,63}$/u.test(value)) {
    throw badRequestError("operator_actor_id_invalid")
  }
  return value
}

async function body(c: HnsWalletOriginOpsContext): Promise<Record<string, unknown>> {
  try {
    return await c.req.json<Record<string, unknown>>()
  } catch {
    throw badRequestError("invalid_json_body")
  }
}

async function requireOpsAdmin(c: HnsWalletOriginOpsContext): Promise<void> {
  const actor = await authenticateAdminAccessOnly({
    env: c.env,
    authorization: c.req.header("authorization"),
    legacyToken: c.req.header("x-admin-token"),
    requiredScope: ADMIN_OPERATIONS_MANAGE_SCOPE,
  })
  if (!actor) throw authError("Authentication failed")
}

async function applyProjection(
  env: Env,
  snapshot: HnsWalletOriginAuthoritySnapshot,
): Promise<void> {
  const stub = hnsWalletOriginAuthorityStub(env)
  if (!stub) throw providerUnavailable("HNS wallet origin authority projection is unavailable")
  const applied = await stub.applySnapshot(snapshot)
  if (applied.authorityVersion !== snapshot.authorityVersion || applied.effective !== snapshot.effective) {
    throw providerUnavailable("HNS wallet origin authority projection did not accept the update")
  }
}

async function prepareDisabledProjection(input: {
  env: Env
  rootLabel: string
  current: HnsWalletOriginAuthorityState
  reasonCode: "revoked" | "hard_denied"
  preserveVersion: boolean
}): Promise<HnsWalletOriginAuthoritySnapshot> {
  const stub = hnsWalletOriginAuthorityStub(input.env)
  if (!stub) throw providerUnavailable("HNS wallet origin authority projection is unavailable")
  const authorityVersion = input.preserveVersion
    ? input.current.authorityVersion
    : input.current.authorityVersion + 1
  const existing = await stub.readSnapshot(input.rootLabel)
  if (
    existing?.authorityVersion === authorityVersion
    && existing.effective === false
    && existing.originHostname === input.current.originHostname
    && existing.reasonCode === input.reasonCode
  ) {
    return existing
  }
  const snapshot: HnsWalletOriginAuthoritySnapshot = {
    authorityVersion,
    effective: false,
    originHostname: input.current.originHostname,
    reasonCode: input.reasonCode,
    updatedAt: input.preserveVersion ? input.current.updatedAt : new Date().toISOString(),
  }
  await applyProjection(input.env, snapshot)
  return snapshot
}

routes.get("/:rootLabel", async (c) => {
  await requireOpsAdmin(c)
  const state = await readHnsWalletOriginAuthority(
    getControlPlaneClient(c.env),
    c.req.param("rootLabel"),
  )
  return c.json({ authority: state }, 200, { "cache-control": "no-store" })
})

routes.post("/:rootLabel/registrations", async (c) => {
  await requireOpsAdmin(c)
  const request = await body(c)
  const state = await registerHnsWalletOrigin({
    executor: getControlPlaneClient(c.env),
    rootLabel: c.req.param("rootLabel"),
    operatorActorId: actorId(request),
    registrationReference: bodyString(request, "registration_reference"),
    reason: bodyString(request, "reason"),
  })
  await applyProjection(c.env, state)
  return c.json({ authority: state }, 200, { "cache-control": "no-store" })
})

routes.post("/:rootLabel/revocations", async (c) => {
  await requireOpsAdmin(c)
  const request = await body(c)
  const operatorActorId = actorId(request)
  const client = getControlPlaneClient(c.env)
  const rootLabel = c.req.param("rootLabel")
  const current = await readHnsWalletOriginAuthority(client, rootLabel)
  if (!current) {
    // The service returns the canonical not-found response; avoid fabricating
    // a projection version for a root that has never been registered.
    await revokeHnsWalletOrigin({
      executor: client,
      rootLabel,
      operatorActorId,
      reason: bodyString(request, "reason"),
    })
    throw new Error("unreachable")
  }
  const disabled = await prepareDisabledProjection({
    env: c.env,
    rootLabel,
    current,
    reasonCode: "revoked",
    preserveVersion: current.registrationStatus === "revoked",
  })
  const now = disabled.updatedAt

  // Revoke the request-time projection before the database mutation. If the
  // database write loses a race, access remains safely withdrawn until an
  // operator reconciles the newer durable version.
  const state = await revokeHnsWalletOrigin({
    executor: client,
    rootLabel,
    operatorActorId,
    reason: bodyString(request, "reason"),
    now,
  })
  await applyProjection(c.env, state)
  return c.json({ authority: state }, 200, { "cache-control": "no-store" })
})

routes.post("/:rootLabel/hard-denials", async (c) => {
  await requireOpsAdmin(c)
  const request = await body(c)
  const client = getControlPlaneClient(c.env)
  const rootLabel = c.req.param("rootLabel")
  const operatorActorId = actorId(request)
  const reason = bodyString(request, "reason")
  const current = await readHnsWalletOriginAuthority(client, rootLabel)
  let now = new Date().toISOString()

  if (current) {
    const disabled = await prepareDisabledProjection({
      env: c.env,
      rootLabel,
      current,
      reasonCode: "hard_denied",
      preserveVersion: false,
    })
    now = disabled.updatedAt
  }
  const authority = await hardDenyHnsRootRouting({
    executor: client,
    rootLabel,
    operatorActorId,
    reason,
    now,
  })
  if (authority) await applyProjection(c.env, authority)
  return c.json({ authority, routing_hard_denied: true }, 200, {
    "cache-control": "no-store",
  })
})

export default routes
