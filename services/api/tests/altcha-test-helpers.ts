import { solveChallenge, type Payload } from "altcha-lib"
import { deriveKey } from "altcha-lib/algorithms/pbkdf2"
import {
  createAltchaChallenge,
  type AltchaScope,
} from "../src/lib/verification/altcha-provider"
import type { Env } from "../src/types"

export async function solveTestAltchaPayload(input: {
  env: Env
  actorUserId: string
  scope: AltchaScope
  action: string
}): Promise<string> {
  const challenge = await createAltchaChallenge({
    env: input.env,
    actorUserId: input.actorUserId,
    scope: input.scope,
    action: input.action,
  })
  const solution = await solveChallenge({ challenge, deriveKey })
  if (!solution) {
    throw new Error("ALTCHA challenge did not solve")
  }
  return btoa(JSON.stringify({ challenge, solution } satisfies Payload))
}
