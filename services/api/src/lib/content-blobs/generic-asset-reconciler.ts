import { openCommunityReadClient, openCommunityWriteClient } from "../communities/community-read-access"
import { getCommunityRepository } from "../communities/db-community-repository"
import { listActiveCommunityRows } from "../auth/auth-db-community-queries"
import { executeFirst } from "../db-helpers"
import { nowIso } from "../helpers"
import { getControlPlaneClient } from "../runtime-deps"
import { claimOwnedReadyContentBlob } from "./content-blob-repository"
import {
  createModerationAction,
  createModerationCase,
  getOpenModerationCaseForTarget,
  setAssetModerationEnforcement,
  setPostModerationStatus,
} from "../moderation/community-moderation-store"
import type { Env } from "../../env"
import type { CommunityDatabaseBindingRepository } from "../communities/db-community-repository"
import { withTransaction } from "../transactions"

const GENERIC_ASSET_KINDS = ["download_file", "learning_deck"] as const
const RECONCILIATION_ACTOR = "system:generic_asset_reconciler"

export type GenericAssetReconciliationSummary = {
  communities: number
  payloads: number
  claim_restored: number
  claim_restore_conflict: number
  blob_without_payload: number
  payload_without_claim: number
  quarantined: number
  enforcement_repairs: number
  enforcement_conflicts: number
  errors: number
}

type GenericPayload = {
  assetId: string
  communityId: string
  creatorUserId: string
  postId: string
  postStatus: "draft" | "processing" | "published" | "failed" | "hidden" | "removed" | "deleted"
  assetKind: (typeof GENERIC_ASSET_KINDS)[number]
  payloadRef: string
  contentHash: string
  sizeBytes: number
  enforcementState: "active" | "quarantined" | "blocked" | null
}

type EnforcementAction = {
  moderationActionId: string
  actionType: string
  nextPostStatus: GenericPayload["postStatus"]
  nextAssetEnforcementState: "active" | "quarantined" | "blocked"
  evidenceRef: string
}

function validEnforcementTransition(action: EnforcementAction): boolean {
  if (action.actionType === "hide" || action.actionType === "quarantine_asset") {
    return action.nextPostStatus === "hidden" && action.nextAssetEnforcementState === "quarantined"
  }
  if (action.actionType === "remove" || action.actionType === "block_asset") {
    return action.nextPostStatus === "removed" && action.nextAssetEnforcementState === "blocked"
  }
  if (action.actionType === "restore" || action.actionType === "restore_asset") {
    return action.nextPostStatus === "published" && action.nextAssetEnforcementState === "active"
  }
  return false
}

async function repairEnforcementProjection(input: {
  env: Env
  repository: CommunityDatabaseBindingRepository
  payload: GenericPayload
  action: EnforcementAction
  now: string
}): Promise<boolean> {
  if (!validEnforcementTransition(input.action)) return false
  const db = await openCommunityWriteClient(input.env, input.repository, input.payload.communityId)
  try {
    const latest = await executeFirst(db.client, {
      sql: `
        SELECT moderation_action_id, action_type, next_post_status,
               next_asset_enforcement_state, evidence_ref
        FROM moderation_actions
        WHERE asset_id = ?1 AND post_id = ?2
        ORDER BY created_at DESC, moderation_action_id DESC
        LIMIT 1
      `,
      args: [input.payload.assetId, input.payload.postId],
    })
    if (!latest || String((latest as Record<string, unknown>).moderation_action_id) !== input.action.moderationActionId) {
      return false
    }
    await withTransaction(db.client, "write", async (tx) => {
      if (input.payload.postStatus !== input.action.nextPostStatus) {
        await tx.execute({
          sql: `
            UPDATE posts
            SET status = ?1, updated_at = ?2
            WHERE post_id = ?3 AND status = ?4
          `,
          args: [input.action.nextPostStatus, input.now, input.payload.postId, input.payload.postStatus],
        })
      }
      if (input.payload.enforcementState !== input.action.nextAssetEnforcementState) {
        await setAssetModerationEnforcement({
          executor: tx,
          assetId: input.payload.assetId,
          moderationActionId: input.action.moderationActionId,
          enforcementState: input.action.nextAssetEnforcementState,
          reasonCode: "enforcement_projection_repair",
          evidenceRef: input.action.evidenceRef,
          expectedEnforcementState: input.payload.enforcementState,
          allowMissingInsert: input.payload.enforcementState === null,
          now: input.now,
        })
      }
    })
    return input.payload.postStatus !== input.action.nextPostStatus
      || input.payload.enforcementState !== input.action.nextAssetEnforcementState
  } finally {
    db.close()
  }
}

