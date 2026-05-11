import { rateLimited } from "../errors"
import { getControlPlaneClient } from "../runtime-deps"
import type { Env } from "../../env"

function parseIntegerEnv(value: string | undefined, fallback: number): number {
  const parsed = Number(value)
  return Number.isInteger(parsed) && parsed > 0 ? parsed : fallback
}

function resolveClientIp(headers: Record<string, string | undefined>): string {
  const cf = headers["cf-connecting-ip"]?.trim()
  if (cf) return cf
  const xff = headers["x-forwarded-for"]?.trim()
  if (xff) return xff.split(",")[0].trim()
  return "unknown"
}

async function upsertAndGetCount(input: {
  client: ReturnType<typeof getControlPlaneClient>
  actorKind: "ip" | "wallet"
  actorId: string
  windowStart: string
  nowIso: string
}): Promise<number> {
  const result = await input.client.execute({
    sql: `
      INSERT INTO public_name_quote_rate_limits (actor_kind, actor_id, window_start, request_count, updated_at)
      VALUES (?1, ?2, ?3, 1, ?4)
      ON CONFLICT(actor_kind, actor_id, window_start) DO UPDATE SET
        request_count = public_name_quote_rate_limits.request_count + 1,
        updated_at = excluded.updated_at
      RETURNING request_count
    `,
    args: [input.actorKind, input.actorId, input.windowStart, input.nowIso],
  })
  return Number(result.rows[0]?.request_count ?? 0)
}

export async function enforcePublicNameQuoteRateLimit(input: {
  env: Env
  headers: Record<string, string | undefined>
  buyerWalletAddress: string
  now?: Date
}): Promise<void> {
  const client = getControlPlaneClient(input.env)
  const now = input.now ?? new Date()
  const windowSeconds = parseIntegerEnv(
    input.env.PUBLIC_NAME_QUOTE_RATE_LIMIT_WINDOW_SECONDS,
    60,
  )
  const windowStartSeconds =
    Math.floor(Math.floor(now.getTime() / 1000) / windowSeconds) * windowSeconds
  const windowStart = new Date(windowStartSeconds * 1000).toISOString()
  const nowIso = now.toISOString()

  const ip = resolveClientIp(input.headers)
  const wallet = input.buyerWalletAddress

  // Prune old windows
  const retentionMs = windowSeconds * 10 * 1000
  await client.execute({
    sql: "DELETE FROM public_name_quote_rate_limits WHERE window_start < ?1",
    args: [new Date(now.getTime() - retentionMs).toISOString()],
  })

  const ipLimit = parseIntegerEnv(input.env.PUBLIC_NAME_QUOTE_RATE_LIMIT_IP, 10)
  const walletLimit = parseIntegerEnv(
    input.env.PUBLIC_NAME_QUOTE_RATE_LIMIT_WALLET,
    5,
  )

  // Atomic IP increment + check
  const ipCount = await upsertAndGetCount({
    client,
    actorKind: "ip",
    actorId: ip,
    windowStart,
    nowIso,
  })
  if (ipCount > ipLimit) {
    throw rateLimited("Public name quote rate limit exceeded", {
      limit: ipLimit,
      window_seconds: windowSeconds,
      actor_kind: "ip",
    })
  }

  // Atomic wallet increment + check
  const walletCount = await upsertAndGetCount({
    client,
    actorKind: "wallet",
    actorId: wallet,
    windowStart,
    nowIso,
  })
  if (walletCount > walletLimit) {
    throw rateLimited("Public name quote rate limit exceeded", {
      limit: walletLimit,
      window_seconds: windowSeconds,
      actor_kind: "wallet",
    })
  }
}
