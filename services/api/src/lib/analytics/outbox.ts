import type { Env } from "../../env"
import type { DbExecutor } from "../db-helpers"
import { buildAnalyticsEvent, isAnalyticsEnabled, type AnalyticsEvent, type AnalyticsEventInput } from "./events"

type AnalyticsFlushResult = {
  attempted: number
  sent: number
  failed: number
}

type AnalyticsOutboxRow = {
  analytics_event_id: string
  event_name: string
  event_version: number
  event_time: string
  received_at: string
  environment: string
  source: string
  app_surface: string
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

function nowIso(): string {
  return new Date().toISOString()
}

function outboxRowToEvent(row: AnalyticsOutboxRow): AnalyticsEvent {
  return {
    event_id: row.analytics_event_id,
    event_name: row.event_name as AnalyticsEvent["event_name"],
    event_version: Number(row.event_version),
    event_time: row.event_time,
    received_at: row.received_at,
    environment: row.environment,
    source: row.source as AnalyticsEvent["source"],
    app_surface: row.app_surface as AnalyticsEvent["app_surface"],
    session_id: row.session_id,
    anonymous_id: row.anonymous_id,
    user_id_hash: row.user_id_hash,
    community_id: row.community_id,
    post_id: row.post_id,
    comment_id: row.comment_id,
    listing_id: row.listing_id,
    quote_id: row.quote_id,
    purchase_id: row.purchase_id,
    verification_session_id: row.verification_session_id,
    request_id: row.request_id,
    idempotency_key: row.idempotency_key,
    properties_json: row.properties_json,
  }
}

export async function enqueueAnalyticsEvent(db: DbExecutor, event: AnalyticsEvent): Promise<void> {
  const now = nowIso()
  await db.execute({
    sql: `
      INSERT INTO analytics_outbox (
        analytics_event_id,
        event_name,
        event_version,
        event_time,
        received_at,
        environment,
        source,
        app_surface,
        session_id,
        anonymous_id,
        user_id_hash,
        community_id,
        post_id,
        comment_id,
        listing_id,
        quote_id,
        purchase_id,
        verification_session_id,
        request_id,
        idempotency_key,
        properties_json,
        status,
        attempt_count,
        next_attempt_at,
        created_at,
        updated_at
      ) VALUES (
        ?1, ?2, ?3, ?4, ?5, ?6, ?7, ?8, ?9, ?10,
        ?11, ?12, ?13, ?14, ?15, ?16, ?17, ?18, ?19, ?20,
        ?21, 'pending', 0, ?22, ?23, ?24
      )
      ON CONFLICT (analytics_event_id) DO NOTHING
    `,
    args: [
      event.event_id,
      event.event_name,
      event.event_version,
      event.event_time,
      event.received_at,
      event.environment,
      event.source,
      event.app_surface,
      event.session_id,
      event.anonymous_id,
      event.user_id_hash,
      event.community_id,
      event.post_id,
      event.comment_id,
      event.listing_id,
      event.quote_id,
      event.purchase_id,
      event.verification_session_id,
      event.request_id,
      event.idempotency_key,
      event.properties_json,
      now,
      now,
      now,
    ],
  })
}

export async function trackServerEvent(
  env: Env,
  db: DbExecutor,
  input: AnalyticsEventInput,
): Promise<void> {
  if (!isAnalyticsEnabled(env)) {
    return
  }

  try {
    const event = await buildAnalyticsEvent(env, input)
    await enqueueAnalyticsEvent(db, event)
  } catch (error) {
    console.error("[analytics] failed to enqueue event", {
      eventName: input.eventName,
      message: error instanceof Error ? error.message : String(error),
    })
  }
}

function tinybirdEventsUrl(env: Env): string {
  const host = String(env.TINYBIRD_HOST || "https://api.tinybird.co").replace(/\/+$/, "")
  const datasource = encodeURIComponent(String(env.TINYBIRD_EVENTS_DATASOURCE || "analytics_events_raw"))
  return `${host}/v0/events?name=${datasource}`
}

function tinybirdToken(env: Env): string {
  return String(env.TINYBIRD_INGEST_TOKEN || "").trim()
}

function toNdjson(events: AnalyticsEvent[]): string {
  return events.map((event) => JSON.stringify(event)).join("\n")
}

async function updateOutboxRows(
  db: DbExecutor,
  ids: string[],
  status: "sending" | "sent" | "failed",
  options: {
    error?: string | null
    tinybirdStatusCode?: number | null
    sentAt?: string | null
  } = {},
): Promise<void> {
  if (ids.length === 0) {
    return
  }

  const now = nowIso()
  for (const id of ids) {
    await db.execute({
      sql: `
        UPDATE analytics_outbox
        SET
          status = ?1,
          attempt_count = CASE WHEN ?1 = 'failed' THEN attempt_count + 1 ELSE attempt_count END,
          next_attempt_at = CASE WHEN ?1 = 'failed' THEN ?2 ELSE next_attempt_at END,
          last_error = ?3,
          tinybird_status_code = ?4,
          sent_at = ?5,
          updated_at = ?6
        WHERE analytics_event_id = ?7
      `,
      args: [
        status,
        new Date(Date.now() + 60_000).toISOString(),
        options.error ?? null,
        options.tinybirdStatusCode ?? null,
        options.sentAt ?? null,
        now,
        id,
      ],
    })
  }
}

export async function flushAnalyticsOutbox(
  env: Env,
  db: DbExecutor,
  options: { limit?: number } = {},
): Promise<AnalyticsFlushResult> {
  if (!isAnalyticsEnabled(env)) {
    return { attempted: 0, sent: 0, failed: 0 }
  }

  const token = tinybirdToken(env)
  if (!token) {
    throw new Error("TINYBIRD_INGEST_TOKEN is required to flush analytics events")
  }

  const limit = Math.max(1, Math.min(options.limit ?? 500, 1000))
  const now = nowIso()
  const staleSendingBefore = new Date(Date.now() - 5 * 60_000).toISOString()
  const result = await db.execute({
    sql: `
      SELECT
        analytics_event_id,
        event_name,
        event_version,
        event_time,
        received_at,
        environment,
        source,
        app_surface,
        session_id,
        anonymous_id,
        user_id_hash,
        community_id,
        post_id,
        comment_id,
        listing_id,
        quote_id,
        purchase_id,
        verification_session_id,
        request_id,
        idempotency_key,
        properties_json
      FROM analytics_outbox
      WHERE (
        status IN ('pending', 'failed')
        AND next_attempt_at <= ?1
      ) OR (
        status = 'sending'
        AND updated_at <= ?3
      )
      ORDER BY created_at ASC
      LIMIT ?2
    `,
    args: [now, limit, staleSendingBefore],
  })

  const rows = result.rows as unknown as AnalyticsOutboxRow[]
  const ids = rows.map((row) => row.analytics_event_id)
  if (rows.length === 0) {
    return { attempted: 0, sent: 0, failed: 0 }
  }

  await updateOutboxRows(db, ids, "sending")

  const events = rows.map(outboxRowToEvent)
  let response: Response
  try {
    response = await fetch(tinybirdEventsUrl(env), {
      method: "POST",
      headers: {
        authorization: `Bearer ${token}`,
        "content-type": "application/x-ndjson",
      },
      body: toNdjson(events),
    })
  } catch (error) {
    await updateOutboxRows(db, ids, "failed", {
      error: (error instanceof Error ? error.message : String(error)).slice(0, 500),
    })
    return { attempted: rows.length, sent: 0, failed: rows.length }
  }

  if (response.ok) {
    await updateOutboxRows(db, ids, "sent", {
      tinybirdStatusCode: response.status,
      sentAt: nowIso(),
    })
    return { attempted: rows.length, sent: rows.length, failed: 0 }
  }

  const errorText = await response.text().catch(() => "")
  await updateOutboxRows(db, ids, "failed", {
    tinybirdStatusCode: response.status,
    error: errorText.slice(0, 500),
  })
  return { attempted: rows.length, sent: 0, failed: rows.length }
}
