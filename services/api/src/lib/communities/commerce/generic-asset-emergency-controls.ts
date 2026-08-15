import type { DbExecutor } from "../../db-helpers"
import { notFoundError } from "../../errors"
import { makeId } from "../../helpers"

export type GenericEmergencyAssetContext = {
  assetId?: string | null
  contentHash?: string | null
  uploaderUserId?: string | null
  communityId?: string | null
  validationProfile?: string | null
}

export type GenericEmergencyControlScope = "all" | "content_hash" | "asset" | "uploader" | "community" | "validation_profile"

export async function createGenericEmergencyControl(input: {
  client: DbExecutor
  scope: GenericEmergencyControlScope
  targetRef: string | null
  reason: string
  actorRef: string
  now: string
}): Promise<{ controlId: string; scope: GenericEmergencyControlScope; targetRef: string | null; state: "active" }> {
  const reason = input.reason.trim()
  if (!reason) throw new Error("reason is required")
  if (input.scope === "all" ? input.targetRef !== null : !input.targetRef?.trim()) {
    throw new Error("target_ref does not match scope")
  }
  const controlId = makeId("gac")
  await input.client.execute({
    sql: `
      INSERT INTO generic_asset_emergency_controls (
        control_id, scope, target_ref, state, reason, actor_ref, created_at
      ) VALUES (?1, ?2, ?3, 'active', ?4, ?5, ?6)
    `,
    args: [controlId, input.scope, input.targetRef?.trim() ?? null, reason, input.actorRef, input.now],
  })
  return { controlId, scope: input.scope, targetRef: input.targetRef?.trim() ?? null, state: "active" }
}

export async function clearGenericEmergencyControl(input: {
  client: DbExecutor
  controlId: string
  actorRef: string
  now: string
}): Promise<boolean> {
  const result = await input.client.execute({
    sql: `
      UPDATE generic_asset_emergency_controls
      SET state = 'cleared', cleared_at = ?1, cleared_by = ?2
      WHERE control_id = ?3 AND state = 'active'
    `,
    args: [input.now, input.actorRef, input.controlId],
  })
  return (result.rowsAffected ?? 0) === 1
}

/**
 * Emergency controls are deliberately queried immediately before every
 * generic delivery/commerce decision. A control row matches by immutable
 * content hash, asset, uploader, community, validation profile, or globally.
 * The caller supplies the route's ordinary not-found message so controls do
 * not disclose that an asset exists.
 */
export async function assertGenericEmergencyControlsClear(input: {
  client: DbExecutor
  context: GenericEmergencyAssetContext
  notFoundMessage: string
}): Promise<void> {
  const targets: Array<{ scope: string; target: string | null }> = [
    { scope: "all", target: null },
    ...(input.context.contentHash ? [{ scope: "content_hash", target: input.context.contentHash }] : []),
    ...(input.context.assetId ? [{ scope: "asset", target: input.context.assetId }] : []),
    ...(input.context.uploaderUserId ? [{ scope: "uploader", target: input.context.uploaderUserId }] : []),
    ...(input.context.communityId ? [{ scope: "community", target: input.context.communityId }] : []),
    ...(input.context.validationProfile ? [{ scope: "validation_profile", target: input.context.validationProfile }] : []),
  ]
  const clauses = targets.map((_, index) => `(scope = ?${index * 2 + 1} AND COALESCE(target_ref, '') = COALESCE(?${index * 2 + 2}, ''))`)
  const args = targets.flatMap((target) => [target.scope, target.target])
  const result = await input.client.execute({
    sql: `
      SELECT control_id
      FROM generic_asset_emergency_controls
      WHERE state = 'active'
        AND (${clauses.join(" OR ")})
      LIMIT 1
    `,
    args,
  })
  if (result.rows.length > 0) throw notFoundError(input.notFoundMessage)
}
