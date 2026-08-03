const SMOKE_DESCRIPTIONS = new Set([
  "Ephemeral staging smoke community for the create/provisioning path.",
  "Ephemeral staging smoke community for the song-submit path.",
  "Manual staging smoke community for the D1 provisioning seam.",
])
const SMOKE_NAME = /^(?:Community Create CI Smoke|D1 Provisioning Smoke|Song Submit CI Smoke)\b/u
const RESERVED_BINDINGS = new Set(["DB_CMTY_FIXTURE", "DB_CMTY_PILOT"])

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

export function classifyReclamationCandidate(row: ReclamationInventoryRow): CandidateDecision {
  const recognized = SMOKE_DESCRIPTIONS.has(row.description ?? "") || SMOKE_NAME.test(row.display_name)
  const exclusions: string[] = []
  if (!recognized) exclusions.push("unrecognized_smoke_signature")
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
