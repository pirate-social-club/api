import { bytesToHex } from "../crypto"
import type { Env } from "../../env"

const encoder = new TextEncoder()

export type AnalyticsSource = "web" | "api" | "job" | "backfill"
export type AnalyticsAppSurface = "web" | "api" | "worker"

export type AnalyticsEventName =
  | "page_viewed"
  | "auth_started"
  | "auth_session_exchanged"
  | "unique_human_verification_started"
  | "unique_human_verification_succeeded"
  | "unique_human_verification_failed"
  | "reddit_verification_started"
  | "reddit_verification_code_generated"
  | "reddit_verification_check_pending"
  | "reddit_verification_succeeded"
  | "reddit_verification_failed"
  | "reddit_import_queued"
  | "reddit_import_started"
  | "reddit_import_succeeded"
  | "reddit_import_failed"
  | "handle_claim_started"
  | "handle_claim_failed"
  | "handle_claim_succeeded"
  | "onboarding_completed"
  | "onboarding_skipped"
  | "home_feed_viewed"
  | "community_viewed"
  | "community_followed"
  | "community_join_requested"
  | "community_join_succeeded"
  | "post_composer_opened"
  | "post_created"
  | "comment_created"
  | "post_voted"
  | "comment_voted"
  | "thread_viewed"
  | "community_create_started"
  | "community_create_submitted"
  | "namespace_verification_started"
  | "namespace_verification_succeeded"
  | "namespace_verification_failed"
  | "community_provisioning_requested"
  | "community_provisioning_succeeded"
  | "community_provisioning_failed"
  | "registry_publication_succeeded"
  | "registry_publication_failed"
  | "listing_viewed"
  | "purchase_quote_requested"
  | "purchase_quote_created"
  | "purchase_quote_failed"
  | "checkout_started"
  | "funding_route_selected"
  | "purchase_submitted"
  | "purchase_confirmed"
  | "purchase_failed"
  | "entitlement_granted"
  | "asset_accessed"
  | "donation_selected"
  | "gate_check_failed"
  | "report_submitted"
  | "moderation_case_opened"
  | "moderation_action_taken"
  | "moderation_action_reversed"
  | "notification_generated"
  | "notification_inbox_viewed"
  | "notification_opened"
  | "notification_marked_read"
  | "notification_task_dismissed"
  | "pwa_install_promo_viewed"
  | "pwa_install_prompt_opened"
  | "pwa_install_prompt_accepted"
  | "pwa_install_prompt_dismissed"
  | "pwa_install_promo_dismissed"
  | "pwa_installed"

export type AnalyticsEvent = {
  event_id: string
  event_name: AnalyticsEventName
  event_version: number
  event_time: string
  received_at: string
  environment: string
  source: AnalyticsSource
  app_surface: AnalyticsAppSurface
  session_id: string
  anonymous_id: string
  user_id_hash: string
  community_id: string
  post_id: string
  comment_id: string
  listing_id: string
  quote_id: string
  purchase_id: string
  verification_session_id: string
  request_id: string
  idempotency_key: string
  properties_json: string
}

export type AnalyticsEventInput = {
  eventName: AnalyticsEventName
  eventVersion?: number
  eventId?: string
  eventTime?: Date | string
  receivedAt?: Date | string
  environment?: string
  source: AnalyticsSource
  appSurface: AnalyticsAppSurface
  sessionId?: string | null
  anonymousId?: string | null
  userId?: string | null
  userIdHash?: string | null
  communityId?: string | null
  postId?: string | null
  commentId?: string | null
  listingId?: string | null
  quoteId?: string | null
  purchaseId?: string | null
  verificationSessionId?: string | null
  requestId?: string | null
  idempotencyKey?: string | null
  properties?: Record<string, unknown> | null
}

function nowIso(): string {
  return new Date().toISOString()
}

function toIso(value: Date | string | undefined, fallback: string): string {
  if (!value) return fallback
  return value instanceof Date ? value.toISOString() : value
}

function optionalString(value: string | null | undefined): string {
  return value ? value : ""
}

export function isAnalyticsEnabled(env: Env): boolean {
  const value = String(env.ANALYTICS_ENABLED || "").trim().toLowerCase()
  if (value === "0" || value === "false" || value === "no") {
    return false
  }
  if (!value && analyticsEnvironment(env) === "production") {
    return true
  }
  return value === "1" || value === "true" || value === "yes"
}

export function analyticsEnvironment(env: Env): string {
  const environment = String(env.ENVIRONMENT || "development").trim()
  if (environment === "production" || environment === "staging" || environment === "development") {
    return environment
  }
  return "development"
}

export async function hmacUserId(env: Env, userId: string): Promise<string> {
  const secret = String(env.ANALYTICS_HMAC_SECRET || "").trim()
  if (!secret) {
    throw new Error("ANALYTICS_HMAC_SECRET is required when hashing analytics user ids")
  }

  const key = await crypto.subtle.importKey(
    "raw",
    encoder.encode(secret),
    { name: "HMAC", hash: "SHA-256" },
    false,
    ["sign"],
  )
  const signature = await crypto.subtle.sign("HMAC", key, encoder.encode(userId))
  return bytesToHex(new Uint8Array(signature))
}

export async function buildAnalyticsEvent(env: Env, input: AnalyticsEventInput): Promise<AnalyticsEvent> {
  const now = nowIso()
  const userIdHash = input.userIdHash
    ? input.userIdHash
    : input.userId
      ? await hmacUserId(env, input.userId)
      : ""

  return {
    event_id: input.eventId ?? `evt_${crypto.randomUUID().replace(/-/g, "")}`,
    event_name: input.eventName,
    event_version: input.eventVersion ?? 1,
    event_time: toIso(input.eventTime, now),
    received_at: toIso(input.receivedAt, now),
    environment: input.environment ?? analyticsEnvironment(env),
    source: input.source,
    app_surface: input.appSurface,
    session_id: optionalString(input.sessionId),
    anonymous_id: optionalString(input.anonymousId),
    user_id_hash: userIdHash,
    community_id: optionalString(input.communityId),
    post_id: optionalString(input.postId),
    comment_id: optionalString(input.commentId),
    listing_id: optionalString(input.listingId),
    quote_id: optionalString(input.quoteId),
    purchase_id: optionalString(input.purchaseId),
    verification_session_id: optionalString(input.verificationSessionId),
    request_id: optionalString(input.requestId),
    idempotency_key: optionalString(input.idempotencyKey),
    properties_json: JSON.stringify(input.properties ?? {}),
  }
}
