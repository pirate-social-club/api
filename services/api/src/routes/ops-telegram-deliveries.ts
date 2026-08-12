import { Hono, type Context } from "hono"
import { authenticateAdminAccess, authenticateAdminAccessOnly, type AuthenticatedEnv } from "../lib/auth-middleware"
import { ADMIN_OPERATIONS_MANAGE_SCOPE } from "../lib/operator-credential-auth"
import { mergeTelegramAccountIntoCanonical } from "../lib/telegram/account-merge-service"
import { getControlPlaneClient } from "../lib/runtime-deps"
import { enqueueCommunityJob } from "../lib/communities/jobs/store"
import { processAvailableCommunityJobs } from "../lib/communities/jobs/runner"
import { openCommunityWriteClient } from "../lib/communities/community-read-access"
import { getCommunityRepository } from "../lib/communities/db-community-repository"
import { nowIso } from "../lib/helpers"
import { logPipelineError } from "../lib/observability/pipeline-log"
import { decodePublicCommunityId, decodePublicPostId } from "../lib/public-ids"
import { getPostById } from "../lib/posts/community-post-query-store"
import {
  countUncertainDeliveries,
  findDeliverySubject,
  listUncertainDeliveries,
  resolveUncertainDelivery,
  revertRetryAuthorization,
  type ResolutionAction,
  type UncertainDeliveryFilters,
} from "../lib/telegram/uncertain-delivery-ops-service"
import {
  cleanupTelegramSyntheticDelivery,
  findTelegramSyntheticFixture,
  getTelegramSyntheticDelivery,
} from "../lib/telegram/telegram-synthetic-ops-service"
import { assertTelegramSyntheticCleanupPost } from "../lib/telegram/telegram-synthetic-contract"
import { rowValue, stringOrNull } from "../lib/sql-row"

// Operator surface for Telegram channel deliveries stranded in 'uncertain'.
// Nothing scans that state automatically — by design, because retrying an
// ambiguous send duplicates the channel post — so without these endpoints the
// rows are invisible.
const opsTelegramDeliveries = new Hono<AuthenticatedEnv>()

// Reads require the operations scope; no impersonated user is needed.
function requireOpsAdmin(c: Context<AuthenticatedEnv>) {
  return authenticateAdminAccessOnly({
    env: c.env,
    authorization: c.req.header("authorization"),
    legacyToken: c.req.header("x-admin-token"),
    requiredScope: ADMIN_OPERATIONS_MANAGE_SCOPE,
  })
}

// Writes additionally demand an impersonated user for existing user-FK audit
// fields. The operator credential remains the authoritative actor attribution.
function requireOpsActor(c: Context<AuthenticatedEnv>) {
  return authenticateAdminAccess({
    env: c.env,
    authorization: c.req.header("authorization"),
    legacyToken: c.req.header("x-admin-token"),
    asUserId: c.req.header("x-admin-as-user-id"),
  })
}

function parseFilters(c: Context<AuthenticatedEnv>): UncertainDeliveryFilters {
  const olderThan = c.req.query("older_than_minutes")
  return {
    communityId: c.req.query("community_id") ?? null,
    destinationId: c.req.query("destination_id") ?? null,
    olderThanMinutes: olderThan == null ? null : Number.parseInt(olderThan, 10),
  }
}

function requireStaging(c: Context<AuthenticatedEnv>): Response | null {
  return c.env.ENVIRONMENT === "staging"
    ? null
    : c.json({ error: "not_found" }, 404)
}

