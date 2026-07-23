/**
 * Staging smoke for the community soft-archive lifecycle (PR #64).
 *
 * Flow: create an owned community → confirm it's publicly visible → archive →
 * confirm public preview 404s AND a guarded write (live-room create) is rejected →
 * unarchive → confirm visible again and the guarded write no longer reports
 * "community not found". Proves the deployed worker + real control-plane status +
 * isCommunityLive enforcement, end to end.
 *
 * Usage (staging secret injected via Infisical):
 *   infisical run --project-config-dir ../../core --env staging --path /services/api -- \
 *     bun scripts/smoke-community-archive.ts --api-base https://api-staging.pirate.sc
 */
import { SignJWT } from "jose"
import { Wallet } from "ethers"
import { allocationAttributionHeaders } from "./_lib/allocation-attribution"

function readArg(name: string): string | undefined {
  const i = process.argv.indexOf(name)
  return i >= 0 ? process.argv[i + 1] : undefined
}

const API_BASE = (readArg("--api-base") || "https://api-staging.pirate.sc").replace(/\/$/, "")
const RUN_ID = `${Math.floor(Date.now() / 1000)}-${Wallet.createRandom().address.slice(2, 8)}`

function jwtConfig() {
  const issuer = process.env.AUTH_UPSTREAM_JWT_ISSUER?.trim()
    || process.env.JWT_BASED_AUTH_ISSUERS?.split(",")[0]?.trim()
    || "pirate-staging-upstream"
  const audience = process.env.AUTH_UPSTREAM_JWT_AUDIENCE?.trim()
    || process.env.JWT_BASED_AUTH_AUDIENCE?.trim()
    || "pirate-api-staging"
  const secret = process.env.AUTH_UPSTREAM_JWT_SHARED_SECRET?.trim()
    || process.env.JWT_BASED_AUTH_SHARED_SECRET?.trim()
    || ""
  if (!secret) throw new Error("AUTH_UPSTREAM_JWT_SHARED_SECRET / JWT_BASED_AUTH_SHARED_SECRET required (inject via Infisical staging)")
  return { issuer, audience, secret }
}

type ApiResult<T> = { status: number; body: T }

async function apiResult<T>(input: { path: string; method?: string; body?: unknown; token?: string | null; noCache?: boolean; headers?: Record<string, string> }): Promise<ApiResult<T>> {
  const method = input.method ?? (input.body == null ? "GET" : "POST")
  // Cache-bust GET reads so we observe live control-plane state, not a CDN-cached preview.
  const path = input.noCache ? `${input.path}${input.path.includes("?") ? "&" : "?"}_cb=${Date.now()}-${Math.random().toString(36).slice(2)}` : input.path
  const res = await fetch(`${API_BASE}${path}`, {
    method,
    headers: {
      ...(input.token ? { authorization: `Bearer ${input.token}` } : {}),
      ...(input.body == null ? {} : { "content-type": "application/json" }),
      ...(input.noCache ? { "cache-control": "no-cache", "pragma": "no-cache" } : {}),
      ...input.headers,
    },
    body: input.body == null ? undefined : JSON.stringify(input.body),
  })
  const text = await res.text()
  let body: unknown = text
  try { body = text ? JSON.parse(text) : null } catch { /* keep text */ }
  return { status: res.status, body: body as T }
}

async function api<T>(input: { path: string; method?: string; body?: unknown; token?: string | null; ok?: number[]; headers?: Record<string, string> }): Promise<T> {
  const r = await apiResult<T>(input)
  const ok = input.ok ?? [200, 201, 202]
  if (!ok.includes(r.status)) {
    throw new Error(`${input.method ?? "GET"} ${input.path} -> ${r.status}: ${JSON.stringify(r.body)}`)
  }
  return r.body
}

function assert(cond: unknown, msg: string): asserts cond {
  if (!cond) throw new Error(`ASSERT FAILED: ${msg}`)
}

async function createOwnerSession(): Promise<{ token: string; userId: string }> {
  const cfg = jwtConfig()
  const wallet = Wallet.createRandom()
  const jwt = await new SignJWT({ wallet_address: wallet.address })
    .setProtectedHeader({ alg: "HS256", typ: "JWT" })
    .setIssuer(cfg.issuer).setAudience(cfg.audience).setSubject(`usr_sa_smoke_${RUN_ID}`)
    .setIssuedAt().setExpirationTime("30m")
    .sign(new TextEncoder().encode(cfg.secret))
  const body = await api<{ access_token: string; user: { id: string } }>({
    path: "/auth/session/exchange",
    body: { proof: { jwt, type: "jwt_based_auth" } },
  })
  return { token: body.access_token, userId: body.user.id }
}

