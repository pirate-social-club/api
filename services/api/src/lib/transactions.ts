import { logPipelineError } from "./observability/pipeline-log"
import type { Client, Transaction } from "./sql-client"

/**
 * Run `fn` inside a database transaction, committing on success and rolling
 * back (via {@link safeRollback}) on any thrown error. The transaction is
 * always closed before returning. Callers remain responsible for the lifecycle
 * of the owning client/connection.
 *
 * Use this for the common "open tx → do work → commit, else rollback" shape.
 * Flows that need to roll back and return a value on a non-error branch should
 * keep managing the transaction by hand.
 */
export async function withTransaction<T>(
  client: Pick<Client, "transaction">,
  mode: "read" | "write",
  fn: (tx: Transaction) => Promise<T>,
): Promise<T> {
  const tx = await client.transaction(mode)
  try {
    const result = await fn(tx)
    await tx.commit()
    return result
  } catch (error) {
    await safeRollback(tx, "withTransaction rollback failed")
    throw error
  } finally {
    tx.close()
  }
}

export async function safeRollback(tx: Pick<Transaction, "rollback">, message: string): Promise<void> {
  try {
    await tx.rollback()
  } catch (rollbackError) {
    logPipelineError(message, {
      level: "error",
      error: rollbackError instanceof Error ? rollbackError.message : String(rollbackError),
      rollback_failed: "true",
    })
  }
}
