import { afterEach, describe, expect, test } from "bun:test"
import { createClient, type Client as LibsqlClient } from "@libsql/client"
import {
  getThreadWithComments,
  listUserCommentsInCommunity,
  listUserPostsInCommunity,
  searchPublishedPosts,
} from "./board-read-service"

let client: LibsqlClient | null = null

afterEach(() => {
  client?.close()
  client = null
})

async function createTestClient(): Promise<LibsqlClient> {
  client = createClient({ url: "file::memory:" })
  await client.execute(`
    CREATE TABLE posts (
      post_id TEXT PRIMARY KEY,
      community_id TEXT NOT NULL,
      author_user_id TEXT,
      identity_mode TEXT NOT NULL,
      post_type TEXT NOT NULL,
      status TEXT NOT NULL,
      title TEXT,
      body TEXT,
      caption TEXT,
      created_at TEXT NOT NULL,
      updated_at TEXT NOT NULL,
      visibility TEXT NOT NULL DEFAULT 'public'
    )
  `)
  await client.execute(`
    CREATE TABLE comments (
      comment_id TEXT PRIMARY KEY,
      community_id TEXT NOT NULL,
      thread_root_post_id TEXT NOT NULL,
      parent_comment_id TEXT,
      author_user_id TEXT,
      identity_mode TEXT NOT NULL,
      body TEXT NOT NULL,
      status TEXT NOT NULL,
      depth INTEGER NOT NULL DEFAULT 0,
      score INTEGER NOT NULL DEFAULT 0,
      created_at TEXT NOT NULL,
      updated_at TEXT NOT NULL
    )
  `)
  return client
}

async function insertPost(input: {
  authorUserId?: string | null
  body?: string
  caption?: string
  communityId?: string
  createdAt: string
  identityMode?: "public" | "anonymous"
  postId: string
  postType?: string
  status?: string
  title?: string
  visibility?: "public" | "members_only"
}) {
  if (!client) throw new Error("missing test client")
  await client.execute({
    sql: `
      INSERT INTO posts (
        post_id, community_id, author_user_id, identity_mode, post_type, status,
        title, body, caption, created_at, updated_at, visibility
      )
      VALUES (?1, ?2, ?3, ?4, ?5, ?6, ?7, ?8, ?9, ?10, ?10, ?11)
    `,
    args: [
      input.postId,
      input.communityId ?? "com_test",
      input.authorUserId ?? "usr_author",
      input.identityMode ?? "public",
      input.postType ?? "text",
      input.status ?? "published",
      input.title ?? "",
      input.body ?? "",
      input.caption ?? "",
      input.createdAt,
      input.visibility ?? "public",
    ],
  })
}

async function insertComment(input: {
  authorUserId?: string | null
  body?: string
  commentId: string
  communityId?: string
  createdAt: string
  depth?: number
  identityMode?: "public" | "anonymous"
  parentCommentId?: string | null
  score?: number
  status?: string
  threadRootPostId: string
}) {
  if (!client) throw new Error("missing test client")
  await client.execute({
    sql: `
      INSERT INTO comments (
        comment_id, community_id, thread_root_post_id, parent_comment_id,
        author_user_id, identity_mode, body, status, depth, score, created_at, updated_at
      )
      VALUES (?1, ?2, ?3, ?4, ?5, ?6, ?7, ?8, ?9, ?10, ?11, ?11)
    `,
    args: [
      input.commentId,
      input.communityId ?? "com_test",
      input.threadRootPostId,
      input.parentCommentId ?? null,
      input.authorUserId ?? "usr_commenter",
      input.identityMode ?? "public",
      input.body ?? "",
      input.status ?? "published",
      input.depth ?? 0,
      input.score ?? 0,
      input.createdAt,
    ],
  })
}

function isoDaysAgo(days: number): string {
  return new Date(Date.now() - days * 24 * 60 * 60 * 1000).toISOString()
}

