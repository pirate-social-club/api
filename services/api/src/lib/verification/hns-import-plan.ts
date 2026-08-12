import { internalError } from "../errors"

export type HnsRawResourceRecord = Record<string, unknown>

export type HnsImportPublishPlan = {
  version: "hns_import_publish_v1"
  replacement_semantics: "complete_resource"
  current_records: HnsRawResourceRecord[]
  preserved_records: HnsRawResourceRecord[]
  removed_conflicts: HnsRawResourceRecord[]
  added_records: HnsRawResourceRecord[]
  replacement_records: HnsRawResourceRecord[]
  preserved_unknown_record_types: string[]
  acknowledgement_required: true
}

export type HnsImportChallengePayload = {
  kind: "hns_import"
  publish_plan: HnsImportPublishPlan
  observed_chain_anchor: {
    network: string
    height: number
    block_hash: string
    median_time: number
  }
  update_observed_height?: number
  target_tree_boundary?: number
  replacement_acknowledged_at?: string
  observation?: {
    state: "waiting_for_update" | "resource_mismatch" | "pending_tree_commit" | "delegation_not_secure" | "secure"
    current_height: number
    target_tree_boundary?: number
    missing_records?: HnsRawResourceRecord[]
    unexpected_records?: HnsRawResourceRecord[]
  }
}

const EVALUATED_RECORD_TYPES = new Set(["NS", "TXT", "DS", "GLUE4", "GLUE6"])

function cloneRecords(records: HnsRawResourceRecord[]): HnsRawResourceRecord[] {
  return structuredClone(records)
}

function isPirateVerificationTxt(record: HnsRawResourceRecord): boolean {
  return record.type === "TXT"
    && Array.isArray(record.txt)
    && record.txt.every((chunk) => typeof chunk === "string")
    && record.txt.join("").startsWith("pirate-verification=")
}

function parseDsRecord(value: string): HnsRawResourceRecord {
  const parts = value.trim().split(/\s+/u)
  if (parts.length !== 4) {
    throw internalError("HNS zone returned a malformed DS record")
  }
  const [keyTagRaw, algorithmRaw, digestTypeRaw, digestRaw] = parts
  const keyTag = Number(keyTagRaw)
  const algorithm = Number(algorithmRaw)
  const digestType = Number(digestTypeRaw)
  const digest = digestRaw?.toLowerCase() ?? ""
  const expectedDigestLength = digestType === 2 ? 64 : digestType === 4 ? 96 : null
  if (
    !Number.isSafeInteger(keyTag)
    || !Number.isSafeInteger(algorithm)
    || expectedDigestLength == null
    || digest.length !== expectedDigestLength
    || !/^[0-9a-f]+$/u.test(digest)
  ) {
    throw internalError("HNS zone returned an invalid DS digest")
  }
  return { type: "DS", keyTag, algorithm, digestType, digest }
}

export function buildHnsImportPublishPlan(input: {
  currentRecords: HnsRawResourceRecord[]
  nameservers: string[]
  challengeTxtValue: string
  dsRecords: string[]
}): HnsImportPublishPlan {
  const nameservers = [...new Set(input.nameservers.map((value) => value.trim()).filter(Boolean))]
  if (nameservers.length < 2) {
    throw internalError("HNS import requires two authoritative nameservers")
  }
  const challengeTxtValue = input.challengeTxtValue.trim()
  if (!challengeTxtValue.startsWith("pirate-verification=")) {
    throw internalError("HNS import challenge is invalid")
  }

  const dsRecords = input.dsRecords.map(parseDsRecord)
  const digestTypes = new Set(dsRecords.map((record) => record.digestType))
  const keyIdentities = new Set(dsRecords.map((record) => `${record.keyTag}:${record.algorithm}`))
  if (dsRecords.length !== 2 || !digestTypes.has(2) || !digestTypes.has(4) || keyIdentities.size !== 1) {
    throw internalError("HNS import requires matching SHA-256 and SHA-384 DS records")
  }

  const currentRecords = cloneRecords(input.currentRecords)
  const preservedRecords: HnsRawResourceRecord[] = []
  const removedConflicts: HnsRawResourceRecord[] = []
  const unknownTypes = new Set<string>()
  for (const record of currentRecords) {
    const type = typeof record.type === "string" ? record.type : ""
    if (type === "NS" || type === "DS" || isPirateVerificationTxt(record)) {
      removedConflicts.push(record)
      continue
    }
    preservedRecords.push(record)
    if (!EVALUATED_RECORD_TYPES.has(type)) unknownTypes.add(type || "UNKNOWN")
  }

  const addedRecords: HnsRawResourceRecord[] = [
    ...nameservers.map((ns) => ({ type: "NS", ns })),
    { type: "TXT", txt: [challengeTxtValue] },
    ...dsRecords,
  ]

  return {
    version: "hns_import_publish_v1",
    replacement_semantics: "complete_resource",
    current_records: currentRecords,
    preserved_records: cloneRecords(preservedRecords),
    removed_conflicts: cloneRecords(removedConflicts),
    added_records: cloneRecords(addedRecords),
    replacement_records: cloneRecords([...preservedRecords, ...addedRecords]),
    preserved_unknown_record_types: [...unknownTypes].sort(),
    acknowledgement_required: true,
  }
}

