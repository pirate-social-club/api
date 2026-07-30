export type TelegramCadenceOutcome =
  | "within_slo"
  | "latency_breach"
  | "liveness_failure"

export function telegramCadenceOutcome(input: {
  delivered: boolean
  elapsedMs: number
  latencySloMs: number
}): TelegramCadenceOutcome {
  if (!input.delivered) return "liveness_failure"
  return input.elapsedMs <= input.latencySloMs
    ? "within_slo"
    : "latency_breach"
}
