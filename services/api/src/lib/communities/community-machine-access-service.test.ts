import { describe, expect, test } from "bun:test"
import {
  defaultCommunityMachineAccessPolicy,
  omittedSurfacesForPolicy,
  type CommunityMachineAccessEffectivePolicy,
} from "./community-machine-access-service"

describe("community machine access policy", () => {
  test("omitted surface reasons prefer effective policy override reasons", () => {
    const policy: CommunityMachineAccessEffectivePolicy = {
      ...defaultCommunityMachineAccessPolicy({
        communityId: "cmt_test",
        updatedAt: "2026-04-24T00:00:00.000Z",
      }),
      included_surfaces: {
        community_identity: true,
        community_stats: true,
        thread_cards: true,
        thread_bodies: false,
        top_comments: false,
        events: true,
      },
      omitted_surface_reasons: {
        top_comments: "platform_disabled",
      },
    }

    expect(omittedSurfacesForPolicy(policy, ["thread_bodies", "top_comments"])).toEqual([
      { surface: "thread_bodies", reason: "community_opt_out" },
      { surface: "top_comments", reason: "platform_disabled" },
    ])
  })
})
