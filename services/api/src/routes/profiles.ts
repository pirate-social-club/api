import { Hono } from "hono"
import type { Context } from "hono"
import { authError, badRequestError, paymentRequired, notFoundError, rateLimited } from "../lib/errors"
import { getProfileRepository, getUserRepository } from "../lib/auth/repositories"
import {
  authenticateAdminUserOrAgentDelegated,
  authenticateAdminOrUser,
  type ActorContext,
  type AdminActorContext,
  type AuthenticatedEnv,
} from "../lib/auth-middleware"
import { trackApiEvent } from "../lib/analytics/track"
import { decodePublicUserId } from "../lib/public-ids"
import { requireTrimmedStringOrNull } from "./route-helpers"
import { writeAuditEventForEnv } from "../lib/audit"
import { getControlPlaneClient } from "../lib/runtime-deps"
import { getCommunityRepository } from "../lib/communities/db-community-repository"
import { listCourtyardWalletInventoryGroups } from "../lib/communities/community-token-inventory-gates"
import {
  getProfileActivity,
  parseProfileActivityLimit,
  parseProfileActivityTab,
} from "../lib/profile/profile-activity-read-service"
import {
  serializeGlobalHandle,
  serializeHandleUpgradeQuote,
  serializeProfile,
} from "../serializers/profile"
import { serializeProfileActivityResponse } from "../serializers/profile-activity"

const profiles = new Hono<AuthenticatedEnv>()
const COURTYARD_INVENTORY_RATE_LIMIT_WINDOW_MS = 60_000
const COURTYARD_INVENTORY_RATE_LIMIT_MAX = 30
const courtyardInventoryRateLimitByUser = new Map<string, { count: number; resetAtMs: number }>()

export function resetCourtyardInventoryRateLimitForTests(): void {
  courtyardInventoryRateLimitByUser.clear()
}

function enforceCourtyardInventoryRateLimit(userId: string, nowMs = Date.now()): void {
  const current = courtyardInventoryRateLimitByUser.get(userId)
  if (!current || current.resetAtMs <= nowMs) {
    courtyardInventoryRateLimitByUser.set(userId, {
      count: 1,
      resetAtMs: nowMs + COURTYARD_INVENTORY_RATE_LIMIT_WINDOW_MS,
    })
    return
  }
  if (current.count >= COURTYARD_INVENTORY_RATE_LIMIT_MAX) {
    throw rateLimited("Too many Courtyard inventory requests. Try again shortly.")
  }
  current.count += 1
}

function normalizeSubmittedGlobalHandleQuoteId(value: string): string {
  const trimmed = value.trim()
  if (trimmed.startsWith("ghq_ghq_")) {
    return trimmed.slice("ghq_".length)
  }
  return trimmed.startsWith("ghq_") ? trimmed.slice("ghq_".length) : trimmed
}

async function getGlobalHandleQuoteUserId(env: AuthenticatedEnv["Bindings"], quote: string): Promise<string> {
  const quoteId = normalizeSubmittedGlobalHandleQuoteId(quote)
  if (!quoteId) {
    throw badRequestError("quote is required with funding_tx_ref")
  }
  const row = (await getControlPlaneClient(env).execute({
    sql: `
      SELECT user_id
      FROM global_handle_paid_quotes
      WHERE global_handle_paid_quote_id = ?1
      LIMIT 1
    `,
    args: [quoteId],
  })).rows[0]
  const userId = typeof row?.user_id === "string" ? row.user_id.trim() : ""
  if (!userId) {
    throw notFoundError("Global handle quote not found")
  }
  return userId
}

async function authenticateOptionalX402ProfileActor(
  c: Context<AuthenticatedEnv>,
): Promise<ActorContext | AdminActorContext | null> {
  const authorization = c.req.header("authorization")
  if (!authorization?.startsWith("Bearer ") && !c.req.header("x-admin-token")) {
    return null
  }
  return authenticateAdminUserOrAgentDelegated({
    allowAgentDelegated: false,
    authorization,
    env: c.env,
    xAdminAsUserId: c.req.header("x-admin-as-user-id"),
    xAdminToken: c.req.header("x-admin-token"),
  })
}

