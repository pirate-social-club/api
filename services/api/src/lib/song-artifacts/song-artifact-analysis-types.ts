import type { Post } from "../../types"

export type LyricsModerationOutcome = {
  analysisState: Post["analysis_state"]
  contentSafetyState: Post["content_safety_state"]
  ageGatePolicy: Post["age_gate_policy"]
  moderationStatus: "completed" | "failed"
  moderationError: string | null
  moderationResult: Record<string, unknown>
}

export type AudioIdentificationOutcome = {
  analysisState: Post["analysis_state"]
  moderationStatus: "completed" | "failed"
  moderationError: string | null
  moderationResult: Record<string, unknown>
}

export type AlignmentOutcome = {
  alignmentStatus: "completed" | "failed"
  alignmentError: string | null
  timedLyrics: Record<string, unknown> | null
}

export function trimEnv(value: string | undefined): string {
  return String(value || "").trim()
}
