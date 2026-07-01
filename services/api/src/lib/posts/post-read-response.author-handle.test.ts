import { describe, expect, test } from "bun:test"
import { hydrateAuthorPublicHandlesForResponses } from "./post-read-response"
import type { LocalizedPostResponse, Post } from "../../types"

function makePost(overrides: Partial<Post> = {}): Post {
  return {
    post_id: "pst_1",
    community_id: "community_1",
    author_user_id: "author_1",
    authorship_mode: "human_direct",
    identity_mode: "public",
    anonymous_scope: null,
    anonymous_label: null,
    post_type: "text",
    title: "Title",
    body: "Body",
    caption: null,
    status: "published",
    visibility: "public",
    translation_policy: "machine_allowed",
    source_language: null,
    analysis_state: "allow",
    content_safety_state: "safe",
    age_gate_policy: "none",
    created_at: "2026-07-01T00:00:00.000Z",
    updated_at: "2026-07-01T00:00:00.000Z",
    ...overrides,
  } as Post
}

function makeResponse(post: Post): LocalizedPostResponse {
  return { post } as LocalizedPostResponse
}

function makeProfileRepository(labelsByUserId: Record<string, string | null>) {
  const calls = { listUserIds: [] as string[][] }
  return {
    repository: {
      async getProfileByUserId(userId: string) {
        const label = labelsByUserId[userId]
        return label ? { global_handle: { label }, primary_public_handle: null } : null
      },
      async listProfilesByUserIds(userIds: string[]) {
        calls.listUserIds.push([...userIds])
        return new Map(userIds.map((userId) => [
          userId,
          labelsByUserId[userId]
            ? { global_handle: { label: labelsByUserId[userId] }, primary_public_handle: null }
            : null,
        ]))
      },
    } as never,
    calls,
  }
}

describe("hydrateAuthorPublicHandlesForResponses", () => {
  test("stamps the resolved public handle onto public human-authored posts", async () => {
    const response = makeResponse(makePost({ author_user_id: "author_1" }))
    const { repository } = makeProfileRepository({ author_1: "alice.pirate" })

    await hydrateAuthorPublicHandlesForResponses({ responses: [response], profileRepository: repository })

    expect(response.post.author_public_handle).toBe("alice.pirate")
  })

  test("leaves anonymous and agent posts untouched", async () => {
    const anon = makeResponse(makePost({ identity_mode: "anonymous", author_user_id: null, anonymous_label: "anon" }))
    const agent = makeResponse(makePost({ authorship_mode: "user_agent", author_user_id: "owner_1" }))
    const { repository, calls } = makeProfileRepository({ owner_1: "owner.pirate" })

    await hydrateAuthorPublicHandlesForResponses({ responses: [anon, agent], profileRepository: repository })

    expect(anon.post.author_public_handle).toBeUndefined()
    expect(agent.post.author_public_handle).toBeUndefined()
    expect(calls.listUserIds).toHaveLength(0)
  })

  test("sets null when the author profile cannot be resolved", async () => {
    const response = makeResponse(makePost({ author_user_id: "missing" }))
    const { repository } = makeProfileRepository({})

    await hydrateAuthorPublicHandlesForResponses({ responses: [response], profileRepository: repository })

    expect(response.post.author_public_handle).toBeNull()
  })

  test("batches distinct author ids into a single lookup", async () => {
    const responses = [
      makeResponse(makePost({ post_id: "pst_1", author_user_id: "author_1" })),
      makeResponse(makePost({ post_id: "pst_2", author_user_id: "author_2" })),
      makeResponse(makePost({ post_id: "pst_3", author_user_id: "author_1" })),
    ]
    const { repository, calls } = makeProfileRepository({ author_1: "alice.pirate", author_2: "bob.pirate" })

    await hydrateAuthorPublicHandlesForResponses({ responses, profileRepository: repository })

    expect(calls.listUserIds).toHaveLength(1)
    expect([...calls.listUserIds[0]].sort()).toEqual(["author_1", "author_2"])
    expect(responses[0].post.author_public_handle).toBe("alice.pirate")
    expect(responses[1].post.author_public_handle).toBe("bob.pirate")
    expect(responses[2].post.author_public_handle).toBe("alice.pirate")
  })

  test("is a no-op without a profile repository", async () => {
    const response = makeResponse(makePost({ author_user_id: "author_1" }))
    await hydrateAuthorPublicHandlesForResponses({ responses: [response], profileRepository: null })
    expect(response.post.author_public_handle).toBeUndefined()
  })
})
