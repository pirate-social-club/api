import type { Env } from "../../src/types"
import { expect } from "bun:test"
import { json } from "../helpers"
import { completeUniqueHumanVerification, requestJson } from "./community-routes-test-helpers"

export async function createMembershipGatedCommunity(input: {
  env: Env
  creatorAccessToken: string
  displayName: string
  gateRule: Record<string, unknown>
}): Promise<{ communityId: string; membershipMode: string }> {
  await completeUniqueHumanVerification(input.env, input.creatorAccessToken)
  const communityCreate = await requestJson("http://pirate.test/communities", {
    display_name: input.displayName,
    membership_mode: "gated",
    gate_rules: [input.gateRule],
  }, input.env, input.creatorAccessToken)
  expect(communityCreate.status).toBe(202)
  const communityCreateBody = await json(communityCreate) as {
    community: { community_id: string; membership_mode: string }
  }
  return {
    communityId: communityCreateBody.community.community_id,
    membershipMode: communityCreateBody.community.membership_mode,
  }
}
