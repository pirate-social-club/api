import { isRecognizedStagingSmoke } from "../../src/lib/communities/staging-smoke-signatures"
const RESERVED_BINDINGS = new Set(["DB_CMTY_FIXTURE", "DB_CMTY_PILOT"])

// --- Environment gate -------------------------------------------------------
//
// This inventory is READ-ONLY: it classifies reclamation candidates; it does
// not reclaim, release, or delete anything, and nothing in this file may ever
// gain that ability. The default gate stays staging-only and the legacy
// refusal error must survive intact. The `--prod` opt-in returns a SCOPED
// allowance — { environment: "prod", mode: "inventory-readonly" } — that only
// this read-only inventory consumes. It is deliberately NOT an ENVIRONMENT
// override and must never be written back into process.env: any future
// reclaim/release/delete path needs its own dedicated guard (and its own
// review), and must not ride this value.
export type ReclamationInventoryScope =
  | { environment: "staging" }
  | { environment: "prod"; mode: "inventory-readonly" }

export function resolveReclamationInventoryScope(
  args: readonly string[],
  env: Record<string, string | undefined>,
): ReclamationInventoryScope {
  if (args.includes("--prod")) return { environment: "prod", mode: "inventory-readonly" }
  if (String(env.ENVIRONMENT ?? "").trim().toLowerCase() !== "staging") {
    throw new Error("refusing_reclamation_inventory_outside_staging")
  }
  return { environment: "staging" }
}

// --- Pool database id -------------------------------------------------------
//
// community-d1-shard/wrangler.jsonc carries the staging D1_POOL binding at the
// top level and the production one inside "env".production. The environment
// selects which section is scanned; the extraction regex is shared.
const D1_POOL_ID = /\{\s*"binding"\s*:\s*"D1_POOL"[\s\S]*?"database_id"\s*:\s*"([0-9a-f-]+)"/u

export function poolDatabaseIdFromConfig(configText: string, environment: "staging" | "prod"): string {
  const envSectionStart = configText.search(/"env"\s*:/u)
  const section = environment === "prod"
    ? configText.slice(envSectionStart < 0 ? configText.length : envSectionStart)
    : configText.slice(0, envSectionStart < 0 ? configText.length : envSectionStart)
  const match = section.match(D1_POOL_ID)
  if (!match?.[1]) throw new Error(`${environment} D1_POOL database id not found in wrangler config`)
  return match[1]
}

// --- Prod cohort allowlist ----------------------------------------------------
//
// One binding name per line; blank lines and `#` comments are ignored. The
// motivating use is a small operator-named cohort (e.g. the 2026-08-04
// abandoned smoke shards DB_CMTY_0076-0089), never fleet-wide matching.
export function parseBindingAllowlist(text: string): Set<string> {
  const bindings = new Set<string>()
  for (const line of text.split(/\r?\n/u)) {
    const trimmed = line.trim()
    if (!trimmed || trimmed.startsWith("#")) continue
    bindings.add(trimmed)
  }
  return bindings
}

// Evidence for the smoke-signature eligibility check. Staging applies the
// staging smoke signature set. Prod MUST NOT treat those staging-derived
// signatures as prod evidence, so prod classification is instead restricted to
// an explicit operator-named cohort allowlist of binding names.
export type SignatureEvidence =
  | { mode: "staging" }
  | { mode: "prod-allowlist"; allowlist: ReadonlySet<string> }

export type ReclamationInventoryRow = {
  community_id: string
  display_name: string
  description: string | null
  community_status: string
  binding_name: string
  provisioning_state: string
  decommissioned_at: unknown
  active_jobs: number
  pool_community_id: string | null
  pool_version: number | null
  allocated_at: string | null
  last_loaded_at: string | null
  last_error: string | null
  released_at: string | null
}

export type CandidateDecision = ReclamationInventoryRow & {
  eligible: boolean
  exclusions: string[]
}

export function classifyReclamationCandidate(
  row: ReclamationInventoryRow,
  evidence: SignatureEvidence = { mode: "staging" },
): CandidateDecision {
  const exclusions: string[] = []
  if (evidence.mode === "prod-allowlist") {
    if (!evidence.allowlist.has(row.binding_name)) exclusions.push("outside_prod_cohort_allowlist")
  } else if (!isRecognizedStagingSmoke(row)) {
    exclusions.push("unrecognized_smoke_signature")
  }
  if (!["archived", "deleted"].includes(row.community_status)) exclusions.push("community_not_archived_or_deleted")
  if (!row.binding_name) exclusions.push("routing_binding_missing")
  if (RESERVED_BINDINGS.has(row.binding_name)) exclusions.push("reserved_binding")
  if (row.provisioning_state === "decommissioned" || row.decommissioned_at) exclusions.push("routing_decommissioned")
  if (row.active_jobs > 0) exclusions.push("active_job")
  if (row.pool_community_id !== row.community_id) exclusions.push("pool_routing_mismatch")
  if (row.pool_version === null || !Number.isSafeInteger(row.pool_version)) exclusions.push("pool_version_missing")
  if (!row.last_loaded_at) exclusions.push("binding_not_loaded")
  if (row.last_error === "decommissioning") exclusions.push("decommission_in_progress")
  else if (row.last_error) exclusions.push("pool_error")
  if (row.released_at) exclusions.push("pool_row_released")
  return { ...row, eligible: exclusions.length === 0, exclusions }
}
