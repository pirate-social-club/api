import type { Env } from "../../env"
import { normalizeCommunityMediaRef } from "./community-identity-media"
import { flattenGatePolicyAtoms } from "./membership/gate-summary"
import type { GatePolicy } from "./membership/gate-types"
import { getControlPlaneClient } from "../runtime-deps"

export function membershipGatePolicyHasAltchaPow(policy: GatePolicy | null | undefined): boolean {
  return flattenGatePolicyAtoms(policy ?? null).some((atom) => atom.type === "altcha_pow")
}

export async function syncCommunityAuthProjection(input: {
  env: Env
  communityId: string
  displayName?: string
  avatarRef?: string | null
  membershipGatePolicy?: GatePolicy | null
  updatedAt: string
}): Promise<void> {
  const assignments: string[] = []
  const args: unknown[] = [input.communityId]

  function addAssignment(column: string, value: unknown): void {
    args.push(value)
    assignments.push(`${column} = ?${args.length}`)
  }

  if ("displayName" in input) {
    addAssignment("display_name", input.displayName?.trim() || "")
  }
  if ("avatarRef" in input) {
    addAssignment("avatar_ref", normalizeCommunityMediaRef(input.avatarRef))
  }
  if ("membershipGatePolicy" in input) {
    addAssignment("membership_has_altcha_pow", membershipGatePolicyHasAltchaPow(input.membershipGatePolicy) ? 1 : 0)
  }

  if (assignments.length === 0) return
  addAssignment("updated_at", input.updatedAt)

  await getControlPlaneClient(input.env).execute({
    sql: `
      UPDATE communities
      SET ${assignments.join(", ")}
      WHERE community_id = ?1
    `,
    args,
  })
}