describe("board-read service", () => {
  test("searchPublishedPosts scores keyword relevance above raw recency", async () => {
    const db = await createTestClient()
    await insertPost({
      body: "A detailed Rust token killer build log with Rust token ergonomics.",
      createdAt: isoDaysAgo(20),
      postId: "pst_relevant_old",
      title: "Rust token killer design",
    })
    for (let index = 0; index < 20; index += 1) {
      await insertComment({
        body: `Relevant discussion ${index}`,
        commentId: `cmt_relevant_${index}`,
        createdAt: isoDaysAgo(19),
        threadRootPostId: "pst_relevant_old",
      })
    }
    await insertPost({
      body: "A short Rust note.",
      createdAt: isoDaysAgo(1),
      postId: "pst_weak_new",
      title: "Daily update",
    })

    const results = await searchPublishedPosts(db, "com_test", {
      limit: 2,
      query: "rust token",
    })

    expect(results.map((post) => post.postId)).toEqual(["pst_relevant_old", "pst_weak_new"])
    expect(results[0]!.score).toBeGreaterThan(results[1]!.score)
    expect(results[0]!.commentCount).toBe(20)
  })

  test("searchPublishedPosts can be restricted to public visibility", async () => {
    const db = await createTestClient()
    await insertPost({
      body: "Public launch notes",
      createdAt: isoDaysAgo(1),
      postId: "pst_public",
      title: "Launch",
      visibility: "public",
    })
    await insertPost({
      body: "Members-only launch notes",
      createdAt: isoDaysAgo(0),
      postId: "pst_private",
      title: "Launch private",
      visibility: "members_only",
    })

    const publicResults = await searchPublishedPosts(db, "com_test", {
      query: "launch",
      visibility: "public",
    })

    expect(publicResults.map((post) => post.postId)).toEqual(["pst_public"])
  })

  test("listUserPostsInCommunity returns recent published posts for one user", async () => {
    const db = await createTestClient()
    await insertPost({
      authorUserId: "usr_target",
      body: "This body is intentionally long enough to be excerpted by the board read service.",
      createdAt: isoDaysAgo(3),
      postId: "pst_old",
      title: "Older target post",
    })
    await insertPost({
      authorUserId: "usr_target",
      createdAt: isoDaysAgo(1),
      postId: "pst_new",
      title: "New target post",
    })
    await insertPost({
      authorUserId: "usr_target",
      createdAt: isoDaysAgo(0),
      postId: "pst_draft",
      status: "draft",
      title: "Draft target post",
    })
    await insertPost({
      authorUserId: "usr_other",
      createdAt: isoDaysAgo(0),
      postId: "pst_other",
      title: "Other user post",
    })

    const posts = await listUserPostsInCommunity(db, "com_test", "usr_target", {
      excerptChars: 40,
      limit: 10,
    })

    expect(posts.map((post) => post.postId)).toEqual(["pst_new", "pst_old"])
    expect(posts[1]!.bodyExcerpt.length).toBeLessThanOrEqual(40)
  })

  test("listUserCommentsInCommunity returns comments on published threads only", async () => {
    const db = await createTestClient()
    await insertPost({
      createdAt: isoDaysAgo(5),
      postId: "pst_thread",
      title: "Published thread",
    })
    await insertPost({
      createdAt: isoDaysAgo(5),
      postId: "pst_hidden_thread",
      status: "hidden",
      title: "Hidden thread",
    })
    await insertComment({
      authorUserId: "usr_target",
      body: "Most recent target comment",
      commentId: "cmt_new",
      createdAt: isoDaysAgo(1),
      score: 3,
      threadRootPostId: "pst_thread",
    })
    await insertComment({
      authorUserId: "usr_target",
      body: "Old target comment",
      commentId: "cmt_old",
      createdAt: isoDaysAgo(2),
      threadRootPostId: "pst_thread",
    })
    await insertComment({
      authorUserId: "usr_target",
      body: "Hidden target comment",
      commentId: "cmt_hidden",
      createdAt: isoDaysAgo(0),
      status: "hidden",
      threadRootPostId: "pst_thread",
    })
    await insertComment({
      authorUserId: "usr_target",
      body: "Comment on hidden post",
      commentId: "cmt_hidden_post",
      createdAt: isoDaysAgo(0),
      threadRootPostId: "pst_hidden_thread",
    })

    const comments = await listUserCommentsInCommunity(db, "com_test", "usr_target")

    expect(comments.map((comment) => comment.commentId)).toEqual(["cmt_new", "cmt_old"])
    expect(comments[0]!.threadTitle).toBe("Published thread")
    expect(comments[0]!.score).toBe(3)
  })

  test("getThreadWithComments returns a published thread with bounded published comments", async () => {
    const db = await createTestClient()
    await insertPost({
      body: "Thread body",
      createdAt: isoDaysAgo(3),
      postId: "pst_thread",
      title: "Thread title",
    })
    await insertComment({
      body: "Top comment",
      commentId: "cmt_top",
      createdAt: isoDaysAgo(2),
      score: 10,
      threadRootPostId: "pst_thread",
    })
    await insertComment({
      body: "Second comment",
      commentId: "cmt_second",
      createdAt: isoDaysAgo(1),
      score: 5,
      threadRootPostId: "pst_thread",
    })
    await insertComment({
      body: "Hidden comment",
      commentId: "cmt_hidden",
      createdAt: isoDaysAgo(0),
      score: 100,
      status: "hidden",
      threadRootPostId: "pst_thread",
    })

    const thread = await getThreadWithComments(db, "pst_thread", {
      commentLimit: 1,
    })

    expect(thread?.post).toMatchObject({
      postId: "pst_thread",
      title: "Thread title",
    })
    expect(thread?.comments.map((comment) => comment.commentId)).toEqual(["cmt_top"])
  })
})
