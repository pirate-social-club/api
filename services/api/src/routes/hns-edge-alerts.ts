import { Hono } from "hono"
import type { Env } from "../env"
import { isExpectedHnsEdgeRole, recordHnsEdgeHeartbeat } from "../lib/ops-alerts/hns-edge-heartbeats"
import { sendOpsAlerts } from "../lib/ops-alerts/sink"

const MAX_ALERT_TEXT_BYTES = 4_096
const edgeAlerts = new Hono<{ Bindings: Env }>()

async function digest(value: string): Promise<Uint8Array> {
  return new Uint8Array(await crypto.subtle.digest("SHA-256", new TextEncoder().encode(value)))
}

async function tokensMatch(provided: string, expected: string): Promise<boolean> {
  const [left, right] = await Promise.all([digest(provided), digest(expected)])
  let difference = 0
  for (let index = 0; index < left.length; index += 1) {
    difference |= (left[index] ?? 0) ^ (right[index] ?? 0)
  }
  return difference === 0
}

function bearerToken(header: string | undefined): string {
  if (!header?.startsWith("Bearer ")) return ""
  return header.slice("Bearer ".length).trim()
}

edgeAlerts.post("/", async (c) => {
  const expected = c.env.HNS_EDGE_ALERT_TOKEN?.trim() ?? ""
  const provided = bearerToken(c.req.header("authorization"))
  if (!expected || !provided || !(await tokensMatch(provided, expected))) {
    return c.json({ error: "unauthorized" }, 401)
  }

  if (!c.req.header("content-type")?.toLowerCase().startsWith("application/json")) {
    return c.json({ error: "content_type_must_be_json" }, 415)
  }

  let body: unknown
  try {
    body = await c.req.json()
  } catch {
    return c.json({ error: "invalid_json" }, 400)
  }

  const heartbeat = body as {
    kind?: unknown
    host?: unknown
    role?: unknown
    core_commit?: unknown
    verified_at?: unknown
  } | null
  if (heartbeat?.kind === "heartbeat") {
    const host = typeof heartbeat.host === "string" ? heartbeat.host.trim() : ""
    const role = typeof heartbeat.role === "string" ? heartbeat.role.trim() : ""
    const coreCommit = typeof heartbeat.core_commit === "string" ? heartbeat.core_commit.trim() : ""
    const verifiedAt = typeof heartbeat.verified_at === "string" ? heartbeat.verified_at.trim() : ""
    const verifiedAtMs = Date.parse(verifiedAt)
    if (
      !isExpectedHnsEdgeRole({ host, role })
      || !/^[a-f0-9]{40}$/.test(coreCommit)
      || !Number.isFinite(verifiedAtMs)
      || Math.abs(Date.now() - verifiedAtMs) > 10 * 60 * 1_000
    ) {
      return c.json({ error: "invalid_heartbeat" }, 400)
    }
    try {
      await recordHnsEdgeHeartbeat({ env: c.env, host, role, coreCommit, verifiedAt })
    } catch {
      return c.json({ error: "heartbeat_storage_failed" }, 503)
    }
    return c.json({ accepted: true }, 202)
  }

  const text = typeof (body as { text?: unknown } | null)?.text === "string"
    ? (body as { text: string }).text.trim()
    : ""
  const byteLength = new TextEncoder().encode(text).byteLength
  if (!text || byteLength > MAX_ALERT_TEXT_BYTES) {
    return c.json({ error: "invalid_text" }, 400)
  }

  const fingerprint = Array.from((await digest(text)).slice(0, 8))
    .map((byte) => byte.toString(16).padStart(2, "0"))
    .join("")
  const delivery = await sendOpsAlerts(c.env, [{
    key: `hns-edge:${fingerprint}`,
    severity: "high",
    title: "HNS edge deployment alert",
    count: 1,
    community_ids: [],
    details: { message: text },
  }])

  if (!delivery.delivered || delivery.sent !== 1) {
    return c.json({ error: "alert_delivery_failed" }, 503)
  }
  return c.json({ accepted: true }, 202)
})

export default edgeAlerts
