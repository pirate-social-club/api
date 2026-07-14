import type { Env } from "../../env"
import { logPipelineError, logPipelineInfo } from "../observability/pipeline-log"
import type { OpsAlert } from "./types"

const OPS_ALERT_WEBHOOK_TIMEOUT_MS = 5_000
const MAX_DETAIL_LENGTH = 900
const MAX_FAILED_COMMUNITY_DETAILS = 5

export type OpsAlertSendResult = {
  delivered: boolean
  sent: number
  sink: "none" | "log" | "email" | "webhook"
}

function shortSha(value: unknown): string | null {
  return typeof value === "string" && value.length >= 7 ? value.slice(0, 12) : null
}

function formatScalar(value: unknown): string | null {
  if (value === null || value === undefined) return null
  if (typeof value === "string") return value
  if (typeof value === "number" || typeof value === "boolean") return String(value)
  return null
}

function formatFailedCommunities(details: Record<string, unknown>): string[] {
  const value = details.failed_communities
  if (!Array.isArray(value) || value.length === 0) return []

  const lines = ["Failed communities:"]
  for (const item of value.slice(0, MAX_FAILED_COMMUNITY_DETAILS)) {
    if (!item || typeof item !== "object") continue
    const row = item as { community_id?: unknown; error?: unknown }
    const communityId = formatScalar(row.community_id) ?? "unknown_community"
    const error = formatScalar(row.error)
    lines.push(`- ${communityId}${error ? `: ${error}` : ""}`)
  }
  if (value.length > MAX_FAILED_COMMUNITY_DETAILS) {
    lines.push(`- +${value.length - MAX_FAILED_COMMUNITY_DETAILS} more`)
  }
  return lines
}

function compactDetailsJson(details: Record<string, unknown>): string {
  try {
    const serialized = JSON.stringify(details)
    return serialized.length > MAX_DETAIL_LENGTH
      ? `${serialized.slice(0, MAX_DETAIL_LENGTH)}...`
      : serialized
  } catch {
    return "[unserializable details]"
  }
}

function alertDetailsLines(alert: OpsAlert): string[] {
  const details = alert.details
  if (!details) return []

  const summaryKeys = [
    "task",
    "incident_id",
    "campaign_id",
    "incident_kind",
    "reason",
    "stored_funded_cents",
    "computed_funded_cents",
    "funded_delta_cents",
    "stored_reserved_cents",
    "computed_reserved_cents",
    "reserved_delta_cents",
    "stored_credited_cents",
    "computed_credited_cents",
    "credited_delta_cents",
    "tx_hash",
    "confirmed_block_number",
    "confirmed_block_hash",
    "checked_communities",
    "failed_posts",
    "enqueued_jobs",
    "processed_jobs",
    "failed",
    "errors",
  ]
  const lines: string[] = []
  for (const key of summaryKeys) {
    const value = formatScalar(details[key])
    if (value !== null) lines.push(`${key}: ${value}`)
  }

  const failedCommunityLines = formatFailedCommunities(details)
  if (failedCommunityLines.length > 0) {
    if (lines.length > 0) lines.push("")
    lines.push(...failedCommunityLines)
  }

  if (lines.length > 0) return lines
  return [`details: ${compactDetailsJson(details)}`]
}

function alertText(input: {
  alert: OpsAlert
  environment: string
  timestamp: string
  buildSha: string | null
}): string {
  const { alert, environment, timestamp, buildSha } = input
  const lines = [
    `[${alert.severity.toUpperCase()}][${environment}] ${alert.title}`,
    `Count: ${alert.count}`,
    `Communities: ${alert.community_ids.length}`,
    `Time: ${timestamp}`,
    ...(buildSha ? [`Deploy: ${buildSha}`] : []),
    `Key: ${alert.key}`,
  ]
  const details = alertDetailsLines(alert)
  if (details.length > 0) {
    lines.push("", "Summary:", ...details)
  }
  return lines.join("\n")
}

export async function sendOpsAlerts(env: Env, alerts: OpsAlert[]): Promise<OpsAlertSendResult> {
  if (alerts.length === 0) return { delivered: true, sent: 0, sink: "none" }
  const environment = env.ENVIRONMENT || "development"
  const timestamp = new Date().toISOString()
  const buildSha = shortSha(env.BUILD_GIT_SHA)
  const text = alerts
    .map((alert) => alertText({ alert, environment, timestamp, buildSha }))
    .join("\n\n---\n\n")
  const subject = alerts.length === 1
    ? `[Pirate ${environment}] ${alerts[0]?.title ?? "Ops alert"}`
    : `[Pirate ${environment}] ${alerts.length} ops alerts`

  const emailTo = env.OPS_ALERT_EMAIL_TO?.trim()
  const emailFrom = env.OPS_ALERT_EMAIL_FROM?.trim()
  if (env.OPS_ALERT_EMAIL && emailTo && emailFrom) {
    try {
      const response = await env.OPS_ALERT_EMAIL.send({
        to: emailTo,
        from: {
          email: emailFrom,
          name: env.OPS_ALERT_EMAIL_FROM_NAME?.trim() || "Pirate Ops",
        },
        subject,
        text,
        html: `<pre>${escapeHtml(text)}</pre>`,
      })
      logPipelineInfo("[ops-alerts] email sent", {
        count: alerts.length,
        keys: alerts.map((alert) => alert.key),
        message_id: response.messageId,
        to: emailTo,
        from: emailFrom,
      })
      return { delivered: true, sent: alerts.length, sink: "email" }
    } catch (error) {
      logPipelineError("[ops-alerts] email send threw", {
        error: error instanceof Error ? error.message : String(error),
      })
      return { delivered: false, sent: 0, sink: "email" }
    }
  }

  const url = env.OPS_ALERT_WEBHOOK_URL?.trim()
  if (!url) {
    logPipelineInfo("[ops-alerts] alerts fired without email or webhook configured", {
      count: alerts.length,
      keys: alerts.map((alert) => alert.key),
      alerts,
    })
    return { delivered: true, sent: 0, sink: "log" }
  }

  try {
    const response = await fetch(url, {
      method: "POST",
      headers: { "content-type": "application/json" },
      body: JSON.stringify({ text }),
      signal: AbortSignal.timeout(OPS_ALERT_WEBHOOK_TIMEOUT_MS),
    })
    if (!response.ok) {
      logPipelineError("[ops-alerts] webhook post failed", { status: response.status })
      return { delivered: false, sent: 0, sink: "webhook" }
    }
    return { delivered: true, sent: alerts.length, sink: "webhook" }
  } catch (error) {
    logPipelineError("[ops-alerts] webhook post threw", {
      error: error instanceof Error ? error.message : String(error),
    })
    return { delivered: false, sent: 0, sink: "webhook" }
  }
}

function escapeHtml(value: string): string {
  return value
    .replaceAll("&", "&amp;")
    .replaceAll("<", "&lt;")
    .replaceAll(">", "&gt;")
    .replaceAll('"', "&quot;")
    .replaceAll("'", "&#39;")
}
