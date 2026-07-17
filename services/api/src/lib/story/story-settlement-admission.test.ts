import { describe, expect, test } from "bun:test"

import {
  isStorySettlementCoordinatorAdmissionEnabled,
  parseStorySettlementAdmissionCommunityIds,
} from "./story-settlement-admission"

const CANARY = "cmt_canary"
const OTHER = "cmt_other"

function env(enabled?: string, communityIds?: string) {
  return {
    STORY_SETTLEMENT_COORDINATOR_ADMISSION_ENABLED: enabled,
    STORY_SETTLEMENT_COORDINATOR_ADMISSION_COMMUNITY_IDS: communityIds,
  }
}

describe("Story settlement coordinator admission", () => {
  test("admits only a community named in the allowlist while the flag is on", () => {
    expect(isStorySettlementCoordinatorAdmissionEnabled(env("true", CANARY), CANARY)).toBe(true)
    expect(isStorySettlementCoordinatorAdmissionEnabled(env("true", CANARY), OTHER)).toBe(false)
  })

  test("requires both keys, so neither alone admits anything", () => {
    expect(isStorySettlementCoordinatorAdmissionEnabled(env("true", undefined), CANARY)).toBe(false)
    expect(isStorySettlementCoordinatorAdmissionEnabled(env("true", ""), CANARY)).toBe(false)
    expect(isStorySettlementCoordinatorAdmissionEnabled(env("true", "   ,  "), CANARY)).toBe(false)
    expect(isStorySettlementCoordinatorAdmissionEnabled(env(undefined, CANARY), CANARY)).toBe(false)
    expect(isStorySettlementCoordinatorAdmissionEnabled(env("false", CANARY), CANARY)).toBe(false)
  })

  test("rejects a non-exact flag rather than coercing it", () => {
    for (const value of ["1", "yes", "TRUE", "TRUE ", " true", "true "]) {
      expect(isStorySettlementCoordinatorAdmissionEnabled(env(value, CANARY), CANARY)).toBe(false)
    }
  })

  test("matches community ids exactly and never by prefix", () => {
    expect(isStorySettlementCoordinatorAdmissionEnabled(env("true", CANARY), `${CANARY}_extra`)).toBe(false)
    expect(isStorySettlementCoordinatorAdmissionEnabled(env("true", `${CANARY}_extra`), CANARY)).toBe(false)
    expect(isStorySettlementCoordinatorAdmissionEnabled(env("true", CANARY), "")).toBe(false)
  })

  test("parses a padded multi-community list and ignores empty entries", () => {
    expect(parseStorySettlementAdmissionCommunityIds(` ${CANARY} , ,${OTHER},`))
      .toEqual(new Set([CANARY, OTHER]))
    expect(isStorySettlementCoordinatorAdmissionEnabled(env("true", ` ${CANARY} , ${OTHER} `), OTHER)).toBe(true)
    expect(parseStorySettlementAdmissionCommunityIds(undefined)).toEqual(new Set())
  })
})
