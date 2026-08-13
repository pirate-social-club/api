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
      profileRepository: profileRepository({ usr_1: "creator.pirate" }),
      surface: {
        kind: "community",
        client: communityClient([{
          user_id: "usr_1",
          label_display: "creator",
          namespace_label: "dankmeme",
        }]),
        communityId: "cmt_1",
      },
    })

    expect(target.author_public_handle).toBe("creator.dankmeme")
  })

  test("formats Spaces primary handles with at syntax", async () => {
    const target = author()

    await hydratePublicHumanAuthorHandles({
      authors: [target],
      profileRepository: profileRepository({ usr_1: "creator.pirate" }),
      surface: {
        kind: "community",
        client: communityClient([{
          user_id: "usr_1",
          label_display: "creator",
          namespace_label: "@pokemon",
        }]),
        communityId: "cmt_1",
      },
    })

    expect(target.author_public_handle).toBe("creator@pokemon")
  })

  test("falls back to the global handle when no primary handle exists", async () => {
    const target = author()

    await hydratePublicHumanAuthorHandles({
      authors: [target],
      profileRepository: profileRepository({ usr_1: "creator.pirate" }),
      surface: {
        kind: "community",
        client: communityClient([]),
        communityId: "cmt_1",
      },
    })

    expect(target.author_public_handle).toBe("creator.pirate")
  })

  test("global surfaces ignore community handles", async () => {
    const target = author()

    await hydratePublicHumanAuthorHandles({
      authors: [target],
      profileRepository: profileRepository({ usr_1: "creator.pirate" }),
    })

    expect(target.author_public_handle).toBe("creator.pirate")

  })

  test("uses request-prefetched profiles without another repository read", async () => {
    const target = author()
    let repositoryReads = 0
    const repository = profileRepository({ usr_1: "wrong.pirate" })
    const prefetchedProfile = await profileRepository({ usr_1: "creator.pirate" })
      .getProfileByUserId("usr_1")
    repository.listProfilesByUserIds = async () => {
      repositoryReads += 1
      return new Map()
    }

    await hydratePublicHumanAuthorHandles({
      authors: [target],
      prefetchedProfilesByUserId: new Map([["usr_1", prefetchedProfile]]),
      profileRepository: repository,
    })

    expect(repositoryReads).toBe(0)
    expect(target.author_public_handle).toBe("creator.pirate")
  })

  test("loads only authors absent from a partial request prefetch", async () => {
    const prefetchedAuthor = author({ author_user_id: "usr_prefetched" })
    const missingAuthor = author({ author_user_id: "usr_missing" })
    const prefetchedProfile = await profileRepository({ usr_prefetched: "prefetched.pirate" })
      .getProfileByUserId("usr_prefetched")
    const repository = profileRepository({ usr_missing: "missing.pirate" })
    const requestedUserIds: string[][] = []
    const listProfilesByUserIds = repository.listProfilesByUserIds?.bind(repository)
    repository.listProfilesByUserIds = async (userIds) => {
      requestedUserIds.push(userIds)
      return listProfilesByUserIds?.(userIds) ?? new Map()
    }

    await hydratePublicHumanAuthorHandles({
      authors: [prefetchedAuthor, missingAuthor],
      prefetchedProfilesByUserId: new Map([["usr_prefetched", prefetchedProfile]]),
      profileRepository: repository,
    })

    expect(requestedUserIds).toEqual([["usr_missing"]])
    expect(prefetchedAuthor.author_public_handle).toBe("prefetched.pirate")
    expect(missingAuthor.author_public_handle).toBe("missing.pirate")
  })

  test("leaves anonymous and agent identities untouched", async () => {
    const anonymous = author({ identity_mode: "anonymous", author_public_handle: undefined })
    const agent = author({ authorship_mode: "user_agent", author_public_handle: undefined })

    await hydratePublicHumanAuthorHandles({
      authors: [anonymous, agent],
      profileRepository: profileRepository({ usr_1: "creator.pirate" }),
    })

    expect(anonymous.author_public_handle).toBeUndefined()
    expect(agent.author_public_handle).toBeUndefined()
  })
})
