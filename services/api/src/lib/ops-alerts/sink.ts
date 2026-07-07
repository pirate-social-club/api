import type { Env } from "../../env"
import { logPipelineError, logPipelineInfo } from "../observability/pipeline-log"
import type { OpsAlert } from "./types"

const OPS_ALERT_WEBHOOK_TIMEOUT_MS = 5_000
const MAX_DETAIL_LENGTH = 900

export type OpsAlertSendResult = {
  delivered: boolean
  sent: number
  sink: "none" | "log" | "webhook"
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
  const url = env.OPS_ALERT_WEBHOOK_URL?.trim()
  if (!url) {
    logPipelineInfo("[ops-alerts] alerts fired without webhook configured", {
      count: alerts.length,
      keys: alerts.map((alert) => alert.key),
      alerts,
    })
    return { delivered: true, sent: 0, sink: "log" }
  }

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