// Residual account-merge repair is deliberately operator-only. It replays the
// receipt-independent sweep for a completed/finalizing merge without exposing
// merge identifiers or consumed link intents to normal users.
opsTelegramDeliveries.post("/account-merges/:mergeId/residual-repair", async (c) => {
  const actor = await requireOpsActor(c)
  if (!actor) return c.json({ error: "unauthorized" }, 401)
  const mergeId = c.req.param("mergeId")?.trim()
  if (!mergeId) return c.json({ error: "merge_id_required" }, 400)

  const merge = await getControlPlaneClient(c.env).execute({
    sql: `
      SELECT m.source_user_id, m.canonical_user_id, m.status,
             i.link_intent_id, i.telegram_provider_subject, i.telegram_user_id
      FROM user_account_merges m
      JOIN telegram_account_link_intents i ON i.link_intent_id = m.link_intent_id
      WHERE m.user_account_merge_id = ?1
      LIMIT 1
    `,
    args: [mergeId],
  })
  const row = merge.rows[0]
  const status = stringOrNull(rowValue(row, "status"))
  if (status !== "finalizing" && status !== "completed") {
    return c.json({ error: "merge_not_ready", status }, 409)
  }
  const sourceUserId = stringOrNull(rowValue(row, "source_user_id"))
  const canonicalUserId = stringOrNull(rowValue(row, "canonical_user_id"))
  const linkIntentId = stringOrNull(rowValue(row, "link_intent_id"))
  const providerSubject = stringOrNull(rowValue(row, "telegram_provider_subject"))
  const telegramUserId = stringOrNull(rowValue(row, "telegram_user_id"))
  if (!sourceUserId || !canonicalUserId || !linkIntentId || !providerSubject || !telegramUserId) {
    return c.json({ error: "merge_metadata_incomplete" }, 500)
  }

  await mergeTelegramAccountIntoCanonical({
    env: c.env,
    linkIntentId,
    sourceUserId,
    canonicalUserId,
    providerSubject,
    telegramUserId,
  })
  return c.json({ merge_id: mergeId, status: "completed", operator_user_id: actor.userId }, 200)
})

opsTelegramDeliveries.get("/synthetic-fixture", async (c) => {
  const unavailable = requireStaging(c)
  if (unavailable) return unavailable
  if (!await requireOpsAdmin(c)) return c.json({ error: "unauthorized" }, 401)
  const fixture = await findTelegramSyntheticFixture({
    client: getControlPlaneClient(c.env),
    communityId: c.req.query("community_id") ?? null,
  })
  return c.json(fixture)
})

// This deterministic staging executor verifies the real queue handler and Bot
// API path without coupling the Telegram synthetic to cron fleet cadence. Cron
// liveness is a separate operational property and must be monitored through
// queue age; a passing synthetic does not certify scheduled-batch frequency.
opsTelegramDeliveries.post("/synthetic-fixture/drain", async (c) => {
  const unavailable = requireStaging(c)
  if (unavailable) return unavailable
  if (!await requireOpsAdmin(c)) return c.json({ error: "unauthorized" }, 401)
  const fixture = await findTelegramSyntheticFixture({
    client: getControlPlaneClient(c.env),
    communityId: c.req.query("community_id") ?? null,
  })
  const communityRepository = getCommunityRepository(c.env)
  try {
    const summary = await processAvailableCommunityJobs({
      env: c.env,
      communityRepository,
      communityIds: [decodePublicCommunityId(fixture.community_id)],
      maxCommunities: 1,
      maxJobsPerCommunity: 25,
    })
    return c.json({
      processed_jobs: summary.processed_jobs,
      failed_communities: summary.failed_communities.length,
    })
  } finally {
    await communityRepository.close?.()
  }
})

opsTelegramDeliveries.get("/synthetic-deliveries/:postId", async (c) => {
  const unavailable = requireStaging(c)
  if (unavailable) return unavailable
  if (!await requireOpsAdmin(c)) return c.json({ error: "unauthorized" }, 401)
  const delivery = await getTelegramSyntheticDelivery({
    client: getControlPlaneClient(c.env),
    postId: c.req.param("postId"),
    communityId: c.req.query("community_id") ?? null,
  })
  return c.json({ delivery })
})

opsTelegramDeliveries.post("/synthetic-deliveries/:postId/cleanup", async (c) => {
  const unavailable = requireStaging(c)
  if (unavailable) return unavailable
  if (!await requireOpsAdmin(c)) return c.json({ error: "unauthorized" }, 401)
  const fixture = await findTelegramSyntheticFixture({
    client: getControlPlaneClient(c.env),
    communityId: c.req.query("community_id") ?? null,
  })
  const communityId = decodePublicCommunityId(fixture.community_id)
  const postId = decodePublicPostId(c.req.param("postId"))
  const handle = await openCommunityWriteClient(
    c.env,
    getCommunityRepository(c.env),
    communityId,
  )
  try {
    assertTelegramSyntheticCleanupPost({
      post: await getPostById(handle.client, postId),
      communityId,
      ownerUserId: fixture.owner_user_id,
    })
  } finally {
    await handle.close()
  }
  const outcome = await cleanupTelegramSyntheticDelivery({
    env: c.env,
    client: getControlPlaneClient(c.env),
    postId,
    communityId: fixture.community_id,
  })
  return c.json(outcome)
})

