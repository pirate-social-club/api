import { afterEach, describe, expect, test } from "bun:test"
import { createClient, type Client as LibsqlClient } from "@libsql/client"
import {
  buildCommunityContext,
  packCommunityContextSections,
} from "./context-builder"
import type { CommunityAssistantPolicy } from "./service"

let client: LibsqlClient | null = null

afterEach(() => {
  client?.close()
  client = null
})

async function createTestClient(): Promise<LibsqlClient> {
  client = createClient({ url: "file::memory:" })
  await client.batch([
    `
      CREATE TABLE communities (
        community_id TEXT PRIMARY KEY,
        display_name TEXT NOT NULL,
        description TEXT,
        settings_json TEXT
      )
    `,
    `
      CREATE TABLE community_rules (
        rule_id TEXT PRIMARY KEY,
        community_id TEXT NOT NULL,
        title TEXT NOT NULL,
        body TEXT NOT NULL,
        position INTEGER NOT NULL DEFAULT 0,
        status TEXT NOT NULL,
        created_at TEXT NOT NULL
      )
    `,
    `
      CREATE TABLE community_memberships (
        community_id TEXT NOT NULL,
        user_id TEXT NOT NULL,
        status TEXT NOT NULL,
        created_at TEXT NOT NULL
      )
    `,
    `
      CREATE TABLE community_roles (
        community_id TEXT NOT NULL,
        user_id TEXT NOT NULL,
        role TEXT NOT NULL,
        status TEXT NOT NULL
      )
    `,
    `
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
    `,
    `
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
    `,
  ], "write")
  await client.execute({
    sql: `
      INSERT INTO communities (community_id, display_name, description, settings_json)
      VALUES (?1, 'Harbor Lab', 'A board for testing useful community assistants.', ?2)
    `,
    args: [
      "com_test",
      JSON.stringify({
        reference_links: [
          { label: "Docs", url: "https://example.com/docs" },
        ],
      }),
    ],
  })
  return client
}

function policy(overrides: Partial<CommunityAssistantPolicy> = {}): CommunityAssistantPolicy {
  const base: CommunityAssistantPolicy = {
    object: "community_assistant_policy",
    community: "com_test",
    enabled: true,
    displayName: "Harbor Guide",
    shortBio: "",
    avatarRef: null,
    systemPrompt: "Answer from board context.",
    defaultPrompt: "Ask a question.",
    starterPrompts: [],
    openRouterKeyStatus: { kind: "connected", last4: "abcd" },
    selectedModelId: "openrouter/free",
    availableModels: [],
    contextMode: "live_sql",
    contextSources: {
      communityProfile: true,
      rules: true,
      referenceLinks: true,
      recentThreads: true,
      threadBodies: true,
      topComments: true,
      membershipState: true,
      moderationQueue: false,
      pinnedKnowledge: true,
    },
    maxContextThreads: 8,
    maxLookbackDays: 30,
    memoryEnabled: true,
    retentionMode: "per_user_private",
    retentionDays: 180,
    saveChatsToCommunityDb: true,
    actionMode: "answer_only",
    requireModeratorApprovalForWrites: true,
    perUserDailyMessageCap: 40,
    voiceMode: "off",
    sttProvider: "mistral",
    sttModel: "voxtral-mini-latest",
    ttsVoice: "",
    includeInSovereignExport: true,
    policyOrigin: "explicit",
    createdAt: "2026-01-01T00:00:00.000Z",
    updatedAt: "2026-01-01T00:00:00.000Z",
  }
  return {
    ...base,
    ...overrides,
    contextSources: {
      ...base.contextSources,
      ...overrides.contextSources,
    },
  }
}

async function insertRule(input: {
  body?: string
  position?: number
  ruleId: string
  title: string
}) {
  if (!client) throw new Error("missing test client")
  await client.execute({
    sql: `
      INSERT INTO community_rules (rule_id, community_id, title, body, position, status, created_at)
      VALUES (?1, 'com_test', ?2, ?3, ?4, 'active', '2026-01-01T00:00:00.000Z')
    `,
    args: [input.ruleId, input.title, input.body ?? "", input.position ?? 0],
  })
}

async function insertMembership() {
  if (!client) throw new Error("missing test client")
  await client.batch([
    {
      sql: `
        INSERT INTO community_memberships (community_id, user_id, status, created_at)
        VALUES ('com_test', 'usr_target', 'member', '2026-01-01T00:00:00.000Z')
      `,
      args: [],
    },
    {
      sql: `
        INSERT INTO community_roles (community_id, user_id, role, status)
        VALUES ('com_test', 'usr_target', 'moderator', 'active')
      `,
      args: [],
    },
  ], "write")
}

async function insertPost(input: {
  authorUserId?: string | null
  body?: string
  caption?: string
  createdAt: string
  postId: string
  title: string
}) {
  if (!client) throw new Error("missing test client")
  await client.execute({
    sql: `
      INSERT INTO posts (
        post_id, community_id, author_user_id, identity_mode, post_type, status,
        title, body, caption, created_at, updated_at, visibility
      )
      VALUES (?1, 'com_test', ?2, 'public', 'text', 'published', ?3, ?4, ?5, ?6, ?6, 'public')
    `,
    args: [
      input.postId,
      input.authorUserId ?? "usr_author",
      input.title,
      input.body ?? "",
      input.caption ?? "",
      input.createdAt,
    ],
  })
}

