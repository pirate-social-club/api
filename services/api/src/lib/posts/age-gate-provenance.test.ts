import { describe, expect, test } from "bun:test"
import { resolveFinalAgeGateProvenance, resolveInitialAgeGateProvenance } from "./age-gate-provenance"

const community = { community_id: "com_1", default_age_gate_policy: "none" as const }
const now = "2026-07-31T00:00:00.000Z"

describe("age-gate provenance", () => {
  test("attributes an automated create-time gate to post moderation", () => {
    expect(resolveInitialAgeGateProvenance({
      ageGatePolicy: "18_plus",
      community,
      requestedAgeGatePolicy: "none",
      postModerationAgeGatePolicy: "18_plus",
      setAt: now,
    })).toEqual({ source: "post_moderation", evidenceRef: null, setAt: now })
  })

  test("keeps the cause that gated the post first", () => {
    expect(resolveInitialAgeGateProvenance({
      ageGatePolicy: "18_plus",
      community,
      requestedAgeGatePolicy: "18_plus",
      postModerationAgeGatePolicy: "18_plus",
      setAt: now,
    })?.source).toBe("author")
  })

  test("preserves post provenance across a sticky bundle merge", () => {
    expect(resolveFinalAgeGateProvenance({
      postAgeGatePolicy: "18_plus",
      postSource: "post_moderation",
      postEvidenceRef: "moderation_signal:msi_1",
      postSetAt: now,
      bundleAgeGatePolicy: "18_plus",
      bundleId: "sab_1",
      now: "2026-08-01T00:00:00.000Z",
    })).toEqual({
      source: "post_moderation",
      evidenceRef: "moderation_signal:msi_1",
      setAt: now,
    })
  })

  test("attributes a newly introduced finalization gate to bundle moderation", () => {
    expect(resolveFinalAgeGateProvenance({
      postAgeGatePolicy: "none",
      bundleAgeGatePolicy: "18_plus",
      bundleId: "sab_1",
      now,
    })).toEqual({
      source: "bundle_moderation",
      evidenceRef: "song_artifact_bundle:sab_1",
      setAt: now,
    })
  })
})
