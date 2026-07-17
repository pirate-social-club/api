import { Hono } from "hono"
import type { Env } from "../env"
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
