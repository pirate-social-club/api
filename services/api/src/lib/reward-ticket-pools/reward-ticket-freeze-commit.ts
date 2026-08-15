import { AbiCoder, Interface, concat, getBytes, keccak256, toUtf8Bytes } from "ethers"

import { REWARD_TICKET_COMMITMENT_REGISTRY_ABI } from "./megapot-abi"

const ABI = AbiCoder.defaultAbiCoder()
const SNAPSHOT_DOMAIN = keccak256(toUtf8Bytes("pirate.reward-ticket-beneficiary-snapshot.v1"))
const LEAF_DOMAIN = keccak256(toUtf8Bytes("pirate.reward-ticket-pool-drawing.v1"))
const NODE_DOMAIN = getBytes(keccak256(toUtf8Bytes("pirate.reward-ticket-merkle-node.v1")))
const COMMITMENT_REGISTRY = new Interface(REWARD_TICKET_COMMITMENT_REGISTRY_ABI)

function bytes32(value: string, field: string): string {
  const normalized = value.replace(/^0x/u, "")
  if (!/^[0-9a-fA-F]{64}$/u.test(normalized)) throw new Error(`invalid_${field}`)
  return `0x${normalized}`
}

export type FrozenRewardTicketBeneficiary = Readonly<{
  rewardIdentityId: string
  userId: string
  qualificationEvidenceHash: string
  canonicalPosition: number
}>

export type RewardTicketCommitmentInput = Readonly<{
  chainId: number
  jackpotAddress: string
  drawingId: bigint
  poolId: string
  termsHash: string
  beneficiaries: readonly Omit<FrozenRewardTicketBeneficiary, "canonicalPosition">[]
}>

function canonicalBeneficiaries(
  beneficiaries: RewardTicketCommitmentInput["beneficiaries"],
): FrozenRewardTicketBeneficiary[] {
  const sorted = [...beneficiaries].sort((left, right) =>
    left.rewardIdentityId.localeCompare(right.rewardIdentityId)
      || left.userId.localeCompare(right.userId)
      || left.qualificationEvidenceHash.localeCompare(right.qualificationEvidenceHash)
  )
  if (new Set(sorted.map((row) => row.rewardIdentityId)).size !== sorted.length) {
    throw new Error("reward_ticket_beneficiary_identity_duplicate")
  }
  return sorted.map((row, canonicalPosition) => ({ ...row, canonicalPosition }))
}

function hashNode(left: string, right: string): string {
  const [first, second] = [left.toLowerCase(), right.toLowerCase()].sort()
  return keccak256(concat([NODE_DOMAIN, getBytes(first), getBytes(second)]))
}

export function freezeRewardTicketPool(input: RewardTicketCommitmentInput): Readonly<{
  beneficiaries: readonly FrozenRewardTicketBeneficiary[]
  snapshotHash: string
  leafHash: string
}> {
  if (!Number.isSafeInteger(input.chainId) || input.chainId <= 0) throw new Error("invalid_chain_id")
  if (input.beneficiaries.length === 0) throw new Error("reward_ticket_beneficiaries_empty")
  const beneficiaries = canonicalBeneficiaries(input.beneficiaries)
  const snapshotHash = keccak256(ABI.encode(
    ["bytes32", "tuple(string rewardIdentityId,string userId,bytes32 evidenceHash,uint256 position)[]"],
    [SNAPSHOT_DOMAIN, beneficiaries.map((row) => [
      row.rewardIdentityId,
      row.userId,
      bytes32(row.qualificationEvidenceHash, "qualification_evidence_hash"),
      row.canonicalPosition,
    ])],
  ))
  const leafHash = keccak256(ABI.encode(
    ["bytes32", "uint256", "address", "uint256", "string", "bytes32", "uint256", "bytes32"],
    [LEAF_DOMAIN, input.chainId, input.jackpotAddress, input.drawingId, input.poolId,
      bytes32(input.termsHash, "terms_hash"), beneficiaries.length, snapshotHash],
  ))
  return { beneficiaries, snapshotHash, leafHash }
}

