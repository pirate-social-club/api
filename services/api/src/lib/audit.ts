import type { DbExecutor } from "./db-helpers"
import { makeId, nowIso } from "./helpers"
import { getControlPlaneClient } from "./runtime-deps"
import type { Env } from "../env"

export type AuditActorType = "operator" | "user"

export type AuditEventInput = {
  action: string
  actorId: string
  actorType: AuditActorType
  communityId?: string | null
  createdAt?: string
  metadata?: Record<string, unknown>
  targetId: string
  targetType: string
}

export function auditEventInsert(input: AuditEventInput): {
  sql: string
  args: unknown[]
} {
  return {
    sql: `
      INSERT INTO audit_log (
        audit_event_id, actor_type, actor_id, action, target_type, target_id, community_id, metadata_json, created_at
      ) VALUES (
        ?1, ?2, ?3, ?4, ?5, ?6, ?7, ?8, ?9
      )
    `,
    args: [
      makeId("aud"),
      input.actorType,
      input.actorId,
      input.action,
      input.targetType,
      input.targetId,
      input.communityId ?? null,
      JSON.stringify(input.metadata ?? {}),
      input.createdAt ?? nowIso(),
    ],
  }
}

export async function writeAuditEvent(client: DbExecutor, input: AuditEventInput): Promise<void> {
  await client.execute(auditEventInsert(input))
}

export async function writeAuditEventForEnv(env: Env, input: AuditEventInput): Promise<void> {
  await writeAuditEvent(getControlPlaneClient(env), input)
}

export async function writeAuditEventBestEffortForEnv(
  env: Env,
  input: AuditEventInput,
  logPrefix: string,
): Promise<void> {
  await writeAuditEventForEnv(env, input).catch((error) => {
    console.error(`${logPrefix} audit write failed`, error)
  })
}
