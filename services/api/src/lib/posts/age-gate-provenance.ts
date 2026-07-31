import type { Community, Post } from "../../types"

export type AgeGateSource = NonNullable<Post["age_gate_source"]>

export type AgeGateProvenance = {
  source: AgeGateSource
  evidenceRef: string | null
  setAt: string
}

export function resolveInitialAgeGateProvenance(input: {
  ageGatePolicy: Post["age_gate_policy"]
  community: Pick<Community, "community_id" | "default_age_gate_policy">
  requestedAgeGatePolicy: Post["age_gate_policy"]
  postModerationAgeGatePolicy: Post["age_gate_policy"]
  bundleModerationAgeGatePolicy?: Post["age_gate_policy"] | null
  bundleId?: string | null
  setAt: string
}): AgeGateProvenance | null {
  if (input.ageGatePolicy !== "18_plus") return null

  // These are ordered by when each cause existed. A later sticky merge must not
  // overwrite the cause that had already made the post gated.
  if (input.community.default_age_gate_policy === "18_plus") {
    return {
      source: "community_default",
      evidenceRef: `community:${input.community.community_id}`,
      setAt: input.setAt,
    }
  }
  if (input.requestedAgeGatePolicy === "18_plus") {
    return { source: "author", evidenceRef: "post_create_request", setAt: input.setAt }
  }
  if (input.bundleModerationAgeGatePolicy === "18_plus") {
    return {
      source: "bundle_moderation",
      evidenceRef: input.bundleId ? `song_artifact_bundle:${input.bundleId}` : null,
      setAt: input.setAt,
    }
  }
  if (input.postModerationAgeGatePolicy === "18_plus") {
    return { source: "post_moderation", evidenceRef: null, setAt: input.setAt }
  }

  // Defensive fallback for a future assignment path that is not yet classified.
  return { source: "legacy_unknown", evidenceRef: null, setAt: input.setAt }
}

export function resolveFinalAgeGateProvenance(input: {
  postAgeGatePolicy: Post["age_gate_policy"]
  postSource?: Post["age_gate_source"]
  postEvidenceRef?: string | null
  postSetAt?: string | null
  bundleAgeGatePolicy?: Post["age_gate_policy"] | null
  bundleId?: string | null
  now: string
}): AgeGateProvenance | null {
  if (input.postAgeGatePolicy === "18_plus") {
    return {
      source: input.postSource ?? "legacy_unknown",
      evidenceRef: input.postEvidenceRef ?? null,
      setAt: input.postSetAt ?? input.now,
    }
  }
  if (input.bundleAgeGatePolicy === "18_plus") {
    return {
      source: "bundle_moderation",
      evidenceRef: input.bundleId ? `song_artifact_bundle:${input.bundleId}` : null,
      setAt: input.now,
    }
  }
  return null
}
