import { AbiCoder, concat, getBytes, keccak256, toUtf8Bytes } from "ethers"

const ABI = AbiCoder.defaultAbiCoder()
const SNAPSHOT_DOMAIN = keccak256(toUtf8Bytes("pirate.reward-ticket-beneficiary-snapshot.v1"))
const LEAF_DOMAIN = keccak256(toUtf8Bytes("pirate.reward-ticket-pool-drawing.v1"))
const NODE_DOMAIN = getBytes(keccak256(toUtf8Bytes("pirate.reward-ticket-merkle-node.v1")))

export type RewardTicketFreezeCandidate = Readonly<{
  rewardIdentityId: string
  userId: string
  eventId: string
  activity: "study" | "karaoke"
  qualifiedAt: string
  evidenceSummary: unknown
  finalScoreBps?: number | null
}>

export type FrozenRewardTicketBeneficiary = Readonly<{
  rewardIdentityId: string
  userId: string
  qualificationEventId: string
  qualificationEvidenceHash: string
  qualifiedAt: string
  canonicalPosition: number
}>

export type RewardTicketPoolFreezeInput = Readonly<{
  chainId: number
  jackpotAddress: string
  drawingId: bigint
  poolDrawingId: string
  termsHash: string
  entryOpensAt: string
  entryCutoffAt: string
  now: string
  qualifyingActivity: "karaoke" | "either"
  minimumScoreBps?: number | null
  candidates: readonly RewardTicketFreezeCandidate[]
}>

export type RewardTicketPoolCommitment = Readonly<{
  beneficiaries: readonly FrozenRewardTicketBeneficiary[]
  snapshotHash: string
  leafHash: string
  poolDrawingId: string
}>

export type RewardTicketCommitmentBatch = Readonly<{
  rootHash: string
  leaves: readonly Readonly<{ poolDrawingId: string; leafHash: string }>[]
  proofs: Readonly<Record<string, readonly string[]>>
}>

function requiredBytes32(value: string, field: string): string {
  const normalized = value.replace(/^0x/u, "")
  if (!/^[0-9a-fA-F]{64}$/u.test(normalized)) throw new Error(`${field}_invalid`)
  return `0x${normalized.toLowerCase()}`
}

function canonicalJson(value: unknown): string {
  if (value === null || typeof value === "string" || typeof value === "boolean") {
    return JSON.stringify(value)
  }
  if (typeof value === "number") {
    if (!Number.isFinite(value)) throw new Error("reward_ticket_evidence_number_invalid")
    return JSON.stringify(value)
  }
  if (Array.isArray(value)) return `[${value.map(canonicalJson).join(",")}]`
  if (typeof value === "object") {
    const record = value as Record<string, unknown>
    return `{${Object.keys(record).sort().map((key) =>
      `${JSON.stringify(key)}:${canonicalJson(record[key])}`,
    ).join(",")}}`
  }
  throw new Error("reward_ticket_evidence_value_invalid")
}

function evidenceHash(candidate: RewardTicketFreezeCandidate): string {
  return keccak256(toUtf8Bytes(canonicalJson({
    eventId: candidate.eventId,
    userId: candidate.userId,
    qualifiedAt: candidate.qualifiedAt,
    evidence: candidate.evidenceSummary,
  }))).slice(2)
}

function hashNode(left: string, right: string): string {
  const [first, second] = [left.toLowerCase(), right.toLowerCase()].sort()
  return keccak256(concat([NODE_DOMAIN, getBytes(first), getBytes(second)]))
}

function buildBatch(leaves: readonly Readonly<{ poolDrawingId: string; leafHash: string }>[]): RewardTicketCommitmentBatch {
  if (leaves.length === 0) throw new Error("reward_ticket_commitment_batch_empty")
  const ordered = [...leaves]
    .map((leaf) => ({ poolDrawingId: leaf.poolDrawingId, leafHash: requiredBytes32(leaf.leafHash, "leaf_hash") }))
    .sort((left, right) => left.poolDrawingId.localeCompare(right.poolDrawingId))
  if (ordered.some((leaf) => !leaf.poolDrawingId.trim())) throw new Error("reward_ticket_pool_drawing_id_invalid")
  if (new Set(ordered.map((leaf) => leaf.poolDrawingId)).size !== ordered.length) {
    throw new Error("reward_ticket_pool_drawing_duplicate")
  }

  const levels: string[][] = [ordered.map((leaf) => leaf.leafHash)]
  while ((levels[levels.length - 1]?.length ?? 0) > 1) {
    const previous = levels[levels.length - 1] as string[]
    const next: string[] = []
    for (let index = 0; index < previous.length; index += 2) {
      next.push(hashNode(previous[index] as string, previous[index + 1] ?? previous[index] as string))
    }
    levels.push(next)
  }

  const proofs: Record<string, readonly string[]> = {}
  for (let leafIndex = 0; leafIndex < ordered.length; leafIndex += 1) {
    const proof: string[] = []
    let index = leafIndex
    for (const level of levels.slice(0, -1)) {
      proof.push(level[index ^ 1] ?? level[index] as string)
      index = Math.floor(index / 2)
    }
    proofs[ordered[leafIndex]!.poolDrawingId] = proof
  }
  return { rootHash: levels[levels.length - 1]![0] as string, leaves: ordered, proofs }
}

