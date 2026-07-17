import type { Env } from "../../env"
import { openCommunityReadClient } from "../communities/community-read-access"
import type { CommunityJobRepository } from "../communities/jobs/runner-types"
import { logPipelineError, logPipelineInfo } from "../observability/pipeline-log"
import { KvAlertDeduper } from "./dedupe"
import { buildOpsAlerts, dedupeOpsAlerts, markOpsAlertsSent } from "./emit"
import { sendOpsAlerts } from "./sink"
import { collectCommunityPublishAlertSignals } from "./signals"
import type { CommunityPublishAlertSignals } from "./types"
import { getControlPlaneClient } from "../runtime-deps"
import { listFundingReceiptsForRefundReview } from "../communities/commerce/observed-funding-receipts"

const DEFAULT_MAX_COMMUNITIES = 100
const DEFAULT_LOOKBACK_MS = 15 * 60 * 1000
const DEFAULT_BUCKET_MS = 60 * 60 * 1000
const DEDUPE_TTL_SECONDS = 3 * 60 * 60
const SCAN_ROTATION_MS = 60 * 1000

function intFromEnv(value: string | undefined, fallback: number): number {
  const parsed = Number.parseInt(value ?? "", 10)
  return Number.isFinite(parsed) && parsed > 0 ? parsed : fallback
}

export function selectCommunityIdsForOpsAlertScan(input: {
  communityIds: string[]
  maxCommunities: number
  nowMs: number
}): { selected: string[]; offset: number; truncated: boolean } {
  const ids = [...new Set(input.communityIds)].sort()
  if (ids.length === 0 || input.maxCommunities <= 0) {
    return { selected: [], offset: 0, truncated: false }
  }
  if (ids.length <= input.maxCommunities) {
    return { selected: ids, offset: 0, truncated: false }
  }

  const offset = (Math.floor(input.nowMs / SCAN_ROTATION_MS) * input.maxCommunities) % ids.length
  const selected: string[] = []
  for (let index = 0; index < input.maxCommunities; index += 1) {
    selected.push(ids[(offset + index) % ids.length] as string)
  }
  return { selected, offset, truncated: true }
}

export async function runOpsAlerts(input: {
  env: Env
  communityRepository: CommunityJobRepository
  nowMs: number
}): Promise<void> {
  const { env } = input
  const kv = env.OPS_ALERT_DEDUPE
  if (!kv) return

  const maxCommunities = intFromEnv(env.OPS_ALERT_MAX_COMMUNITIES, DEFAULT_MAX_COMMUNITIES)
  const lookbackMs = intFromEnv(env.OPS_ALERT_LOOKBACK_MS, DEFAULT_LOOKBACK_MS)
  const since = new Date(input.nowMs - lookbackMs).toISOString()
  const activeCommunities = await input.communityRepository.listActiveCommunities({ requireReadyRouting: true })
  const scanSelection = selectCommunityIdsForOpsAlertScan({
    communityIds: activeCommunities.map((community) => community.community_id),
    maxCommunities,
    nowMs: input.nowMs,
  })
  if (scanSelection.truncated) {
    logPipelineInfo("[ops-alerts] active community scan truncated", {
      active_communities: activeCommunities.length,
      scanned_communities: maxCommunities,
      skipped_communities: activeCommunities.length - maxCommunities,
      scan_offset: scanSelection.offset,
    })
  }
  const communityIds = scanSelection.selected

  const signals: CommunityPublishAlertSignals[] = []
  for (const communityId of communityIds) {
    let handle: Awaited<ReturnType<typeof openCommunityReadClient>> | null = null
    try {
      handle = await openCommunityReadClient(env, input.communityRepository, communityId)
      signals.push(await collectCommunityPublishAlertSignals({ client: handle.client, communityId, since }))
    } catch (error) {
      logPipelineError("[ops-alerts] failed to collect signals for community", {
        community_id: communityId,
        error: error instanceof Error ? error.message : String(error),
      })
    } finally {
      await handle?.close?.()
    }
  }

  const alerts = buildOpsAlerts(signals)
  const controlPlane = getControlPlaneClient(env)
  try {
    const refundReviews = await listFundingReceiptsForRefundReview({ client: controlPlane, limit: 100 })
    if (refundReviews.length > 0) {
      alerts.push({
        key: "funding_receipt_refund_review",
        severity: "high",
        title: "Orphaned claimed funding receipts require refund review",
        count: refundReviews.length,
        community_ids: [],
        details: {
          truncated: refundReviews.length === 100,
          consumer_rails: [...new Set(refundReviews.map((receipt) => receipt.consumerRail).filter(Boolean))].sort(),
        },
      })
    }
  } catch (error) {
    logPipelineError("[ops-alerts] failed to collect funding refund reviews", {
      error: error instanceof Error ? error.message : String(error),
    })
  } finally {
    controlPlane.close?.()
  }
  if (alerts.length === 0) return

  const bucketMs = intFromEnv(env.OPS_ALERT_BUCKET_MS, DEFAULT_BUCKET_MS)
  const deduper = new KvAlertDeduper(kv, DEDUPE_TTL_SECONDS)
  const toSend = await dedupeOpsAlerts({ alerts, deduper, nowMs: input.nowMs, bucketMs })
  const delivery = await sendOpsAlerts(env, toSend)
  if (delivery.delivered) {
    await markOpsAlertsSent({ alerts: toSend, deduper, nowMs: input.nowMs, bucketMs })
  }
  logPipelineInfo("[ops-alerts] pass complete", {
    communities: communityIds.length,
    alerts: alerts.length,
    after_dedupe: toSend.length,
    delivered: delivery.delivered,
    sent: delivery.sent,
    sink: delivery.sink,
  })
}