export function buildRewardTicketCommitmentBatch(
  poolLeaves: readonly Readonly<{ poolDrawingId: string; leafHash: string }>[],
): Readonly<{
  poolLeaves: readonly Readonly<{ poolDrawingId: string; leafHash: string }>[]
  rootHash: string
  proofs: readonly (readonly string[])[]
}> {
  if (poolLeaves.length === 0) throw new Error("reward_ticket_commitment_batch_empty")
  const ordered = [...poolLeaves].sort((left, right) => left.poolDrawingId.localeCompare(right.poolDrawingId))
  if (new Set(ordered.map((leaf) => leaf.poolDrawingId)).size !== ordered.length) {
    throw new Error("reward_ticket_pool_drawing_duplicate")
  }
  const leaves = ordered.map((leaf) => bytes32(leaf.leafHash, "pool_leaf_hash"))
  const levels: string[][] = [leaves]
  while ((levels.at(-1)?.length ?? 0) > 1) {
    const prior = levels.at(-1) as string[]
    const next: string[] = []
    for (let index = 0; index < prior.length; index += 2) {
      next.push(hashNode(prior[index] as string, prior[index + 1] ?? prior[index] as string))
    }
    levels.push(next)
  }
  const proofs = leaves.map((_, leafIndex) => {
    const proof: string[] = []
    let index = leafIndex
    for (const level of levels.slice(0, -1)) {
      proof.push(level[index ^ 1] ?? level[index] as string)
      index = Math.floor(index / 2)
    }
    return proof
  })
  return { poolLeaves: ordered, rootHash: levels.at(-1)?.[0] as string, proofs }
}

export function buildRewardTicketCommitment(input: RewardTicketCommitmentInput): Readonly<{
  beneficiaries: readonly FrozenRewardTicketBeneficiary[]
  snapshotHash: string
  leafHash: string
  rootHash: string
  proof: readonly string[]
}> {
  const frozen = freezeRewardTicketPool(input)
  const batch = buildRewardTicketCommitmentBatch([{ poolDrawingId: input.poolId, leafHash: frozen.leafHash }])
  return { ...frozen, rootHash: batch.rootHash, proof: batch.proofs[0] as readonly string[] }
}

export type RewardTicketCommitmentBatchPublication = Readonly<{
  commitments: readonly Readonly<{
    beneficiaries: readonly FrozenRewardTicketBeneficiary[]
    snapshotHash: string
    leafHash: string
    rootHash: string
    proof: readonly string[]
  }>[]
  rootHash: string
  leafCount: number
  termsVersionHash: string
}>

export function buildRewardTicketCommitmentBatchPublication(
  inputs: readonly RewardTicketCommitmentInput[],
): RewardTicketCommitmentBatchPublication {
  if (inputs.length === 0) throw new Error("reward_ticket_commitment_batch_empty")
  const frozen = inputs.map(buildRewardTicketCommitment)
  const first = inputs[0] as RewardTicketCommitmentInput
  if (inputs.some((input) =>
    input.chainId !== first.chainId
    || input.jackpotAddress.toLowerCase() !== first.jackpotAddress.toLowerCase()
    || input.drawingId !== first.drawingId
  )) {
    throw new Error("reward_ticket_commitment_batch_identity_mismatch")
  }
  const batch = buildRewardTicketCommitmentBatch(inputs.map((input, index) => ({
    poolDrawingId: input.poolId,
    leafHash: frozen[index]?.leafHash as string,
  })))
  const byPool = new Map(batch.poolLeaves.map((leaf, index) => [leaf.poolDrawingId, index]))
  const termsVersionHash = keccak256(ABI.encode(
    ["bytes32[]"],
    [[...inputs]
      .sort((left, right) => left.poolId.localeCompare(right.poolId))
      .map((input) => bytes32(input.termsHash, "terms_hash"))],
  ))
  return {
    commitments: frozen.map((commitment, index) => {
      const poolIndex = byPool.get(inputs[index]?.poolId as string)
      if (poolIndex == null) throw new Error("reward_ticket_commitment_pool_missing")
      return {
        ...commitment,
        rootHash: batch.rootHash,
        proof: batch.proofs[poolIndex] as readonly string[],
      }
    }),
    rootHash: batch.rootHash,
    leafCount: batch.poolLeaves.length,
    termsVersionHash,
  }
}

export function encodeRewardTicketCommitmentPublication(input: Readonly<{
  jackpotAddress: string
  drawingId: bigint
  rootHash: string
  leafCount: number
  termsHash: string
}>): string {
  if (!Number.isSafeInteger(input.leafCount) || input.leafCount < 1) {
    throw new Error("reward_ticket_commitment_leaf_count_invalid")
  }
  return COMMITMENT_REGISTRY.encodeFunctionData("publish", [
    input.jackpotAddress,
    input.drawingId,
    input.rootHash,
    input.leafCount,
    bytes32(input.termsHash, "terms_hash"),
  ])
}