function candidateIsEligible(input: RewardTicketPoolFreezeInput, candidate: RewardTicketFreezeCandidate): boolean {
  if (input.qualifyingActivity !== "either" && candidate.activity !== input.qualifyingActivity) return false
  const qualifiedAt = Date.parse(candidate.qualifiedAt)
  const opensAt = Date.parse(input.entryOpensAt)
  const cutoffAt = Date.parse(input.entryCutoffAt)
  if (![qualifiedAt, opensAt, cutoffAt].every(Number.isFinite)) throw new Error("reward_ticket_timestamp_invalid")
  if (qualifiedAt < opensAt || qualifiedAt >= cutoffAt) return false
  if (candidate.activity === "karaoke" && input.minimumScoreBps != null) {
    const score = candidate.finalScoreBps
    if (!Number.isSafeInteger(score) || (score as number) < input.minimumScoreBps) return false
  }
  return true
}

export function freezeRewardTicketPool(input: RewardTicketPoolFreezeInput): RewardTicketPoolCommitment {
  if (!Number.isSafeInteger(input.chainId) || input.chainId <= 0) throw new Error("reward_ticket_chain_id_invalid")
  if (!Number.isSafeInteger(input.minimumScoreBps ?? 0)
    || (input.minimumScoreBps != null && (input.minimumScoreBps < 0 || input.minimumScoreBps > 10000))) {
    throw new Error("reward_ticket_minimum_score_invalid")
  }
  const now = Date.parse(input.now)
  const cutoff = Date.parse(input.entryCutoffAt)
  if (!Number.isFinite(now) || !Number.isFinite(cutoff) || now < cutoff) {
    throw new Error("reward_ticket_entry_cutoff_not_reached")
  }
  if (!input.poolDrawingId.trim()) throw new Error("reward_ticket_pool_drawing_id_invalid")

  const eligible = input.candidates.filter((candidate) => candidateIsEligible(input, candidate))
  if (eligible.length === 0) throw new Error("reward_ticket_beneficiaries_empty")
  const identityIds = eligible.map((candidate) => candidate.rewardIdentityId.trim())
  if (identityIds.some((identityId) => !identityId)) throw new Error("reward_ticket_identity_invalid")
  if (new Set(identityIds).size !== identityIds.length) throw new Error("reward_ticket_beneficiary_identity_duplicate")

  const beneficiaries = [...eligible]
    .sort((left, right) => left.rewardIdentityId.localeCompare(right.rewardIdentityId)
      || left.eventId.localeCompare(right.eventId))
    .map((candidate, canonicalPosition) => ({
      rewardIdentityId: candidate.rewardIdentityId,
      userId: candidate.userId,
      qualificationEventId: candidate.eventId,
      qualificationEvidenceHash: evidenceHash(candidate),
      qualifiedAt: candidate.qualifiedAt,
      canonicalPosition,
    }))

  const snapshotHash = keccak256(ABI.encode(
    ["bytes32", "tuple(string rewardIdentityId,string userId,string qualificationEventId,bytes32 evidenceHash,string qualifiedAt,uint256 position)[]"],
    [SNAPSHOT_DOMAIN, beneficiaries.map((beneficiary) => [
      beneficiary.rewardIdentityId,
      beneficiary.userId,
      beneficiary.qualificationEventId,
      requiredBytes32(beneficiary.qualificationEvidenceHash, "qualification_evidence_hash"),
      beneficiary.qualifiedAt,
      beneficiary.canonicalPosition,
    ])],
  ))
  const leafHash = keccak256(ABI.encode(
    ["bytes32", "uint256", "address", "uint256", "string", "bytes32", "uint256", "bytes32"],
    [LEAF_DOMAIN, input.chainId, input.jackpotAddress, input.drawingId, input.poolDrawingId,
      requiredBytes32(input.termsHash, "terms_hash"), beneficiaries.length, snapshotHash],
  ))
  return {
    beneficiaries,
    snapshotHash: snapshotHash.slice(2),
    leafHash: leafHash.slice(2),
    poolDrawingId: input.poolDrawingId,
  }
}

export function buildRewardTicketCommitmentBatch(
  commitments: readonly RewardTicketPoolCommitment[],
): RewardTicketCommitmentBatch {
  return buildBatch(commitments.map((commitment) => ({
    poolDrawingId: commitment.poolDrawingId,
    leafHash: commitment.leafHash,
  })))
}

export function verifyRewardTicketCommitmentProof(input: Readonly<{
  leafHash: string
  proof: readonly string[]
  rootHash: string
}>): boolean {
  let current = requiredBytes32(input.leafHash, "leaf_hash")
  for (const sibling of input.proof) current = hashNode(current, requiredBytes32(sibling, "proof_hash"))
  return current.toLowerCase() === requiredBytes32(input.rootHash, "root_hash").toLowerCase()
}
