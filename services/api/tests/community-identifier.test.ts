import { describe, expect, test } from "bun:test"
import {
  communityIdentifierCandidates,
  resolveCommunityIdentifier,
} from "../src/lib/communities/community-identifier"
import type { CommunityReadRepository } from "../src/lib/communities/db-community-repository"
import type { CommunityRow } from "../src/lib/auth/auth-db-rows"

function communityRow(input: {
  communityId: string
  routeSlug: string | null
  displayName?: string
}): CommunityRow {
  return {
    community_id: input.communityId,
    creator_user_id: "usr_test",
    display_name: input.displayName ?? input.communityId,
    description: null,
    avatar_ref: null,
    banner_ref: null,
    status: "active",
    provisioning_state: "active",
    transfer_state: "none",
    route_slug: input.routeSlug,
    namespace_verification_id: null,
    pending_namespace_verification_session_id: null,
    follower_count: 0,
    created_at: "2026-01-01T00:00:00.000Z",
    updated_at: "2026-01-01T00:00:00.000Z",
  }
}

describe("community identifier resolution", () => {
  test("adds canonical Spaces punycode route candidates for emoji handles", () => {
    expect(communityIdentifierCandidates("@🇵🇸")).toContain("@xn--t77hga")
    expect(communityIdentifierCandidates("@%F0%9F%87%B5%F0%9F%87%B8")).toContain("@xn--t77hga")
    expect(communityIdentifierCandidates("@☠️")).toContain("@xn--h4h")
  })

  test("resolves emoji route handles through canonical punycode route slug", async () => {
    const community = communityRow({
      communityId: "cmt_palestine",
      routeSlug: "@xn--t77hga",
      displayName: "🇵🇸",
    })
    const repository = {
      async getCommunityById(communityId: string) {
        return communityId === community.community_id ? community : null
      },
      async getCommunityByRouteSlug(routeSlug: string) {
        return routeSlug === community.route_slug ? community : null
      },
    } as Pick<CommunityReadRepository, "getCommunityById" | "getCommunityByRouteSlug">

    expect(await resolveCommunityIdentifier(repository, "@🇵🇸")).toBe("cmt_palestine")
    expect(await resolveCommunityIdentifier(repository, "@%F0%9F%87%B5%F0%9F%87%B8")).toBe("cmt_palestine")
    expect(await resolveCommunityIdentifier(repository, "@xn--t77hga")).toBe("cmt_palestine")
  })

  test("uses the batched repository lookup when available", async () => {
    const community = communityRow({
      communityId: "cmt_palestine",
      routeSlug: "@xn--t77hga",
      displayName: "🇵🇸",
    })
    const calls = {
      batched: 0,
      byId: 0,
      byRouteSlug: 0,
    }
    const repository = {
      async getCommunityByIdentifierCandidates(candidates: string[]) {
        calls.batched += 1
        expect(candidates).toContain("@xn--t77hga")
        return community
      },
      async getCommunityById() {
        calls.byId += 1
        return null
      },
      async getCommunityByRouteSlug() {
        calls.byRouteSlug += 1
        return null
      },
    }

    expect(await resolveCommunityIdentifier(repository, "@🇵🇸")).toBe("cmt_palestine")
    expect(calls).toEqual({
      batched: 1,
      byId: 0,
      byRouteSlug: 0,
    })
  })
})