profiles.post("/me/global-handle/x402-claim", async (c) => {
  const body = await c.req.json<{
    desired_label?: unknown
    quote?: unknown
    settlement_wallet_attachment?: unknown
    funding_tx_ref?: unknown
  }>().catch(() => null)
  if (!body || typeof body !== "object") {
    throw badRequestError("Invalid x402 paid handle claim payload")
  }

  const repository = getProfileRepository(c.env)
  const fundingTxRef = typeof body.funding_tx_ref === "string" ? body.funding_tx_ref.trim() : ""
  const actor = await authenticateOptionalX402ProfileActor(c)
  if (!fundingTxRef) {
    if (!actor) {
      throw authError("Authentication failed")
    }
    if (typeof body.desired_label !== "string") {
      throw badRequestError("desired_label is required before payment")
    }
    const quote = await repository.quoteGlobalHandleUpgrade(actor.userId, body.desired_label)
    if (!quote) {
      throw authError("Authentication failed")
    }
    const challenge = serializeHandleUpgradeQuote(quote)
    if (!challenge.eligible || challenge.price_cents <= 0 || !challenge.quote || !challenge.payment_instructions) {
      return c.json(challenge, 200)
    }
    throw paymentRequired("Payment required to claim this .pirate name", {
      ...(challenge as unknown as Record<string, unknown>),
      payment_protocol: "x402",
      quote: challenge.quote,
      payment_instructions: challenge.payment_instructions as unknown as Record<string, unknown>,
    })
  }

  if (typeof body.quote !== "string" || !body.quote.trim()) {
    throw badRequestError("quote is required with funding_tx_ref")
  }
  // x402/MPP retries commonly use `Authorization: Payment ...`, which cannot
  // also carry the Pirate Bearer token. For paid retries, the quote is already
  // bound to a user and the funding proof must come from that user's wallet.
  const userId = actor?.userId ?? await getGlobalHandleQuoteUserId(c.env, body.quote)
  const settlementWalletAttachment = await resolveSettlementWalletAttachment(c.env, userId, body.settlement_wallet_attachment)
  const globalHandle = await repository.claimPaidGlobalHandle(userId, {
    quote: body.quote,
    settlement_wallet_attachment: settlementWalletAttachment,
    funding_tx_ref: fundingTxRef,
  })
  if (!globalHandle) {
    throw authError("Authentication failed")
  }
  await trackApiEvent(c.env, c.req, {
    eventName: "handle_claim_succeeded",
    userId,
    properties: {
      source: "paid_upgrade",
      tier: globalHandle.tier,
      handle_length: globalHandle.label.replace(/\.pirate$/i, "").length,
      price_cents: globalHandle.price_paid_cents ?? null,
      payment_protocol: "x402",
      authenticated_retry: actor != null,
    },
  })
  return c.json(serializeGlobalHandle(globalHandle), 200)
})

profiles.use("/me", authenticateAdminOrUser)
profiles.use("/me/*", authenticateAdminOrUser)

function requireSourceValue<T extends string>(value: unknown, field: string, allowed: readonly T[]): T | null {
  if (value === null) {
    return null
  }
  if (typeof value !== "string" || !allowed.includes(value as T)) {
    throw badRequestError(`Invalid ${field}`)
  }
  return value as T
}

function requireXmtpInboxId(value: unknown): string | null {
  if (value === null) {
    return null
  }
  if (typeof value !== "string") {
    throw badRequestError("Invalid xmtp_inbox_id")
  }
  const trimmed = value.trim()
  if (
    trimmed.length < 8
    || trimmed.length > 256
    || /\s/u.test(trimmed)
    || /[\u0000-\u001f\u007f]/u.test(trimmed)
  ) {
    throw badRequestError("Invalid xmtp_inbox_id")
  }
  return trimmed
}

async function resolveSettlementWalletAttachment(env: AuthenticatedEnv["Bindings"], userId: string, value: unknown): Promise<string | null> {
  if (typeof value === "string" && value.trim()) {
    return value.trim()
  }
  const wallets = await getUserRepository(env).getWalletAttachmentsByUserId(userId)
  return wallets.find((wallet) => wallet.is_primary)?.wallet_attachment ?? null
}

profiles.get("/me", async (c) => {
  const actor = c.get("actor")
  const repository = getProfileRepository(c.env)
  const profile = await repository.getProfileByUserId(actor.userId)
  if (!profile) {
    throw authError("Authentication failed")
  }
  return c.json(serializeProfile(profile), 200)
})

profiles.get("/me/courtyard-inventory", async (c) => {
  const actor = c.get("actor")
  enforceCourtyardInventoryRateLimit(actor.userId)
  const walletAttachments = await getUserRepository(c.env).getWalletAttachmentsByUserId(actor.userId)
  const result = await listCourtyardWalletInventoryGroups({
    env: c.env,
    walletAttachments,
  })
  return c.json(result, 200)
})

profiles.get("/me/activity", async (c) => {
  const actor = c.get("actor")
  const result = await getProfileActivity({
    env: c.env,
    profileRepository: getProfileRepository(c.env),
    repository: getCommunityRepository(c.env),
    targetUserId: actor.userId,
    viewerUserId: actor.userId,
    tab: parseProfileActivityTab(c.req.query("tab")),
    cursor: c.req.query("cursor") ?? null,
    limit: parseProfileActivityLimit(c.req.query("limit")),
    locale: c.req.query("locale") ?? null,
  })
  return c.json(serializeProfileActivityResponse(result), 200)
})

