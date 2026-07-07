import type { Env } from "../../env"
import { logPipelineError, logPipelineInfo } from "../observability/pipeline-log"
import type { OpsAlert } from "./types"

const OPS_ALERT_WEBHOOK_TIMEOUT_MS = 5_000
const MAX_DETAIL_LENGTH = 900

export type OpsAlertSendResult = {
  delivered: boolean
  sent: number
  sink: "none" | "log" | "email" | "webhook"
}

function alertDetailsText(alert: OpsAlert): string {
  if (!alert.details) return ""
  try {
    const serialized = JSON.stringify(alert.details)
    return serialized.length > MAX_DETAIL_LENGTH
      ? `${serialized.slice(0, MAX_DETAIL_LENGTH)}...`
      : serialized
  } catch {
    return "[unserializable details]"
  }
}

export async function sendOpsAlerts(env: Env, alerts: OpsAlert[]): Promise<OpsAlertSendResult> {
  if (alerts.length === 0) return { delivered: true, sent: 0, sink: "none" }
  const environment = env.ENVIRONMENT || "development"
  const text = alerts
    .map((alert) => {
      const details = alertDetailsText(alert)
      return [
        `[${alert.severity.toUpperCase()}][${environment}] ${alert.title} - ${alert.count} across ${alert.community_ids.length} community(ies)`,
        details ? `details: ${details}` : "",
      ].filter(Boolean).join("\n")
    })
    .join("\n")
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
