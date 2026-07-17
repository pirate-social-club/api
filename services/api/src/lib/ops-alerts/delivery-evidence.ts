import type { DbExecutor } from "../db-helpers"
import type { OpsAlertSendResult } from "./sink"
import type { OpsAlert } from "./types"

export type OpsAlertDeliveryAttempt = {
  attemptId: string
  alertKey: string
  environment: string
  severity: OpsAlert["severity"]
  alertCount: number
  bucketStartMs: number
}

export type OpsAlertDeliveryEvidenceStore = {
  begin(input: OpsAlertDeliveryAttempt): Promise<void>
  finish(input: {
    attemptId: string
    delivery: OpsAlertSendResult
  }): Promise<void>
}

export function createOpsAlertDeliveryEvidenceStore(client: DbExecutor): OpsAlertDeliveryEvidenceStore {
  return {
    async begin(input) {
      const result = await client.execute({
        sql: `
          INSERT INTO ops_alert_delivery_attempts (
            ops_alert_delivery_attempt_id, alert_key, environment, severity,
            sink, delivery_status, alert_count, sent_count, bucket_start_ms,
            provider_message_id, created_at
          ) VALUES (?1, ?2, ?3, ?4, 'none', 'attempting', ?5, 0, ?6, NULL, ?7)
        `,
        args: [
          input.attemptId,
          input.alertKey,
          input.environment,
          input.severity,
          input.alertCount,
          input.bucketStartMs,
          new Date().toISOString(),
        ],
      })
      if ((result.rowsAffected ?? 0) !== 1) {
        throw new Error("ops_alert_delivery_evidence_begin_not_applied")
      }
    },
    async finish(input) {
      const result = await client.execute({
        sql: `
          UPDATE ops_alert_delivery_attempts
          SET sink = ?2,
              delivery_status = ?3,
              sent_count = ?4,
              provider_message_id = ?5
          WHERE ops_alert_delivery_attempt_id = ?1
            AND delivery_status = 'attempting'
        `,
        args: [
          input.attemptId,
          input.delivery.sink,
          input.delivery.delivered ? "delivered" : "failed",
          input.delivery.sent,
          input.delivery.providerMessageId,
        ],
      })
      if ((result.rowsAffected ?? 0) !== 1) {
        throw new Error("ops_alert_delivery_evidence_finish_not_applied")
      }
    },
  }
}
