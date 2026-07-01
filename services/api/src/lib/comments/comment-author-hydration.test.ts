import { describe, expect, test } from "bun:test"
import { hydrateCommentAuthorPublicHandles } from "./comment-author-hydration"
import type { Comment, CommentListItem } from "../../types"

function makeComment(overrides: Partial<Comment> = {}): Comment {
  return {
    comment_id: "cmt_1",
    community_id: "community_1",
    thread_root_post_id: "pst_1",
    parent_comment_id: null,
    author_user_id: "author_1",
    authorship_mode: "human_direct",
    identity_mode: "public",
    anonymous_scope: null,
    anonymous_label: null,
    body: "hello",
    status: "published",
    depth: 0,
    direct_reply_count: 0,
    descendant_count: 0,
    upvote_count: 0,
    downvote_count: 0,
    score: 0,
    last_reply_at: null,
    content_hash: null,
    swarm_body_ref: null,
    idempotency_key: null,
    created_at: "2026-07-01T00:00:00.000Z",
    updated_at: "2026-07-01T00:00:00.000Z",
    ...overrides,
  }
}

function makeItem(comment: Comment): CommentListItem {
  return {
    comment,
    viewer_vote: null,
    resolved_locale: "en",
    translation_state: "same_language",
    machine_translated: false,
    source_hash: "hash",
  }
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

describe("hydrateCommentAuthorPublicHandles", () => {
  test("stamps the resolved public handle onto public human-authored comments", async () => {
    const item = makeItem(makeComment({ author_user_id: "author_1" }))
    const { repository } = makeProfileRepository({ author_1: "alice.pirate" })

    await hydrateCommentAuthorPublicHandles([item], repository)

    expect(item.comment.author_public_handle).toBe("alice.pirate")
  })

  test("prefers primary_public_handle over global_handle", async () => {
    const item = makeItem(makeComment({ author_user_id: "author_1" }))
    const repository = {
      async getProfileByUserId() {
        return null
      },
      async listProfilesByUserIds(userIds: string[]) {
        return new Map(userIds.map((userId) => [userId, {
          global_handle: { label: "global.pirate" },
          primary_public_handle: { label: "primary.handle" },
        }]))
      },
    } as never

    await hydrateCommentAuthorPublicHandles([item], repository)

    expect(item.comment.author_public_handle).toBe("primary.handle")
  })

  test("leaves anonymous, guest, and agent comments untouched", async () => {
    const anon = makeItem(makeComment({ identity_mode: "anonymous", author_user_id: null, anonymous_label: "anon" }))
    const guest = makeItem(makeComment({ authorship_mode: "guest", author_user_id: null }))
    const agent = makeItem(makeComment({ authorship_mode: "user_agent", author_user_id: "owner_1" }))
    const { repository, calls } = makeProfileRepository({ owner_1: "owner.pirate" })

    await hydrateCommentAuthorPublicHandles([anon, guest, agent], repository)

    expect(anon.comment.author_public_handle).toBeUndefined()
    expect(guest.comment.author_public_handle).toBeUndefined()
    expect(agent.comment.author_public_handle).toBeUndefined()
    // No eligible authors -> no profile lookup at all.
    expect(calls.listUserIds).toHaveLength(0)
  })

  test("sets null when the author profile cannot be resolved", async () => {
    const item = makeItem(makeComment({ author_user_id: "missing" }))
    const { repository } = makeProfileRepository({})

    await hydrateCommentAuthorPublicHandles([item], repository)

    expect(item.comment.author_public_handle).toBeNull()
  })

  test("batches distinct author ids into a single lookup", async () => {
    const items = [
      makeItem(makeComment({ comment_id: "cmt_1", author_user_id: "author_1" })),
      makeItem(makeComment({ comment_id: "cmt_2", author_user_id: "author_2" })),
      makeItem(makeComment({ comment_id: "cmt_3", author_user_id: "author_1" })),
    ]
    const { repository, calls } = makeProfileRepository({ author_1: "alice.pirate", author_2: "bob.pirate" })

    await hydrateCommentAuthorPublicHandles(items, repository)

    expect(calls.listUserIds).toHaveLength(1)
    expect([...calls.listUserIds[0]].sort()).toEqual(["author_1", "author_2"])
    expect(items[0].comment.author_public_handle).toBe("alice.pirate")
    expect(items[1].comment.author_public_handle).toBe("bob.pirate")
    expect(items[2].comment.author_public_handle).toBe("alice.pirate")
  })

  test("is a no-op without a profile repository", async () => {
    const item = makeItem(makeComment({ author_user_id: "author_1" }))
    await hydrateCommentAuthorPublicHandles([item], null)
    expect(item.comment.author_public_handle).toBeUndefined()
  })
})
