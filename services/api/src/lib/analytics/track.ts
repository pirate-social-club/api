import { badRequestError } from "../errors"
import { getControlPlaneClient } from "../runtime-deps"
import { authenticateUserToken } from "../auth-middleware"
import {
  isAnalyticsEnabled,
  trackServerEvent,
  type AnalyticsEventInput,
  type AnalyticsEventName,
} from "."
import type { Env } from "../../types"

type AnalyticsRequest = {
  header(name: string): string | undefined
}

type RequestContextInput = {
  sessionId?: string | null
  anonymousId?: string | null
  requestId?: string | null
}

type ClientAnalyticsBody = RequestContextInput & {
  event_id?: string | null
  event_name?: string | null
  event_time?: string | null
  session_id?: string | null
  anonymous_id?: string | null
  request_id?: string | null
  idempotency_key?: string | null
  community_id?: string | null
  post_id?: string | null
  comment_id?: string | null
  listing_id?: string | null
  quote_id?: string | null
  purchase_id?: string | null
  verification_session_id?: string | null
  properties?: Record<string, unknown> | null
}

const clientEventNames = new Set<AnalyticsEventName>([
  "page_viewed",
  "auth_started",
  "unique_human_verification_started",
  "reddit_verification_started",
  "handle_claim_started",
  "home_feed_viewed",
  "community_viewed",
  "community_join_requested",
  "post_composer_opened",
  "thread_viewed",
  "community_create_started",
  "listing_viewed",
  "purchase_quote_requested",
  "checkout_started",
  "funding_route_selected",
  "asset_accessed",
  "donation_selected",
  "notification_inbox_viewed",
  "notification_opened",
  "notification_marked_read",
  "pwa_install_promo_viewed",
  "pwa_install_prompt_opened",
  "pwa_install_prompt_accepted",
  "pwa_install_prompt_dismissed",
  "pwa_install_promo_dismissed",
  "pwa_installed",
])

const propertyAllowlist: Partial<Record<AnalyticsEventName, readonly string[]>> = {
  page_viewed: ["pathname", "referrer_host", "utm_source", "utm_campaign"],
  auth_started: ["provider"],
  unique_human_verification_started: ["provider", "intent"],
  reddit_verification_started: ["surface"],
  handle_claim_started: ["surface", "source", "handle_length"],
  home_feed_viewed: ["sort", "page_depth"],
  community_viewed: ["tab"],
  community_join_requested: ["membership_mode", "status"],
  post_composer_opened: ["entrypoint", "post_type"],
  thread_viewed: ["entrypoint"],
  community_create_started: ["membership_mode", "database_region", "tld"],
  listing_viewed: ["asset_kind"],
  purchase_quote_requested: ["asset_kind"],
  checkout_started: ["funding_destination"],
  funding_route_selected: ["funding_destination", "source_chain"],
  asset_accessed: ["asset_kind"],
  donation_selected: ["donation_mode"],
  notification_opened: [
    "notification_kind",
    "notification_type",
    "task_type",
    "task_persistence",
    "open_surface",
    "task_auto_cleared_on_open",
  ],
  notification_marked_read: [
    "notification_kind",
    "notification_type",
    "read_mode",
    "open_surface",
    "count",
  ],
  pwa_install_promo_viewed: ["surface", "trigger", "unread_count_bucket"],
  pwa_install_prompt_opened: ["surface", "platform"],
  pwa_install_prompt_accepted: ["surface"],
  pwa_install_prompt_dismissed: ["surface"],
  pwa_install_promo_dismissed: ["surface", "dismiss_reason"],
  pwa_installed: ["surface"],
}

function optionalString(value: unknown): string | null {
  return typeof value === "string" && value.trim() ? value.trim() : null
}

function requestHeader(req: AnalyticsRequest, name: string): string | null {
  return optionalString(req.header(name))
}

