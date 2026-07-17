import type { Env } from "../../env"
import { sendOpsAlerts } from "./sink"

export const HNS_EDGE_HEARTBEAT_MAX_AGE_MS = 36 * 60 * 60 * 1_000
const HEARTBEAT_PREFIX = "hns-edge-heartbeat:v1:"
const ALERT_PREFIX = "hns-edge-heartbeat-alert:v1:"
const ALERT_REPEAT_SECONDS = 6 * 60 * 60

export const HNS_EDGE_ROLES = [
  { host: "ns1-pirate-fluence", role: "hns-chain-observer" },
  { host: "ns1-pirate-fluence", role: "hns-authoritative-dns" },
  { host: "ns2-pirate-fluence", role: "hns-secondary-dns" },
] as const

export type HnsEdgeRole = (typeof HNS_EDGE_ROLES)[number]

function identity(input: { host: string; role: string }): string {
  return `${input.host}:${input.role}`
}

function heartbeatKey(input: { host: string; role: string }): string {
  return `${HEARTBEAT_PREFIX}${identity(input)}`
}

function alertKey(input: { host: string; role: string }): string {
  return `${ALERT_PREFIX}${identity(input)}`
}

export function isExpectedHnsEdgeRole(input: { host: string; role: string }): boolean {
  return HNS_EDGE_ROLES.some((expected) => expected.host === input.host && expected.role === input.role)
}

export async function recordHnsEdgeHeartbeat(input: {
  env: Env
  host: string
  role: string
  coreCommit: string
  verifiedAt: string
}): Promise<void> {
  if (!input.env.OPS_ALERT_DEDUPE) throw new Error("OPS_ALERT_DEDUPE binding is required for HNS edge heartbeats")
  await input.env.OPS_ALERT_DEDUPE.put(heartbeatKey(input), JSON.stringify({
    host: input.host,
    role: input.role,
    core_commit: input.coreCommit,
    verified_at: input.verifiedAt,
    received_at: new Date().toISOString(),
  }))
}

type HeartbeatState = {
  verified_at?: unknown
  received_at?: unknown
  core_commit?: unknown
}

export async function checkHnsEdgeHeartbeatFreshness(
  env: Env,
  now = new Date(),
): Promise<{ stale: string[] }> {
  const kv = env.OPS_ALERT_DEDUPE
  if (!kv) throw new Error("OPS_ALERT_DEDUPE binding is required for HNS edge heartbeat monitoring")

  const stale: string[] = []
  for (const expected of HNS_EDGE_ROLES) {
    const roleIdentity = identity(expected)
    const raw = await kv.get(heartbeatKey(expected))
    let state: HeartbeatState | null = null
    try {
      state = raw ? JSON.parse(raw) as HeartbeatState : null
    } catch {
      state = null
    }
    const receivedAt = typeof state?.received_at === "string" ? Date.parse(state.received_at) : Number.NaN
    const ageMs = now.getTime() - receivedAt
    if (Number.isFinite(receivedAt) && ageMs >= 0 && ageMs <= HNS_EDGE_HEARTBEAT_MAX_AGE_MS) {
      const markerKey = alertKey(expected)
      if (await kv.get(markerKey)) await kv.delete(markerKey)
      continue
    }

    stale.push(roleIdentity)
    if (await kv.get(alertKey(expected))) continue

    const delivery = await sendOpsAlerts(env, [{
      key: `hns-edge-heartbeat-stale:${roleIdentity}`,
      severity: "high",
      title: "HNS edge heartbeat is stale or missing",
      count: 1,
      community_ids: [],
      details: {
        host: expected.host,
        role: expected.role,
        last_received_at: typeof state?.received_at === "string" ? state.received_at : "missing",
        last_verified_at: typeof state?.verified_at === "string" ? state.verified_at : "missing",
        core_commit: typeof state?.core_commit === "string" ? state.core_commit : "unknown",
        max_age_hours: HNS_EDGE_HEARTBEAT_MAX_AGE_MS / 3_600_000,
      },
    }])
    if (delivery.delivered) {
      await kv.put(alertKey(expected), now.toISOString(), { expirationTtl: ALERT_REPEAT_SECONDS })
    }
  }
  return { stale }
}
