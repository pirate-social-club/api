type JsonResult = {
  status: number
  body: unknown
}

const REVIEW_RESOLUTIONS = new Set(["completed", "no_show_host", "no_show_booker"])

export const BOOKING_REVIEW_SMOKE_USAGE = `Usage:
  bun run smoke:booking-review -- [options]

Modes:
  list pending reviews (default):
    bun run smoke:booking-review -- --origin https://api-staging.pirate.sc

  get one review:
    bun run smoke:booking-review -- --booking-id bkg_...

  resolve one review:
    bun run smoke:booking-review -- --resolve --booking-id bkg_... --resolution no_show_host --expected-review-version 1

Options:
  --origin URL                         API origin. Defaults to https://api-staging.pirate.sc.
  --operator-credential-env NAME       Env var containing "opc_....secret". Defaults to PIRATE_BOOKING_SETTLEMENT_OPERATOR_CREDENTIAL.
  --booking-id ID                      Booking review to get or resolve.
  --resolution VALUE                   completed | no_show_host | no_show_booker.
  --expected-review-version N          Required with --resolve. CAS version from the pending review.
  --source-community-id ID             Optional pending-review list filter.
  --limit N                            Pending-review list page size, 1..100.
  --cursor VALUE                       Pending-review list cursor.
  --note TEXT                          Optional operator note for --resolve.
  --resolve                            Mutates the review and may trigger payout/refund settlement.
`

function arg(name: string): string | null {
  const args = process.argv.slice(2)
  const index = args.indexOf(name)
  return index >= 0 ? args[index + 1] ?? null : null
}

function flag(name: string): boolean {
  return process.argv.includes(name)
}

function env(name: string): string {
  return String(process.env[name] ?? "").trim()
}

export function buildOperatorAuthorization(credential: string): string {
  const trimmed = credential.trim()
  if (!/^opc_[A-Za-z0-9_.-]+\.[A-Za-z0-9_-]+$/u.test(trimmed)) {
    throw new Error("operator credential must look like opc_....secret")
  }
  return `Operator ${trimmed}`
}

export function parseReviewResolution(value: string | null): "completed" | "no_show_host" | "no_show_booker" {
  const resolution = String(value ?? "").trim()
  if (!REVIEW_RESOLUTIONS.has(resolution)) {
    throw new Error("--resolution must be completed, no_show_host, or no_show_booker")
  }
  return resolution as "completed" | "no_show_host" | "no_show_booker"
}

export function parseExpectedReviewVersion(value: string | null): number {
  if (value == null || value.trim() === "") {
    throw new Error("--expected-review-version must be a non-negative integer")
  }
  const parsed = Number(value)
  if (!Number.isInteger(parsed) || parsed < 0) {
    throw new Error("--expected-review-version must be a non-negative integer")
  }
  return parsed
}

export function parseLimit(value: string | null): number | null {
  if (value == null) return null
  const parsed = Number(value)
  if (!Number.isInteger(parsed) || parsed < 1 || parsed > 100) {
    throw new Error("--limit must be an integer from 1 to 100")
  }
  return parsed
}

function asRecord(value: unknown): Record<string, unknown> {
  return value && typeof value === "object" ? value as Record<string, unknown> : {}
}

async function requestJson(url: string, init: RequestInit = {}): Promise<JsonResult> {
  const response = await fetch(url, init)
  const text = await response.text()
  let body: unknown = null
  if (text) {
    try {
      body = JSON.parse(text)
    } catch {
      body = { raw: text.slice(0, 1000) }
    }
  }
  return { status: response.status, body }
}

function requireStatus(step: string, result: JsonResult, expected: number | number[]): Record<string, unknown> {
  const expectedStatuses = Array.isArray(expected) ? expected : [expected]
  if (!expectedStatuses.includes(result.status)) {
    throw new Error(`${step} failed: status=${result.status} body=${JSON.stringify(result.body).slice(0, 1000)}`)
  }
  return asRecord(result.body)
}

function printStep(step: string, body: Record<string, unknown>): void {
  console.log(JSON.stringify({ step, ...body }, null, 2))
}

async function main(): Promise<void> {
  if (flag("--help") || flag("-h")) {
    console.log(BOOKING_REVIEW_SMOKE_USAGE)
    return
  }

  const origin = (arg("--origin") || "https://api-staging.pirate.sc").replace(/\/+$/, "")
  const credentialEnv = arg("--operator-credential-env") || "PIRATE_BOOKING_SETTLEMENT_OPERATOR_CREDENTIAL"
  const authorization = buildOperatorAuthorization(env(credentialEnv))
  const bookingId = arg("--booking-id")
  const resolve = flag("--resolve")

  if (resolve) {
    if (!bookingId) throw new Error("--resolve requires --booking-id")
    const resolution = parseReviewResolution(arg("--resolution"))
    const expectedReviewVersion = parseExpectedReviewVersion(arg("--expected-review-version"))
    const resolved = await requestJson(`${origin}/bookings/${encodeURIComponent(bookingId)}/settlement-review/resolve`, {
      method: "POST",
      headers: {
        authorization,
        "content-type": "application/json",
      },
      body: JSON.stringify({
        expected_review_version: expectedReviewVersion,
        note: arg("--note"),
        resolution,
      }),
    })
    const body = requireStatus("resolve_review", resolved, [200, 202])
    printStep("review_resolved", {
      booking: body.booking ?? null,
      pending_settlement: body.pending_settlement ?? null,
      replayed: body.replayed ?? null,
      resolution: body.resolution ?? resolution,
      status: resolved.status,
    })
    return
  }

  if (bookingId) {
    const review = await requestJson(`${origin}/bookings/${encodeURIComponent(bookingId)}/settlement-review`, {
      headers: { authorization },
    })
    const body = requireStatus("get_review", review, 200)
    printStep("review", { review: body.review ?? null })
    return
  }

  const url = new URL(`${origin}/bookings/settlement-review/pending`)
  const sourceCommunityId = arg("--source-community-id")
  const limit = parseLimit(arg("--limit"))
  const cursor = arg("--cursor")
  if (sourceCommunityId) url.searchParams.set("source_community_id", sourceCommunityId)
  if (limit != null) url.searchParams.set("limit", String(limit))
  if (cursor) url.searchParams.set("cursor", cursor)

  const pending = await requestJson(url.toString(), {
    headers: { authorization },
  })
  const body = requireStatus("list_pending_reviews", pending, 200)
  printStep("pending_reviews", body)
}

if (import.meta.main) {
  main().catch((error) => {
    console.error(error)
    process.exit(1)
  })
}