function canonicalJson(value: unknown): string {
  if (Array.isArray(value)) return `[${value.map(canonicalJson).join(",")}]`
  if (value && typeof value === "object") {
    const record = value as Record<string, unknown>
    return `{${Object.keys(record).sort().map((key) => `${JSON.stringify(key)}:${canonicalJson(record[key])}`).join(",")}}`
  }
  return JSON.stringify(value)
}

function recordMultiset(records: HnsRawResourceRecord[]): Map<string, number> {
  const values = new Map<string, number>()
  for (const record of records) {
    const key = canonicalJson(record)
    values.set(key, (values.get(key) ?? 0) + 1)
  }
  return values
}

export function compareHnsImportResource(
  expected: HnsRawResourceRecord[],
  observed: HnsRawResourceRecord[],
): { matches: boolean; missing: HnsRawResourceRecord[]; unexpected: HnsRawResourceRecord[] } {
  const remainingObserved = recordMultiset(observed)
  const missing: HnsRawResourceRecord[] = []
  for (const record of expected) {
    const key = canonicalJson(record)
    const count = remainingObserved.get(key) ?? 0
    if (count === 0) missing.push(structuredClone(record))
    else remainingObserved.set(key, count - 1)
  }

  const remainingExpected = recordMultiset(expected)
  const unexpected: HnsRawResourceRecord[] = []
  for (const record of observed) {
    const key = canonicalJson(record)
    const count = remainingExpected.get(key) ?? 0
    if (count === 0) unexpected.push(structuredClone(record))
    else remainingExpected.set(key, count - 1)
  }
  return { matches: missing.length === 0 && unexpected.length === 0, missing, unexpected }
}

export function parseHnsImportChallengePayload(value: unknown): HnsImportChallengePayload | null {
  if (!value || typeof value !== "object") return null
  const payload = value as Partial<HnsImportChallengePayload>
  if (payload.kind !== "hns_import" || !payload.publish_plan || !payload.observed_chain_anchor) return null
  if (
    payload.publish_plan.version !== "hns_import_publish_v1"
    || payload.publish_plan.replacement_semantics !== "complete_resource"
    || !Array.isArray(payload.publish_plan.replacement_records)
    || !Number.isSafeInteger(payload.observed_chain_anchor.height)
  ) return null
  return payload as HnsImportChallengePayload
}

export function nextHnsTreeBoundary(updateObservedHeight: number): number {
  if (!Number.isSafeInteger(updateObservedHeight) || updateObservedHeight < 0) {
    throw internalError("HNS update observation height is invalid")
  }
  return Math.ceil((updateObservedHeight + 1) / 36) * 36
}

export function resolveHnsImportTreeProgress(input: {
  currentHeight: number
  updateObservedHeight?: number
  targetTreeBoundary?: number
}): {
  updateObservedHeight: number | null
  targetTreeBoundary: number | null
  pendingTreeCommit: boolean
} {
  if (!Number.isSafeInteger(input.currentHeight) || input.currentHeight < 0) {
    throw internalError("HNS parent observation height is invalid")
  }

  // A matching parent resource is already authoritative committed state. The
  // current chain tip is not an UPDATE height, so never derive a new future
  // boundary from it. Only a height previously recorded while observing the
  // mined UPDATE may authorize the pending-boundary UI.
  const updateObservedHeight = input.updateObservedHeight
  if (
    typeof updateObservedHeight !== "number"
    ||
    !Number.isSafeInteger(updateObservedHeight)
    || updateObservedHeight < 0
  ) {
    return {
      updateObservedHeight: null,
      targetTreeBoundary: null,
      pendingTreeCommit: false,
    }
  }

  const requestedTargetTreeBoundary = input.targetTreeBoundary
  const targetTreeBoundary = typeof requestedTargetTreeBoundary === "number"
    && Number.isSafeInteger(requestedTargetTreeBoundary)
    && requestedTargetTreeBoundary >= 0
    ? requestedTargetTreeBoundary
    : nextHnsTreeBoundary(updateObservedHeight)

  return {
    updateObservedHeight,
    targetTreeBoundary,
    // Equality means the boundary has been reached.
    pendingTreeCommit: input.currentHeight < targetTreeBoundary,
  }
}
