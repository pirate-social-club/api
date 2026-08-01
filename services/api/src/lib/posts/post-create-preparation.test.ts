import { describe, expect, test } from "bun:test"

import { preparePostCreate } from "./post-create-preparation"
import type { Client } from "../sql-client"
import type { Community, CreatePostRequest, Post } from "../../types"
import type { Env } from "../../env"

function community(defaultAgeGatePolicy: Community["default_age_gate_policy"] = "none"): Community {
  return {
    community_id: "com_test",
    display_name: "Test",
    status: "active",
    provisioning_state: "active",
    membership_mode: "open",
    default_age_gate_policy: defaultAgeGatePolicy,
    allow_anonymous_identity: false,
    donation_policy_mode: "disabled",
    donation_partner_status: "none",
    created_at: "2026-01-01T00:00:00.000Z",
    updated_at: "2026-01-01T00:00:00.000Z",
  } as unknown as Community
}

function request(ageGatePolicy?: CreatePostRequest["age_gate_policy"]): CreatePostRequest {
  return {
    idempotency_key: `idem_${ageGatePolicy ?? "omitted"}`,
    post_type: "text",
    title: "Plain post",
    age_gate_policy: ageGatePolicy,
  } as CreatePostRequest
}

async function prepare(input: {
  body: CreatePostRequest
  community?: Community
  analyzedAgeGatePolicy?: Post["age_gate_policy"]
}) {
  return preparePostCreate({
    env: {} as Env,
    requestUrl: "https://example.test/communities/com_test/posts",
    userId: "user_1",
    communityId: "com_test",
    body: input.body,
    community: input.community ?? community(),
    communityDbClient: {} as Client,
    communityRepository: {} as never,
    postAnalysisProvider: {
      analyze: async () => ({
        analysis_state: "allow",
        content_safety_state: "safe",
        age_gate_policy: input.analyzedAgeGatePolicy ?? "none",
        status: "published",
        providerResult: null,
      }),
    },
  })
}

describe("preparePostCreate age_gate_policy", () => {
  test("uses the author-declared 18_plus policy as a floor", async () => {
    const prepared = await prepare({ body: request("18_plus") })

    expect(prepared.analysisOverride.age_gate_policy).toBe("18_plus")
  })

  test("does not let an author-declared none downgrade the community default", async () => {
    const prepared = await prepare({
      body: request("none"),
      community: community("18_plus"),
    })

    expect(prepared.analysisOverride.age_gate_policy).toBe("18_plus")
  })

  test("does not let an author-declared none downgrade automated analysis", async () => {
    const prepared = await prepare({
      body: request("none"),
      analyzedAgeGatePolicy: "18_plus",
    })

    expect(prepared.analysisOverride.age_gate_policy).toBe("18_plus")
  })
})
