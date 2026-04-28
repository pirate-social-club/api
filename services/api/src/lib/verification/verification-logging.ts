import { envFlag } from "../helpers"
import type { Env } from "../../types"

export function shouldLogVerificationDebug(env: Env): boolean {
  return envFlag(env.VERIFICATION_DEBUG_LOGS, false)
}

export function logVerificationDebug(env: Env, message: string, details: Record<string, unknown>): void {
  if (shouldLogVerificationDebug(env)) {
    console.info(message, details)
  }
}
