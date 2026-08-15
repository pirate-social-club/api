import type { Env } from "../../env"

export function isDanceCaptureEnabled(
  env: Pick<Env, "DANCE_CAPTURE_ENABLED">,
): boolean {
  return String(env.DANCE_CAPTURE_ENABLED ?? "").trim().toLowerCase() === "true"
}

export function isDanceChoreographyEnabled(
  env: Pick<Env, "DANCE_CHOREOGRAPHY_ENABLED">,
): boolean {
  return String(env.DANCE_CHOREOGRAPHY_ENABLED ?? "").trim().toLowerCase() === "true"
}

export function isDanceGradingEnabled(
  env: Pick<Env, "DANCE_GRADING_ENABLED">,
): boolean {
  return String(env.DANCE_GRADING_ENABLED ?? "").trim().toLowerCase() === "true"
}