export function analyticsRequestContext(req: AnalyticsRequest, input: RequestContextInput = {}) {
  return {
    sessionId: optionalString(input.sessionId) ?? requestHeader(req, "x-pirate-session-id"),
    anonymousId: optionalString(input.anonymousId) ?? requestHeader(req, "x-pirate-anonymous-id"),
    requestId:
      optionalString(input.requestId)
      ?? requestHeader(req, "x-request-id")
      ?? requestHeader(req, "cf-ray")
      ?? `req_${crypto.randomUUID().replace(/-/g, "")}`,
  }
}

function safePropertyValue(value: unknown): string | number | boolean | null {
  if (typeof value === "string") {
    return value.slice(0, 160)
  }
  if (typeof value === "number" && Number.isFinite(value)) {
    return value
  }
  if (typeof value === "boolean") {
    return value
  }
  return null
}

function sanitizeProperties(eventName: AnalyticsEventName, properties: Record<string, unknown> | null | undefined): Record<string, unknown> {
  const allowed = propertyAllowlist[eventName] ?? []
  if (!properties || allowed.length === 0) {
    return {}
  }

  const sanitized: Record<string, unknown> = {}
  for (const key of allowed) {
    if (!(key in properties)) {
      continue
    }
    const value = safePropertyValue(properties[key])
    if (value != null) {
      sanitized[key] = value
    }
  }
  return sanitized
}

export async function optionalAnalyticsUserId(env: Env, req: AnalyticsRequest): Promise<string | null> {
  const authorization = req.header("authorization")
  if (!authorization?.trim()) {
    return null
  }

  const token = authorization.replace(/^Bearer\s+/i, "").trim()
  if (!token) {
    return null
  }

  try {
    return (await authenticateUserToken({ env, token })).userId
  } catch {
    return null
  }
}

export async function trackApiEvent(
  env: Env,
  req: AnalyticsRequest,
  input: Omit<AnalyticsEventInput, "source" | "appSurface" | "requestId" | "sessionId" | "anonymousId"> & RequestContextInput,
): Promise<void> {
  if (!isAnalyticsEnabled(env)) {
    return
  }

  const db = getControlPlaneClient(env)
  const context = analyticsRequestContext(req, input)
  try {
    await trackServerEvent(env, db, {
      ...input,
      source: "api",
      appSurface: "api",
      sessionId: context.sessionId,
      anonymousId: context.anonymousId,
      requestId: context.requestId,
    })
  } catch (error) {
    console.error("[analytics] track api event failed", {
      eventName: input.eventName,
      error,
    })
  } finally {
    db.close?.()
  }
}

export async function trackClientEvent(env: Env, req: AnalyticsRequest, body: ClientAnalyticsBody): Promise<void> {
  const eventName = optionalString(body.event_name) as AnalyticsEventName | null
  if (!eventName || !clientEventNames.has(eventName)) {
    throw badRequestError("Unsupported analytics event")
  }

  if (!isAnalyticsEnabled(env)) {
    return
  }

  const userId = await optionalAnalyticsUserId(env, req)
  const db = getControlPlaneClient(env)
  const context = analyticsRequestContext(req, body)
  try {
    await trackServerEvent(env, db, {
      eventId: optionalString(body.event_id) ?? undefined,
      eventName,
      eventTime: optionalString(body.event_time) ?? undefined,
      source: "web",
      appSurface: "web",
      sessionId: optionalString(body.session_id) ?? context.sessionId,
      anonymousId: optionalString(body.anonymous_id) ?? context.anonymousId,
      userId,
      communityId: optionalString(body.community_id),
      postId: optionalString(body.post_id),
      commentId: optionalString(body.comment_id),
      listingId: optionalString(body.listing_id),
      quoteId: optionalString(body.quote_id),
      purchaseId: optionalString(body.purchase_id),
      verificationSessionId: optionalString(body.verification_session_id),
      requestId: optionalString(body.request_id) ?? context.requestId,
      idempotencyKey: optionalString(body.idempotency_key),
      properties: sanitizeProperties(eventName, body.properties),
    })
  } finally {
    db.close?.()
  }
}