profiles.post("/me", async (c) => {
  const actor = c.get("actor")
  const body = await c.req
    .json<{
      display_name?: unknown
      avatar_ref?: unknown
      avatar_source?: unknown
      cover_ref?: unknown
      cover_source?: unknown
      bio?: unknown
      bio_source?: unknown
      preferred_locale?: unknown
      display_verified_nationality_badge?: unknown
    }>()
    .catch(() => null)
  if (!body || typeof body !== "object") {
    throw badRequestError("Invalid profile update payload")
  }

  const input: {
    display_name?: string | null
    avatar_ref?: string | null
    avatar_source?: "ens" | "upload" | "none" | null
    cover_ref?: string | null
    cover_source?: "ens" | "upload" | "none" | null
    bio?: string | null
    bio_source?: "ens" | "manual" | "none" | null
    preferred_locale?: string | null
    display_verified_nationality_badge?: boolean | null
  } = {}

  if ("display_name" in body) {
    const value = requireTrimmedStringOrNull(body.display_name, "display_name")
    if (value === null || value === "") {
      throw badRequestError("Invalid display_name")
    }
    input.display_name = value
  }
  if ("avatar_ref" in body) {
    input.avatar_ref = requireTrimmedStringOrNull(body.avatar_ref, "avatar_ref")
  }
  if ("avatar_source" in body) {
    input.avatar_source = requireSourceValue(body.avatar_source, "avatar_source", ["ens", "upload", "none"] as const)
  }
  if ("cover_ref" in body) {
    input.cover_ref = requireTrimmedStringOrNull(body.cover_ref, "cover_ref")
  }
  if ("cover_source" in body) {
    input.cover_source = requireSourceValue(body.cover_source, "cover_source", ["ens", "upload", "none"] as const)
  }
  if ("bio" in body) {
    input.bio = requireTrimmedStringOrNull(body.bio, "bio")
  }
  if ("bio_source" in body) {
    input.bio_source = requireSourceValue(body.bio_source, "bio_source", ["ens", "manual", "none"] as const)
  }
  if ("preferred_locale" in body) {
    input.preferred_locale = requireTrimmedStringOrNull(body.preferred_locale, "preferred_locale")
  }
  if ("display_verified_nationality_badge" in body) {
    if (body.display_verified_nationality_badge !== null && typeof body.display_verified_nationality_badge !== "boolean") {
      throw badRequestError("Invalid display_verified_nationality_badge")
    }
    input.display_verified_nationality_badge = body.display_verified_nationality_badge
  }

  const repository = getProfileRepository(c.env)
  const profile = await repository.updateProfile(actor.userId, input)
  if (!profile) {
    throw authError("Authentication failed")
  }
  if (actor.authType === "admin") {
    await writeAuditEventForEnv(c.env, {
      action: "community.admin_profile_updated",
      actorId: actor.adminOverride.adminActorId,
      actorType: "operator",
      targetId: actor.userId,
      targetType: "user",
      metadata: {
        acting_user_id: actor.userId,
        updated_fields: Object.keys(input),
      },
    })
  }
  return c.json(serializeProfile(profile), 200)
})

profiles.post("/me/xmtp-inbox", async (c) => {
  const actor = c.get("actor")
  const body = await c.req.json<{ xmtp_inbox?: unknown; xmtp_inbox_id?: unknown }>().catch(() => null)
  if (!body || typeof body !== "object") {
    throw badRequestError("Invalid XMTP inbox payload")
  }

  const rawValue = "xmtp_inbox" in body ? body.xmtp_inbox : body.xmtp_inbox_id
  if (!("xmtp_inbox" in body) && !("xmtp_inbox_id" in body)) {
    throw badRequestError("Invalid XMTP inbox payload")
  }

  const repository = getProfileRepository(c.env)
  const profile = await repository.updateXmtpInboxId(actor.userId, requireXmtpInboxId(rawValue))
  if (!profile) {
    throw authError("Authentication failed")
  }
  return c.json(serializeProfile(profile), 200)
})

profiles.post("/me/rename-global-handle", async (c) => {
  const actor = c.get("actor")
  const body = await c.req.json<{ desired_label?: unknown }>().catch(() => null)
  if (!body || typeof body.desired_label !== "string") {
    throw badRequestError("Invalid handle rename payload")
  }

  const repository = getProfileRepository(c.env)
  const globalHandle = await repository.renameGlobalHandle(actor.userId, body.desired_label)
  if (!globalHandle) {
    throw authError("Authentication failed")
  }
  await trackApiEvent(c.env, c.req, {
    eventName: "handle_claim_succeeded",
    userId: actor.userId,
    properties: {
      source: globalHandle.issuance_source,
      tier: globalHandle.tier,
      handle_length: globalHandle.label.replace(/\.pirate$/i, "").length,
    },
  })
  return c.json(serializeGlobalHandle(globalHandle), 200)
})

