import { Hono } from "hono"
import { trackClientEvent } from "../lib/analytics/track"
import type { Env } from "../types"

const analytics = new Hono<{ Bindings: Env }>()

analytics.post("/events", async (c) => {
  const body = await c.req.json<Record<string, unknown>>().catch(() => null)
  await trackClientEvent(c.env, c.req, body ?? {})
  return c.json({ accepted: true }, 202)
})

export default analytics
