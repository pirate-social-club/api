import { createHash } from "node:crypto"

import type { Env } from "../../env"
import { getControlPlaneClient } from "../runtime-deps"
import { rowValue, stringOrNull } from "../sql-row"
import type { Client } from "../sql-client"
import { finalizeDanceAttempt } from "./attempt-finalize-service"

function stableJson(value: Record<string, unknown>): string {
  return `{${Object.keys(value).sort().map((key) =>
    `${JSON.stringify(key)}:${JSON.stringify(value[key])}`
  ).join(",")}}`
}

export async function terminalizeExhaustedDanceAttempts(input: {
  env: Env
  client?: Client
  now?: Date
  limit?: number
}): Promise<{ terminalized: number; failed: number }> {
  const client = input.client ?? getControlPlaneClient(input.env)
  const now = input.now ?? new Date()
  const completedAt = Math.floor(now.getTime() / 1000)
  const rows = await client.execute({
    sql: `
      SELECT dance_attempt_session_id
      FROM dance_attempt_sessions
      WHERE status = 'grading'
        AND grading_dispatch_attempt_count >= 5
        AND grading_next_dispatch_at <= ?1
      ORDER BY grading_next_dispatch_at, created_at
      LIMIT ?2
    `,
    args: [now.toISOString(), Math.max(1, Math.min(input.limit ?? 5, 20))],
  })
  const summary = { terminalized: 0, failed: 0 }
  for (const row of rows.rows) {
    const sessionId = stringOrNull(rowValue(row, "dance_attempt_session_id"))
    if (!sessionId) continue
    const digestPayload = {
      completed_at: completedAt,
      outcome: "failed",
      reason: "scoring_unavailable",
      subject: sessionId,
    }
    const resultDigest = createHash("sha256")
      .update(stableJson(digestPayload))
      .digest("hex")
    try {
      await finalizeDanceAttempt({
        env: input.env,
        sessionId,
        facts: {
          outcome: "failed",
          reason: "scoring_unavailable",
          completedAt,
          resultDigest,
        },
        now: now.toISOString(),
      })
      summary.terminalized += 1
    } catch (error) {
      summary.failed += 1
      console.error("[dance-attempts] exhausted attempt terminalization failed", {
        session_id: sessionId,
        error,
      })
    }
  }
  return summary
}