async function createCommunity(token: string): Promise<string> {
  const created = await api<{ community: { id: string }; job: { id: string; status: string } }>({
    path: "/communities",
    body: {
      display_name: `SoftArchive Smoke ${RUN_ID}`,
      handle_policy: { policy_template: "standard" },
      membership_mode: "request",
    },
    token,
    headers: allocationAttributionHeaders("api-script:smoke-community-archive"),
  })
  if (created.job.status !== "succeeded") {
    const start = Date.now()
    for (;;) {
      const job = await api<{ status: string; error_code?: string | null }>({ path: `/jobs/${created.job.id}`, token })
      if (job.status === "succeeded") break
      if (job.status === "failed") throw new Error(`provisioning job failed: ${job.error_code}`)
      if (Date.now() - start > 180000) throw new Error("provisioning job timed out")
      await new Promise((r) => setTimeout(r, 3000))
    }
  }
  return created.community.id
}

async function main() {
  console.log(`[sa-smoke] api=${API_BASE} run=${RUN_ID}`)
  const owner = await createOwnerSession()
  console.log(`[sa-smoke] owner user=${owner.userId}`)

  const communityId = await createCommunity(owner.token)
  console.log(`[sa-smoke] community=${communityId}`)

  // 1. Visible while active
  const previewActive = await apiResult<unknown>({ path: `/public-communities/${communityId}`, noCache: true })
  assert(previewActive.status === 200, `active preview should be 200, got ${previewActive.status}`)
  console.log("[sa-smoke] ✓ active community visible in public preview")

  // 2. Archive
  const archived = await api<{ community_id: string; status: string }>({
    path: `/communities/${communityId}/archive`, method: "POST", body: {}, token: owner.token,
  })
  assert(archived.status === "archived", `archive should return status=archived, got ${archived.status}`)
  console.log("[sa-smoke] ✓ archive -> 200 status=archived")

  // 3. Public single-community preview behavior (observation, not a hard gate — see report)
  const previewArchived = await apiResult<unknown>({ path: `/public-communities/${communityId}`, noCache: true })
  assert(previewArchived.status === 404, `archived preview should 404 (cache-busted), got ${previewArchived.status}`)
  console.log("[sa-smoke] ✓ archived community hidden from public preview (404, cache-busted)")

  // 4. Guarded write rejected while archived
  const guardedWrite = await apiResult<unknown>({
    path: `/communities/${communityId}/live-rooms`, method: "POST",
    body: { title: "smoke", description: "smoke" }, token: owner.token,
  })
  assert(guardedWrite.status >= 400, `live-room create on archived community should be rejected, got ${guardedWrite.status}`)
  console.log(`[sa-smoke] ✓ guarded write (live-room create) rejected while archived (${guardedWrite.status})`)

  // 5. Unarchive
  const unarchived = await api<{ community_id: string; status: string }>({
    path: `/communities/${communityId}/unarchive`, method: "POST", body: {}, token: owner.token,
  })
  assert(unarchived.status === "active", `unarchive should return status=active, got ${unarchived.status}`)
  console.log("[sa-smoke] ✓ unarchive -> 200 status=active")

  // 6. Visible again + guard no longer reports community-not-found
  const previewRestored = await apiResult<unknown>({ path: `/public-communities/${communityId}`, noCache: true })
  assert(previewRestored.status === 200, `restored preview should be 200, got ${previewRestored.status}`)
  console.log("[sa-smoke] ✓ community publicly visible after unarchive")
  const guardAfter = await apiResult<{ error?: { code?: string } }>({
    path: `/communities/${communityId}/live-rooms`, method: "POST",
    body: { title: "smoke", description: "smoke" }, token: owner.token,
  })
  const code = (guardAfter.body as { error?: { code?: string } })?.error?.code ?? ""
  assert(!/not_found|community_not_found/i.test(code) && guardAfter.status !== 404,
    `after unarchive the live guard should pass (no community-not-found); got ${guardAfter.status} ${code}`)
  console.log(`[sa-smoke] ✓ community visible again; live guard passes after unarchive (write status ${guardAfter.status})`)

  console.log("\n[sa-smoke] ALL CHECKS PASSED ✅")
}

main().catch((err) => {
  console.error("\n[sa-smoke] FAILED ❌", err instanceof Error ? err.message : err)
  process.exit(1)
})
