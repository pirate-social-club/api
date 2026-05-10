import type { Env } from "../../env"
import { sha256Hex } from "../crypto"
import { nowIso } from "../helpers"
import { getControlPlaneClient } from "../runtime-deps"
import { buildDefaultVerificationCapabilities } from "../verification/verification-capabilities"

function normalizeStableGuestId(value: string): string {
  return value.trim().slice(0, 256)
}

export async function resolveOrCreateGuestUser(input: {
  env: Env
  communityId: string
  stableGuestId: string
}): Promise<{ userId: string }> {
  const stableGuestId = normalizeStableGuestId(input.stableGuestId)
  const hash = await sha256Hex(`pirate:guest:${input.communityId}:${stableGuestId}`)
  const userId = `usr_guest_${hash.slice(0, 32)}`
  const now = nowIso()
  const client = getControlPlaneClient(input.env)

  await client.execute({
    sql: `
      INSERT INTO users (
        user_id,
        primary_wallet_attachment_id,
        verification_state,
        capability_provider,
        verification_capabilities_json,
        verified_at,
        current_verification_session_id,
        created_at,
        updated_at
      ) VALUES (?1, NULL, 'unverified', NULL, ?2, NULL, NULL, ?3, ?3)
      ON CONFLICT(user_id) DO NOTHING
    `,
    args: [userId, JSON.stringify(buildDefaultVerificationCapabilities()), now],
  })

  return { userId }
}
