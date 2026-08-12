import { describe, expect, test } from "bun:test"
import type { ProfileRepository } from "../auth/repositories"
import type { DbExecutor } from "../db-helpers"
import {
  hydratePublicHumanAuthorHandles,
  type PublicHumanAuthorHandleTarget,
} from "./author-handle-hydration"

function author(overrides: Partial<PublicHumanAuthorHandleTarget> = {}): PublicHumanAuthorHandleTarget {
  return {
    author_user_id: "usr_1",
    identity_mode: "public",
    authorship_mode: "human_direct",
    ...overrides,
  }
}

function profileRepository(handles: Record<string, string>): ProfileRepository {
  return {
    async getProfileByUserId(userId: string) {
      const handle = handles[userId]
      return handle
        ? { global_handle: { label: handle }, primary_public_handle: null }
        : null
    },
    async listProfilesByUserIds(userIds: readonly string[]) {
      return new Map(userIds.flatMap((userId) => {
        const handle = handles[userId]
        return handle
          ? [[userId, { global_handle: { label: handle }, primary_public_handle: null }]]
          : []
      }))
    },
  } as unknown as ProfileRepository
}

function communityClient(rows: Array<Record<string, unknown>>): DbExecutor {
  return {
    async execute() {
      return { rows }
    },
  } as unknown as DbExecutor
}

describe("hydratePublicHumanAuthorHandles", () => {
  test("prefers the active primary-namespace handle on community surfaces", async () => {
    const target = author()

    await hydratePublicHumanAuthorHandles({
      authors: [target],
      profileRepository: profileRepository({ usr_1: "alice.pirate" }),
      surface: {
        kind: "community",
        client: communityClient([{
          user_id: "usr_1",
          label_display: "alice",
          namespace_label: "dankmeme",
        }]),
        communityId: "cmt_1",
      },
    })

    expect(target.author_public_handle).toBe("alice.dankmeme")
  })

  test("formats Spaces primary handles with at syntax", async () => {
    const target = author()

    await hydratePublicHumanAuthorHandles({
      authors: [target],
      profileRepository: profileRepository({ usr_1: "alice.pirate" }),
      surface: {
        kind: "community",
        client: communityClient([{
          user_id: "usr_1",
          label_display: "alice",
          namespace_label: "@pokemon",
        }]),
        communityId: "cmt_1",
      },
    })

    expect(target.author_public_handle).toBe("alice@pokemon")
  })

  test("falls back to the global handle when no primary handle exists", async () => {
    const target = author()

    await hydratePublicHumanAuthorHandles({
      authors: [target],
      profileRepository: profileRepository({ usr_1: "alice.pirate" }),
      surface: {
        kind: "community",
        client: communityClient([]),
        communityId: "cmt_1",
      },
    })

    expect(target.author_public_handle).toBe("alice.pirate")
  })

  test("global surfaces ignore community handles", async () => {
    const target = author()

    await hydratePublicHumanAuthorHandles({
      authors: [target],
      profileRepository: profileRepository({ usr_1: "alice.pirate" }),
    })

    expect(target.author_public_handle).toBe("alice.pirate")
  })

  test("leaves anonymous and agent identities untouched", async () => {
    const anonymous = author({ identity_mode: "anonymous", author_public_handle: undefined })
    const agent = author({ authorship_mode: "user_agent", author_public_handle: undefined })

    await hydratePublicHumanAuthorHandles({
      authors: [anonymous, agent],
      profileRepository: profileRepository({ usr_1: "alice.pirate" }),
    })

    expect(anonymous.author_public_handle).toBeUndefined()
    expect(agent.author_public_handle).toBeUndefined()
  })
})