profiles.post("/me/global-handle/reddit-claim", async (c) => {
  const actor = c.get("actor")
  const body = await c.req.json<{ desired_label?: unknown }>().catch(() => null)
  if (!body || typeof body.desired_label !== "string") {
    throw badRequestError("Invalid reddit handle claim payload")
  }

  const repository = getProfileRepository(c.env)
  const globalHandle = await repository.claimRedditGlobalHandle(actor.userId, body.desired_label)
  if (!globalHandle) {
    throw authError("Authentication failed")
  }
  await trackApiEvent(c.env, c.req, {
    eventName: "handle_claim_succeeded",
    userId: actor.userId,
    properties: {
      source: "verified_reddit_username",
      tier: globalHandle.tier,
      handle_length: globalHandle.label.replace(/\.pirate$/i, "").length,
      shorter_by: Math.max(0, 8 - globalHandle.label.replace(/\.pirate$/i, "").length),
    },
  })
  return c.json(serializeGlobalHandle(globalHandle), 200)
})

profiles.post("/me/global-handle/claim", async (c) => {
  const actor = c.get("actor")
  const body = await c.req.json<{
    quote?: unknown
    settlement_wallet_attachment?: unknown
    funding_tx_ref?: unknown
  }>().catch(() => null)
  if (!body || typeof body.quote !== "string") {
    throw badRequestError("Invalid paid handle claim payload")
  }

  const repository = getProfileRepository(c.env)
  const globalHandle = await repository.claimPaidGlobalHandle(actor.userId, {
    quote: body.quote,
    settlement_wallet_attachment: typeof body.settlement_wallet_attachment === "string"
      ? body.settlement_wallet_attachment
      : null,
    funding_tx_ref: typeof body.funding_tx_ref === "string" ? body.funding_tx_ref : null,
  })
  if (!globalHandle) {
    throw authError("Authentication failed")
  }
  await trackApiEvent(c.env, c.req, {
    eventName: "handle_claim_succeeded",
    userId: actor.userId,
    properties: {
      source: "paid_upgrade",
      tier: globalHandle.tier,
      handle_length: globalHandle.label.replace(/\.pirate$/i, "").length,
      price_cents: globalHandle.price_paid_cents ?? null,
    },
  })
  return c.json(serializeGlobalHandle(globalHandle), 200)
})

profiles.post("/me/quote-handle-upgrade", async (c) => {
  const actor = c.get("actor")
  const body = await c.req.json<{ desired_label?: unknown }>().catch(() => null)
  if (!body || typeof body.desired_label !== "string") {
    throw badRequestError("Invalid handle upgrade quote payload")
  }

  const repository = getProfileRepository(c.env)
  const quote = await repository.quoteGlobalHandleUpgrade(actor.userId, body.desired_label)
  if (!quote) {
    throw authError("Authentication failed")
  }
  return c.json(serializeHandleUpgradeQuote(quote), 200)
})

profiles.post("/me/sync-linked-handles", async (c) => {
  const actor = c.get("actor")
  const repository = getProfileRepository(c.env)
  const profile = await repository.syncLinkedHandles(actor.userId)
  if (!profile) {
    throw authError("Authentication failed")
  }
  return c.json(serializeProfile(profile), 200)
})

profiles.post("/me/set-primary-public-handle", async (c) => {
  const actor = c.get("actor")
  const body = await c.req.json<{ linked_handle_id?: unknown }>().catch(() => null)
  if (!body || typeof body !== "object") {
    throw badRequestError("Invalid primary public handle payload")
  }

  const linkedHandleId = "linked_handle_id" in body
    ? requireTrimmedStringOrNull(body.linked_handle_id, "linked_handle_id")
    : null

  const repository = getProfileRepository(c.env)
  const profile = await repository.setPrimaryPublicHandle(actor.userId, linkedHandleId)
  if (!profile) {
    throw authError("Authentication failed")
  }
  return c.json(serializeProfile(profile), 200)
})

profiles.get("/:userId", async (c) => {
  const repository = getProfileRepository(c.env)
  const profile = await repository.getProfileByUserId(decodePublicUserId(c.req.param("userId")))
  if (!profile) {
    throw notFoundError("Profile not found")
  }
  return c.json(serializeProfile(profile), 200)
})

export default profiles
