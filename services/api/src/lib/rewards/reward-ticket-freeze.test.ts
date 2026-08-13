import { describe, expect, test } from "bun:test"

import {
  buildRewardTicketCommitmentBatch,
  freezeRewardTicketPool,
  verifyRewardTicketCommitmentProof,
  type RewardTicketFreezeCandidate,
} from "./reward-ticket-freeze"

const base = {
  chainId: 84532,
  jackpotAddress: "0x465dA3c859f193A3807386387bEE941B2A4c3279",
  drawingId: 141n,
  poolDrawingId: "rtd_1",
  termsHash: "11".repeat(32),
  entryOpensAt: "2026-08-13T00:00:00.000Z",
  entryCutoffAt: "2026-08-13T23:00:00.000Z",
  now: "2026-08-13T23:01:00.000Z",
  qualifyingActivity: "either" as const,
  minimumScoreBps: 8000,
}

function candidate(overrides: Partial<RewardTicketFreezeCandidate> = {}) {
  return {
    rewardIdentityId: "identity_1",
    userId: "user_1",
    eventId: "event_1",
    activity: "karaoke" as const,
    qualifiedAt: "2026-08-13T12:00:00.000Z",
    evidenceSummary: { score: 9000, session: "session_1" },
    finalScoreBps: 9000,
    ...overrides,
  }
}

describe("reward ticket daily freeze", () => {
  test("freezes a deterministic identity-sorted snapshot and verifies its proof", () => {
    const first = freezeRewardTicketPool({
      ...base,
      candidates: [candidate(), candidate({
        rewardIdentityId: "identity_2", userId: "user_2", eventId: "event_2",
        evidenceSummary: { session: "session_2", score: 8500 }, finalScoreBps: 8500,
      })],
    })
    const reordered = freezeRewardTicketPool({
      ...base,
      candidates: [candidate({
        rewardIdentityId: "identity_2", userId: "user_2", eventId: "event_2",
        evidenceSummary: { score: 8500, session: "session_2" }, finalScoreBps: 8500,
      }), candidate()],
    })
    expect(reordered.snapshotHash).toBe(first.snapshotHash)
    expect(reordered.leafHash).toBe(first.leafHash)
    const batch = buildRewardTicketCommitmentBatch([first])
    expect(verifyRewardTicketCommitmentProof({
      leafHash: first.leafHash, proof: batch.proofs[first.poolDrawingId]!, rootHash: batch.rootHash,
    })).toBe(true)
  })

  test("filters the entry window, activity, and karaoke score before freezing", () => {
    const result = freezeRewardTicketPool({
      ...base,
      qualifyingActivity: "karaoke",
      candidates: [
        candidate(),
        candidate({ rewardIdentityId: "too_early", eventId: "event_early", qualifiedAt: "2026-08-12T23:59:59.000Z" }),
        candidate({ rewardIdentityId: "too_late", eventId: "event_late", qualifiedAt: "2026-08-13T23:00:00.000Z" }),
        candidate({ rewardIdentityId: "low_score", eventId: "event_low", finalScoreBps: 7999 }),
        candidate({ rewardIdentityId: "study_excluded", eventId: "event_study", activity: "study", finalScoreBps: null }),
      ],
    })
    expect(result.beneficiaries.map((beneficiary) => beneficiary.rewardIdentityId)).toEqual(["identity_1"])
  })

  test("fails closed on duplicate identities and unfrozen entry windows", () => {
    expect(() => freezeRewardTicketPool({ ...base, candidates: [candidate(), candidate({ eventId: "event_2" })] }))
      .toThrow("reward_ticket_beneficiary_identity_duplicate")
    expect(() => freezeRewardTicketPool({ ...base, now: "2026-08-13T22:59:59.000Z", candidates: [candidate()] }))
      .toThrow("reward_ticket_entry_cutoff_not_reached")
  })

  test("supports one commitment root for multiple pool drawings", () => {
    const first = freezeRewardTicketPool({ ...base, candidates: [candidate()] })
    const second = freezeRewardTicketPool({
      ...base, poolDrawingId: "rtd_2", candidates: [candidate({
        rewardIdentityId: "identity_2", userId: "user_2", eventId: "event_2",
      })],
    })
    const batch = buildRewardTicketCommitmentBatch([second, first])
    expect(batch.leaves.map((leaf) => leaf.poolDrawingId)).toEqual(["rtd_1", "rtd_2"])
    for (const commitment of [first, second]) {
      expect(verifyRewardTicketCommitmentProof({
        leafHash: commitment.leafHash,
        proof: batch.proofs[commitment.poolDrawingId]!,
        rootHash: batch.rootHash,
      })).toBe(true)
    }
  })
})
