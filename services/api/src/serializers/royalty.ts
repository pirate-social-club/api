import type {
  ClaimableRoyaltiesResponse,
  RoyaltyActivityResponse,
  RoyaltyClaimHistoryResponse,
  RoyaltyClaimRecord,
} from "../types"

export function serializeClaimableRoyalties(response: ClaimableRoyaltiesResponse): ClaimableRoyaltiesResponse {
  return response
}

export function serializeRoyaltyActivity(response: RoyaltyActivityResponse): RoyaltyActivityResponse {
  return response
}

export function serializeRoyaltyClaimHistory(response: RoyaltyClaimHistoryResponse): RoyaltyClaimHistoryResponse {
  return response
}

export function serializeRoyaltyClaimRecord(record: RoyaltyClaimRecord): RoyaltyClaimRecord {
  return record
}