async function quarantineMismatchedPayload(input: {
  env: Env
  repository: CommunityDatabaseBindingRepository
  payload: GenericPayload
  reason: string
  now: string
}): Promise<boolean> {
  const db = await openCommunityWriteClient(input.env, input.repository, input.payload.communityId)
  try {
    const existing = await executeFirst(db.client, {
      sql: `
        SELECT moderation_action_id
        FROM moderation_actions
        WHERE asset_id = ?1 AND action_type = 'quarantine_asset' AND evidence_ref = ?2
        LIMIT 1
      `,
      args: [input.payload.assetId, input.reason],
    })
    if (existing) return false
    const existingCase = await getOpenModerationCaseForTarget({
      executor: db.client,
      communityId: input.payload.communityId,
      target: { postId: input.payload.postId },
    })
    const caseRow = existingCase ?? await createModerationCase({
      executor: db.client,
      communityId: input.payload.communityId,
      target: { postId: input.payload.postId },
      priority: "high",
      openedBy: "platform_analysis",
      now: input.now,
    })
    await withTransaction(db.client, "write", async (tx) => {
      const action = await createModerationAction({
        executor: tx,
        moderationCase: caseRow,
        actorUserId: RECONCILIATION_ACTOR,
        body: {
          action_type: "quarantine_asset",
          note: "Generic asset reconciliation detected a control-plane payload mismatch.",
          evidence_ref: input.reason,
        },
        now: input.now,
        previousStatus: input.payload.postStatus,
        nextStatus: "hidden",
        evidenceRef: input.reason,
        assetId: input.payload.assetId,
        previousAssetEnforcementState: input.payload.enforcementState,
        nextAssetEnforcementState: "quarantined",
      })
      await setPostModerationStatus({ executor: tx, postId: input.payload.postId, status: "hidden", now: input.now })
      await setAssetModerationEnforcement({
        executor: tx,
        assetId: input.payload.assetId,
        moderationActionId: action.moderation_action_id,
        enforcementState: "quarantined",
        reasonCode: "generic_asset_reconciliation_mismatch",
        evidenceRef: input.reason,
        expectedEnforcementState: input.payload.enforcementState,
        allowMissingInsert: input.payload.enforcementState === null,
        now: input.now,
      })
    })
    return true
  } finally {
    db.close()
  }
}

