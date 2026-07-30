import type { Env } from "../../env"

export function isDanceCaptureEnabled(
  env: Pick<Env, "DANCE_CAPTURE_ENABLED">,
): boolean {
  return String(env.DANCE_CAPTURE_ENABLED ?? "").trim().toLowerCase() === "true"
}
