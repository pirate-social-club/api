import { captureException } from "@sentry/cloudflare"
import type { Transaction } from "./sql-client"

export async function safeRollback(tx: Pick<Transaction, "rollback">, message: string): Promise<void> {
  try {
    await tx.rollback()
  } catch (rollbackError) {
    console.error(message, rollbackError)
    captureException(rollbackError, {
      tags: {
        rollback_failed: "true",
      },
      extra: {
        rollback_message: message,
      },
    })
  }
}