async function insertComment(input: {
  authorUserId?: string | null
  body: string
  commentId: string
  createdAt: string
  score?: number
  threadRootPostId: string
}) {
  if (!client) throw new Error("missing test client")
  await client.execute({
    sql: `
      INSERT INTO comments (
        comment_id, community_id, thread_root_post_id, parent_comment_id,
        author_user_id, identity_mode, body, status, depth, score, created_at, updated_at
      )
      VALUES (?1, 'com_test', ?2, NULL, ?3, 'public', ?4, 'published', 0, ?5, ?6, ?6)
    `,
    args: [
      input.commentId,
      input.threadRootPostId,
      input.authorUserId ?? "usr_commenter",
      input.body,
      input.score ?? 0,
      input.createdAt,
    ],
  })
}

function isoDaysAgo(days: number): string {
  return new Date(Date.now() - days * 24 * 60 * 60 * 1000).toISOString()
}

describe("assistant context builder", () => {
  test("packCommunityContextSections preserves higher-priority sections before trimming threads", () => {
    const packed = packCommunityContextSections([
      { key: "header", content: "Community context follows.\nContext mode: live_sql." },
      { key: "profile", content: "Community profile:\nName: Critical Harbor" },
      { key: "rules", content: "Community rules:\n1. Be precise: keep the harbor useful." },
      { key: "threads", content: `Recent threads:\n${"thread detail ".repeat(80)}` },
    ], 360)

    expect(packed.length).toBeLessThanOrEqual(360)
    expect(packed).toContain("Community profile:")
    expect(packed).toContain("Community rules:")
    expect(packed).toContain("[threads truncated]")
  })

  test("buildCommunityContext includes user activity for private users only", async () => {
    const db = await createTestClient()
    await insertMembership()
    await insertPost({
      authorUserId: "usr_target",
      body: "My introduction post explains that I want help with model selection.",
      createdAt: isoDaysAgo(2),
      postId: "pst_user_intro",
      title: "My introduction",
    })
    await insertPost({
      createdAt: isoDaysAgo(4),
      postId: "pst_thread",
      title: "Model selection thread",
    })
    await insertComment({
      authorUserId: "usr_target",
      body: "My comment asks whether the assistant can read my board activity.",
      commentId: "cmt_user_question",
      createdAt: isoDaysAgo(1),
      threadRootPostId: "pst_thread",
    })

    const basePolicy = policy({
      contextSources: {
        recentThreads: false,
        threadBodies: false,
        topComments: false,
      },
    })
    const privateContext = await buildCommunityContext({
      audience: "private_user",
      client: db,
      communityId: "com_test",
      policy: basePolicy,
      userId: "usr_target",
    })
    const publicContext = await buildCommunityContext({
      audience: "public_group",
      client: db,
      communityId: "com_test",
      policy: basePolicy,
      userId: null,
    })

    expect(privateContext).toContain("Viewer membership:")
    expect(privateContext).toContain("Viewer recent board activity:")
    expect(privateContext).toContain("My introduction")
    expect(privateContext).toContain("My comment asks")
    expect(publicContext).not.toContain("Viewer membership:")
    expect(publicContext).not.toContain("Viewer recent board activity:")
    expect(publicContext).not.toContain("My introduction")
  })

  test("buildCommunityContext ranks relevant threads above newer weak matches", async () => {
    const db = await createTestClient()
    await insertPost({
      body: "A detailed Rust token architecture note with token budgets and board context.",
      createdAt: isoDaysAgo(20),
      postId: "pst_relevant_old",
      title: "Rust token assistant architecture",
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
      body: "A short Rust update.",
      createdAt: isoDaysAgo(1),
      postId: "pst_weak_new",
      title: "Daily Rust update",
    })

    const context = await buildCommunityContext({
      audience: "private_user",
      client: db,
      communityId: "com_test",
      message: "What happened with rust token context?",
      policy: policy({
        contextSources: {
          membershipState: false,
          referenceLinks: false,
          rules: false,
          threadBodies: false,
          topComments: false,
        },
        maxContextThreads: 2,
      }),
      userId: null,
    })

    expect(context.indexOf("Rust token assistant architecture")).toBeLessThan(
      context.indexOf("Daily Rust update"),
    )
  })

  test("buildCommunityContext bounds user activity excerpts", async () => {
    const db = await createTestClient()
    await insertMembership()
    const longBody = "needle ".repeat(200)
    await insertPost({
      authorUserId: "usr_target",
      body: longBody,
      createdAt: isoDaysAgo(1),
      postId: "pst_long_user_post",
      title: "Long user post",
    })

    const context = await buildCommunityContext({
      audience: "private_user",
      client: db,
      communityId: "com_test",
      policy: policy({
        contextSources: {
          recentThreads: false,
          referenceLinks: false,
          rules: false,
          threadBodies: false,
          topComments: false,
        },
      }),
      userId: "usr_target",
    })

    expect(context).toContain("Long user post")
    expect(context).toContain("needle")
    expect(context).not.toContain(longBody)
  })
})