export async function reconcileGenericAssetPayloads(input: {
  env: Env
  repository?: CommunityDatabaseBindingRepository
  communityLimit?: number
  payloadLimitPerCommunity?: number
}): Promise<GenericAssetReconciliationSummary> {
  const summary: GenericAssetReconciliationSummary = {
    communities: 0,
    payloads: 0,
    claim_restored: 0,
    claim_restore_conflict: 0,
    blob_without_payload: 0,
    payload_without_claim: 0,
    quarantined: 0,
    enforcement_repairs: 0,
    enforcement_conflicts: 0,
    errors: 0,
  }
  const control = getControlPlaneClient(input.env)
  const repository = input.repository ?? getCommunityRepository(input.env)
  const communities = await listActiveCommunityRows(control, {
    limit: Math.max(1, Math.min(100, input.communityLimit ?? 25)),
    requireReadyRouting: true,
  })
  for (const community of communities) {
    summary.communities += 1
    const db = await openCommunityReadClient(input.env, repository, community.community_id)
    try {
      const payloadRefs = new Set<string>()
      const result = await db.client.execute({
        sql: `
          SELECT assets.asset_id, assets.community_id, assets.creator_user_id, assets.source_post_id,
                 posts.status AS post_status, assets.asset_kind,
                 payloads.content_blob_ref, payloads.content_hash, payloads.size_bytes,
                 enforcement.enforcement_state
          FROM assets
          JOIN posts ON posts.post_id = assets.source_post_id
          JOIN asset_payloads AS payloads
            ON payloads.asset_id = assets.asset_id
           AND payloads.role = 'primary'
           AND payloads.status = 'active'
          LEFT JOIN asset_enforcement AS enforcement
            ON enforcement.asset_id = assets.asset_id
          WHERE assets.community_id = ?1
            AND assets.asset_kind IN ('download_file', 'learning_deck')
            AND assets.publication_status IN ('story_published', 'draft', 'story_requested')
          ORDER BY assets.updated_at ASC, assets.asset_id ASC
          LIMIT ?2
        `,
        args: [community.community_id, Math.max(1, Math.min(500, input.payloadLimitPerCommunity ?? 100))],
      })
      for (const row of result.rows) {
        const value = row as Record<string, unknown>
        const payload: GenericPayload = {
          assetId: String(value.asset_id),
          communityId: String(value.community_id),
          creatorUserId: String(value.creator_user_id),
          postId: String(value.source_post_id),
          postStatus: String(value.post_status) as GenericPayload["postStatus"],
          assetKind: String(value.asset_kind) as GenericPayload["assetKind"],
          payloadRef: String(value.content_blob_ref),
          contentHash: String(value.content_hash),
          sizeBytes: Number(value.size_bytes),
          enforcementState: value.enforcement_state == null ? null : String(value.enforcement_state) as GenericPayload["enforcementState"],
        }
        summary.payloads += 1
        payloadRefs.add(payload.payloadRef)
        const actionRow = await executeFirst(db.client, {
          sql: `
            SELECT moderation_action_id, action_type, next_post_status,
                   next_asset_enforcement_state, evidence_ref
            FROM moderation_actions
            WHERE asset_id = ?1 AND post_id = ?2
            ORDER BY created_at DESC, moderation_action_id DESC
            LIMIT 1
          `,
          args: [payload.assetId, payload.postId],
        })
        const action = actionRow
          ? {
            moderationActionId: String((actionRow as Record<string, unknown>).moderation_action_id),
            actionType: String((actionRow as Record<string, unknown>).action_type),
            nextPostStatus: String((actionRow as Record<string, unknown>).next_post_status) as GenericPayload["postStatus"],
            nextAssetEnforcementState: String((actionRow as Record<string, unknown>).next_asset_enforcement_state) as EnforcementAction["nextAssetEnforcementState"],
            evidenceRef: String((actionRow as Record<string, unknown>).evidence_ref ?? "generic_asset_reconciliation"),
          } satisfies EnforcementAction
          : null
        if (action && !validEnforcementTransition(action)) {
          summary.enforcement_conflicts += 1
          continue
        }
        const blob = await executeFirst(control, {
          sql: `
            SELECT community_id, uploader_user_id, status, security_scan_state,
                   verified_content_hash, verified_size_bytes, claim_kind, claim_ref
            FROM content_blobs
            WHERE content_blob_id = ?1
            LIMIT 1
          `,
          args: [payload.payloadRef],
        })
        if (!blob) {
          summary.payload_without_claim += 1
          const evidence = `generic_asset_reconciliation:${payload.assetId}:${payload.payloadRef}:missing_blob`
          try {
            if (await quarantineMismatchedPayload({ env: input.env, repository, payload, reason: evidence, now: nowIso() })) {
              summary.quarantined += 1
            }
          } catch (error) {
            summary.errors += 1
            console.warn("[generic-asset-reconciler] missing-blob quarantine failed", error)
          }
          continue
        }
        const blobValue = blob as Record<string, unknown>
        const hash = String(blobValue.verified_content_hash ?? "")
        const size = Number(blobValue.verified_size_bytes ?? 0)
        const ownershipMatches = blobValue.community_id === payload.communityId
          && blobValue.uploader_user_id === payload.creatorUserId
        const bytesMatch = hash === payload.contentHash && size === payload.sizeBytes
        if (!ownershipMatches || !bytesMatch) {
          summary.claim_restore_conflict += 1
          const evidence = `generic_asset_reconciliation:${payload.assetId}:${payload.payloadRef}`
          try {
            if (await quarantineMismatchedPayload({ env: input.env, repository, payload, reason: evidence, now: nowIso() })) {
              summary.quarantined += 1
            }
          } catch (error) {
            summary.errors += 1
            console.warn("[generic-asset-reconciler] quarantine failed", error)
          }
          continue
        }
        if (action && (payload.postStatus !== action.nextPostStatus || payload.enforcementState !== action.nextAssetEnforcementState)) {
          if (action.nextAssetEnforcementState === "active"
            && (blobValue.status !== "ready" || blobValue.security_scan_state !== "clean")) {
            summary.enforcement_conflicts += 1
            continue
          }
          try {
            if (await repairEnforcementProjection({
              env: input.env,
              repository,
              payload,
              action,
              now: nowIso(),
            })) summary.enforcement_repairs += 1
          } catch (error) {
            summary.enforcement_conflicts += 1
            console.warn("[generic-asset-reconciler] enforcement repair failed", error)
          }
        }
        if (blobValue.claim_kind === "asset_payload" && blobValue.claim_ref === payload.assetId) continue
        if (blobValue.claim_kind !== null && blobValue.claim_kind !== undefined) {
          summary.claim_restore_conflict += 1
          const evidence = `generic_asset_reconciliation:${payload.assetId}:${payload.payloadRef}:claim_conflict`
          try {
            if (await quarantineMismatchedPayload({ env: input.env, repository, payload, reason: evidence, now: nowIso() })) {
              summary.quarantined += 1
            }
          } catch (error) {
            summary.errors += 1
            console.warn("[generic-asset-reconciler] claim-conflict quarantine failed", error)
          }
          continue
        }
        summary.payload_without_claim += 1
        if (blobValue.status !== "ready" || blobValue.security_scan_state !== "clean") {
          summary.claim_restore_conflict += 1
          continue
        }
        try {
          await claimOwnedReadyContentBlob({
            client: control,
            communityId: payload.communityId,
            uploaderUserId: payload.creatorUserId,
            contentBlobId: payload.payloadRef,
            claimKind: "asset_payload",
            claimRef: payload.assetId,
            claimedAt: nowIso(),
          })
          summary.claim_restored += 1
        } catch (error) {
          summary.claim_restore_conflict += 1
          console.warn("[generic-asset-reconciler] claim restore conflict", error)
        }
      }
      const claimedBlobs = await control.execute({
        sql: `
          SELECT content_blob_id
          FROM content_blobs
          WHERE community_id = ?1
            AND claim_kind = 'asset_payload'
          ORDER BY claimed_at ASC, content_blob_id ASC
          LIMIT 500
        `,
        args: [community.community_id],
      })
      for (const row of claimedBlobs.rows) {
        const contentBlobId = String((row as Record<string, unknown>).content_blob_id ?? "")
        if (contentBlobId && !payloadRefs.has(contentBlobId)) summary.blob_without_payload += 1
      }
    } catch (error) {
      summary.errors += 1
      console.warn("[generic-asset-reconciler] community sweep failed", error)
    } finally {
      db.close()
    }
  }
  console.info("[generic-asset-reconciler] sweep", summary)
  return summary
}
