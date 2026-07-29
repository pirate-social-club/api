import { Hono, type Context } from "hono"
import { authenticateAdminToken, authenticateAdminTokenOnly, type AuthenticatedEnv } from "../lib/auth-middleware"
import { getControlPlaneClient } from "../lib/runtime-deps"
import { enqueueCommunityJob } from "../lib/communities/jobs/store"
import { processAvailableCommunityJobs } from "../lib/communities/jobs/runner"
import { openCommunityWriteClient } from "../lib/communities/community-read-access"
import { getCommunityRepository } from "../lib/communities/db-community-repository"
import { nowIso } from "../lib/helpers"
import { logPipelineError } from "../lib/observability/pipeline-log"
import { decodePublicCommunityId } from "../lib/public-ids"
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

// Operator surface for Telegram channel deliveries stranded in 'uncertain'.
// Nothing scans that state automatically — by design, because retrying an
// ambiguous send duplicates the channel post — so without these endpoints the
// rows are invisible.
const opsTelegramDeliveries = new Hono<AuthenticatedEnv>()

// Reads are token-only: an operator surveying the fleet has no per-community
// identity to assert.
function requireOpsAdmin(c: Context<AuthenticatedEnv>) {
  return authenticateAdminTokenOnly({
    env: c.env,
    token: c.req.header("x-admin-token"),
  })
}

// Writes demand an attributable human. authenticateAdminToken throws unless
// x-admin-as-user-id names a real user, which is what makes the audit record
// (and its FK to users) meaningful rather than "some admin token did this".
function requireOpsActor(c: Context<AuthenticatedEnv>) {
  return authenticateAdminToken({
    env: c.env,
    token: c.req.header("x-admin-token"),
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

opsTelegramDeliveries.get("/synthetic-fixture", async (c) => {
  const unavailable = requireStaging(c)
  if (unavailable) return unavailable
  if (!requireOpsAdmin(c)) return c.json({ error: "unauthorized" }, 401)
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
  if (!requireOpsAdmin(c)) return c.json({ error: "unauthorized" }, 401)
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
  if (!requireOpsAdmin(c)) return c.json({ error: "unauthorized" }, 401)
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
  if (!requireOpsAdmin(c)) return c.json({ error: "unauthorized" }, 401)
  const outcome = await cleanupTelegramSyntheticDelivery({
    env: c.env,
    client: getControlPlaneClient(c.env),
    postId: c.req.param("postId"),
    communityId: c.req.query("community_id") ?? null,
  })
  return c.json(outcome)
})

opsTelegramDeliveries.get("/uncertain-deliveries", async (c) => {
  if (!requireOpsAdmin(c)) return c.json({ error: "unauthorized" }, 401)
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
  if (!requireOpsAdmin(c)) return c.json({ error: "unauthorized" }, 401)
  const client = getControlPlaneClient(c.env)
  const total = await countUncertainDeliveries({ client, filters: parseFilters(c) })
  return c.json({ total, ok: total === 0 })
})

opsTelegramDeliveries.post("/uncertain-deliveries/:deliveryId/resolve", async (c) => {
  const actor = requireOpsActor(c)
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