opsTelegramDeliveries.get("/uncertain-deliveries", async (c) => {
  if (!await requireOpsAdmin(c)) return c.json({ error: "unauthorized" }, 401)
  const requestedLimit = Number.parseInt(c.req.query("limit") ?? "50", 10)
  const client = getControlPlaneClient(c.env)
  const filters = parseFilters(c)
  // Count uses the same filter builder as the list, so the two can never
  // disagree about what is stranded.
  const [items, total] = await Promise.all([
    listUncertainDeliveries({
      client,
      filters,
      limit: Number.isFinite(requestedLimit) ? requestedLimit : 50,
    }),
    countUncertainDeliveries({ client, filters }),
  ])
  return c.json({ items, total, ok: total === 0 })
})

opsTelegramDeliveries.get("/uncertain-deliveries/count", async (c) => {
  if (!await requireOpsAdmin(c)) return c.json({ error: "unauthorized" }, 401)
  const client = getControlPlaneClient(c.env)
  const total = await countUncertainDeliveries({ client, filters: parseFilters(c) })
  return c.json({ total, ok: total === 0 })
})

opsTelegramDeliveries.post("/uncertain-deliveries/:deliveryId/resolve", async (c) => {
  const actor = await requireOpsActor(c)
  if (!actor) return c.json({ error: "unauthorized" }, 401)

  const body = await c.req.json<{
    action?: string
    reason?: string
    telegram_message_id?: number
    operator_confirmed?: boolean
  }>().catch(() => ({} as Record<string, never>))

  const action = body.action
  if (action !== "marked_delivered" && action !== "retry_authorized") {
    return c.json({ error: "action must be marked_delivered or retry_authorized" }, 400)
  }

  const client = getControlPlaneClient(c.env)
  const deliveryId = c.req.param("deliveryId")
  // Read the subject before resolving: retry_authorized clears 'uncertain', and
  // we still need the community and post to enqueue against.
  const subject = await findDeliverySubject({ client, deliveryId })

  const outcome = await resolveUncertainDelivery({
    client,
    deliveryId,
    action: action as ResolutionAction,
    actorUserId: actor.userId,
    reason: body.reason ?? null,
    telegramMessageId: body.telegram_message_id ?? null,
    operatorConfirmed: body.operator_confirmed === true,
  })

  // Enqueue only when this call is the one that flipped the row. A repeated
  // request sees applied=false and enqueues nothing, so an operator cannot
  // authorize two attempts by double-clicking.
  let retryEnqueued = false
  if (outcome.applied && action === "retry_authorized") {
    try {
      const handle = await openCommunityWriteClient(
        c.env,
        getCommunityRepository(c.env),
        subject.communityId,
      )
      try {
        await enqueueCommunityJob({
          client: handle.client,
          communityId: subject.communityId,
          jobType: "telegram_post_publish",
          subjectType: "post",
          subjectId: subject.postId,
          createdAt: nowIso(),
        })
        retryEnqueued = true
      } finally {
        await handle.close()
      }
    } catch (error) {
      const message = error instanceof Error ? error.message : String(error)
      logPipelineError("[ops] Telegram uncertain-delivery retry enqueue failed", {
        community_id: subject.communityId,
        post_id: subject.postId,
        error: message,
      })
      // Put the row back so it stays visible and re-resolvable. Leaving it
      // 'pending' would strand it silently: nothing scans that state, and a
      // second request would find it no longer 'uncertain' and decline to act.
      await revertRetryAuthorization({
        client,
        deliveryId,
        note: `Retry authorization rolled back: could not enqueue the publish job (${message})`,
      }).catch(() => undefined)
      return c.json({ error: "retry_enqueue_failed", delivery_id: deliveryId }, 503)
    }
  }

  return c.json({ ...outcome, retry_enqueued: retryEnqueued })
})

export default opsTelegramDeliveries
