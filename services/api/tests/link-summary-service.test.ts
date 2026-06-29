import { afterEach, describe, expect, test } from "bun:test"
import { createClient } from "@libsql/client"
import { join } from "node:path"
import { openCommunityDb } from "../src/lib/communities/community-db-factory"
import { runCommunityJob } from "../src/lib/communities/jobs/handlers"
import { insertPostForTest as insertPost } from "./community-test-helpers"
import {
  generateAndStoreLinkSummary,
  translateAndStoreLinkSummary,
} from "../src/lib/posts/link-enrichment/summary-service"
import type { Env } from "../src/types"
import {
  buildCommunityRepository,
  cleanupCommunityJobRunnerArtifacts,
  createCommunityJobRunnerRoot,
  seedCommunityState,
} from "./community-job-runner-test-helpers"
import { withMockedFetch } from "./helpers"

const clients: Array<{ close: () => void }> = []

afterEach(async () => {
  for (const client of clients.splice(0)) {
    client.close()
  }
  await cleanupCommunityJobRunnerArtifacts()
})

async function createControlPlaneClient(url = "file::memory:") {
  const client = createClient({ url })
  clients.push(client)
  await client.execute(`
    CREATE TABLE link_enrichments (
      link_enrichment_id TEXT PRIMARY KEY,
      normalized_url TEXT NOT NULL UNIQUE,
      canonical_url TEXT,
      provider TEXT NOT NULL,
      status TEXT NOT NULL,
      title TEXT,
      description TEXT,
      source_language TEXT,
      publisher TEXT,
      published_at TEXT,
      image_url TEXT,
      markdown TEXT,
      summary_json TEXT,
      translations_json TEXT,
      summary_status TEXT,
      summary_model TEXT,
      error TEXT,
      fetched_at TEXT,
      summarized_at TEXT,
      created_at TEXT NOT NULL,
      updated_at TEXT NOT NULL
    )
  `)
  await client.execute(`
    CREATE TABLE link_enrichment_usages (
      normalized_url TEXT NOT NULL,
      community_id TEXT NOT NULL,
      post_id TEXT NOT NULL,
      link_enrichment_id TEXT,
      snapshot_synced_at TEXT,
      created_at TEXT NOT NULL,
      updated_at TEXT NOT NULL,
      PRIMARY KEY (normalized_url, community_id, post_id)
    )
  `)
  return client
}

describe("link summary materialization", () => {
  test("generates and stores a summary for ready markdown", async () => {
    const controlPlaneClient = await createControlPlaneClient()
    await controlPlaneClient.execute({
      sql: `
        INSERT INTO link_enrichments (
          link_enrichment_id, normalized_url, canonical_url, provider, status,
          title, description, publisher, published_at, image_url,
          markdown, summary_json, summary_status, summary_model, error,
          fetched_at, summarized_at, created_at, updated_at
        ) VALUES (
          'len_summary', 'https://example.com/story', 'https://example.com/story',
          'firecrawl', 'ready', 'Story title', 'Story description', 'Example News',
          '2026-05-02T09:00:00.000Z', 'https://cdn.example.com/story.jpg',
          '# Story title\\n\\nArticle body.', NULL, NULL, NULL,
          NULL, '2026-05-02T09:00:00.000Z', NULL,
          '2026-05-02T09:00:00.000Z', '2026-05-02T09:00:00.000Z'
        )
      `,
    })

    const result = await generateAndStoreLinkSummary({
      env: {
        OPENROUTER_API_KEY: "or-test",
        OPENROUTER_BASE_URL: "https://openrouter.test/v1",
        OPENROUTER_LINK_SUMMARY_MODEL: "test/summary-model",
      },
      controlPlaneClient,
      normalizedUrl: "https://example.com/story",
      now: "2026-05-02T10:00:00.000Z",
      fetcher: (async () => new Response(JSON.stringify({
        choices: [
          {
            message: {
              content: JSON.stringify({
                summary_paragraph: "A neutral paragraph summary.",
                short_summary: "A short summary.",
                key_points: ["First point.", "Second point.", "Third point."],
              }),
            },
          },
        ],
      }), {
        headers: { "content-type": "application/json" },
      })) as unknown as typeof fetch,
    })

    expect(result.resultRef).toBe("ready:https://example.com/story")
    const rows = await controlPlaneClient.execute("SELECT summary_json, summary_status, summary_model, summarized_at, error FROM link_enrichments")
    expect(rows.rows[0]?.summary_status).toBe("ready")
    expect(rows.rows[0]?.summary_model).toBe("test/summary-model")
    expect(rows.rows[0]?.summarized_at).toBe("2026-05-02T10:00:00.000Z")
    expect(rows.rows[0]?.error).toBeNull()
    const summary = JSON.parse(String(rows.rows[0]?.summary_json)) as {
      summary_paragraph: string
      short_summary: string
      key_points: string[]
    }
    expect(summary.summary_paragraph).toBe("A neutral paragraph summary.")
    expect(summary.short_summary).toBe("A short summary.")
    expect(summary.key_points).toEqual(["First point.", "Second point.", "Third point."])
  })

  test("rethrows retryable OpenRouter summary failures and leaves the record pending", async () => {
    const controlPlaneClient = await createControlPlaneClient()
    await controlPlaneClient.execute({
      sql: `
        INSERT INTO link_enrichments (
          link_enrichment_id, normalized_url, canonical_url, provider, status,
          title, description, publisher, published_at, image_url,
          markdown, summary_json, summary_status, summary_model, error,
          fetched_at, summarized_at, created_at, updated_at
        ) VALUES (
          'len_retry', 'https://example.com/retry', 'https://example.com/retry',
          'firecrawl', 'ready', 'Retry title', NULL, 'Example News',
          NULL, NULL, '# Retry title\\n\\nArticle body.',
          NULL, NULL, NULL, NULL,
          '2026-05-02T09:00:00.000Z', NULL,
          '2026-05-02T09:00:00.000Z', '2026-05-02T09:00:00.000Z'
        )
      `,
    })

    await expect(generateAndStoreLinkSummary({
      env: {
        OPENROUTER_API_KEY: "or-test",
        OPENROUTER_BASE_URL: "https://openrouter.test/v1",
      },
      controlPlaneClient,
      normalizedUrl: "https://example.com/retry",
      now: "2026-05-02T10:00:00.000Z",
      fetcher: (async () => new Response("Unauthorized", { status: 401 })) as unknown as typeof fetch,
    })).rejects.toThrow("OpenRouter link summary request failed with http_401")

    const rows = await controlPlaneClient.execute("SELECT summary_json, summary_status, error, summarized_at FROM link_enrichments")
    expect(rows.rows[0]?.summary_json).toBeNull()
    expect(rows.rows[0]?.summary_status).toBe("pending")
    expect(rows.rows[0]?.error).toBeNull()
    expect(rows.rows[0]?.summarized_at).toBe("2026-05-02T10:00:00.000Z")
  })

  test("stores terminal summary schema failures as failed snapshots", async () => {
    const controlPlaneClient = await createControlPlaneClient()
    await controlPlaneClient.execute({
      sql: `
        INSERT INTO link_enrichments (
          link_enrichment_id, normalized_url, canonical_url, provider, status,
          title, description, publisher, published_at, image_url,
          markdown, summary_json, summary_status, summary_model, error,
          fetched_at, summarized_at, created_at, updated_at
        ) VALUES (
          'len_schema', 'https://example.com/schema', 'https://example.com/schema',
          'firecrawl', 'ready', 'Schema title', NULL, 'Example News',
          NULL, NULL, '# Schema title\\n\\nArticle body.',
          NULL, NULL, NULL, NULL,
          '2026-05-02T09:00:00.000Z', NULL,
          '2026-05-02T09:00:00.000Z', '2026-05-02T09:00:00.000Z'
        )
      `,
    })

    const result = await generateAndStoreLinkSummary({
      env: {
        OPENROUTER_API_KEY: "or-test",
        OPENROUTER_BASE_URL: "https://openrouter.test/v1",
      },
      controlPlaneClient,
      normalizedUrl: "https://example.com/schema",
      now: "2026-05-02T10:00:00.000Z",
      fetcher: (async () => new Response(JSON.stringify({
        choices: [
          {
            message: {
              content: JSON.stringify({
                summary_paragraph: "",
                short_summary: "A short summary.",
                key_points: ["First point.", "Second point.", "Third point."],
              }),
            },
          },
        ],
      }), {
        headers: { "content-type": "application/json" },
      })) as unknown as typeof fetch,
    })

    expect(result.resultRef).toBe("failed:OpenRouter link summary response schema mismatch: invalid summary_paragraph")
    const rows = await controlPlaneClient.execute("SELECT summary_json, summary_status, error FROM link_enrichments")
    expect(rows.rows[0]?.summary_json).toBeNull()
    expect(rows.rows[0]?.summary_status).toBe("failed")
    expect(rows.rows[0]?.error).toBe("OpenRouter link summary response schema mismatch: invalid summary_paragraph")
    expect(result.snapshotJson).toContain("\"status\":\"failed\"")
  })

  test("stores localized link summary translations in the snapshot", async () => {
    const controlPlaneClient = await createControlPlaneClient()
    await controlPlaneClient.execute({
      sql: `
        INSERT INTO link_enrichments (
          link_enrichment_id, normalized_url, canonical_url, provider, status,
          title, description, publisher, published_at, image_url,
          markdown, summary_json, translations_json, summary_status, summary_model, error,
          fetched_at, summarized_at, created_at, updated_at
        ) VALUES (
          'len_translation', 'https://example.com/story', 'https://example.com/story',
          'firecrawl', 'ready', 'Israel seizes Gaza aid ships', 'Story description', 'Reuters',
          '2026-05-02T09:00:00.000Z', 'https://cdn.example.com/story.jpg',
          '# Story title\\n\\nArticle body.',
          '{"summary_paragraph":"A neutral paragraph summary.","short_summary":"A short summary.","key_points":["Ships seized off Greece","Israel cites blockade","Turkey condemns move"],"generated_at":"2026-05-02T10:00:00.000Z","model":"test/summary"}',
          NULL, 'ready', 'test/summary', NULL,
          '2026-05-02T09:00:00.000Z', '2026-05-02T10:00:00.000Z',
          '2026-05-02T09:00:00.000Z', '2026-05-02T10:00:00.000Z'
        )
      `,
    })

    const result = await translateAndStoreLinkSummary({
      env: {
        OPENROUTER_API_KEY: "or-test",
        OPENROUTER_BASE_URL: "https://openrouter.test/v1",
        OPENROUTER_LINK_SUMMARY_TRANSLATION_MODEL: "test/translation-model",
      },
      controlPlaneClient,
      normalizedUrl: "https://example.com/story",
      locale: "ar",
      now: "2026-05-02T11:00:00.000Z",
      fetcher: (async () => new Response(JSON.stringify({
        choices: [
          {
            message: {
              content: JSON.stringify({
                target_locale: "ar",
                title: "إسرائيل تستولي على سفن مساعدات غزة",
                description: "وصف الخبر.",
                summary_paragraph: "ملخص عربي محايد.",
                short_summary: "ملخص قصير.",
                key_points: ["مصادرة سفن قبالة اليونان", "إسرائيل تستند إلى الحصار", "تركيا تدين التحرك"],
              }),
            },
          },
        ],
      }), {
        headers: { "content-type": "application/json" },
      })) as unknown as typeof fetch,
    })

    expect(result.resultRef).toBe("ready:https://example.com/story:ar")
    const rows = await controlPlaneClient.execute("SELECT translations_json FROM link_enrichments")
    const translations = JSON.parse(String(rows.rows[0]?.translations_json)) as Record<string, { title: string }>
    expect(translations.ar?.title).toBe("إسرائيل تستولي على سفن مساعدات غزة")
    const snapshot = JSON.parse(String(result.snapshotJson)) as {
      translations?: Record<string, { summary: { key_points: string[] } }>
    }
    expect(snapshot.translations?.ar?.summary.key_points).toEqual(["مصادرة سفن قبالة اليونان", "إسرائيل تستند إلى الحصار", "تركيا تدين التحرك"])
  })

  test("translates English display fields when source metadata is non-English", async () => {
    const controlPlaneClient = await createControlPlaneClient()
    await controlPlaneClient.execute({
      sql: `
        INSERT INTO link_enrichments (
          link_enrichment_id, normalized_url, canonical_url, provider, status,
          title, description, source_language, publisher, published_at, image_url,
          markdown, summary_json, translations_json, summary_status, summary_model, error,
          fetched_at, summarized_at, created_at, updated_at
        ) VALUES (
          'len_english_translation', 'https://example.ma/story', 'https://example.ma/story',
          'firecrawl', 'ready', 'الداخلية تحقق في اختلالات رخص البناء والتعمير بفاس', NULL, 'ar', 'Example',
          '2026-05-02T09:00:00.000Z', NULL,
          '# Story title\\n\\nArticle body.',
          '{"summary_paragraph":"The Ministry is investigating construction irregularities.","short_summary":"The ministry opened a Fez probe.","key_points":["Interior Ministry investigates Fez","Probe follows 22 deaths","Permits are under review"],"generated_at":"2026-05-02T10:00:00.000Z","model":"test/summary"}',
          NULL, 'ready', 'test/summary', NULL,
          '2026-05-02T09:00:00.000Z', '2026-05-02T10:00:00.000Z',
          '2026-05-02T09:00:00.000Z', '2026-05-02T10:00:00.000Z'
        )
      `,
    })

    const result = await translateAndStoreLinkSummary({
      env: {
        OPENROUTER_API_KEY: "or-test",
        OPENROUTER_BASE_URL: "https://openrouter.test/v1",
        OPENROUTER_LINK_SUMMARY_TRANSLATION_MODEL: "test/translation-model",
      },
      controlPlaneClient,
      normalizedUrl: "https://example.ma/story",
      locale: "en",
      now: "2026-05-02T11:00:00.000Z",
      fetcher: (async () => new Response(JSON.stringify({
        choices: [
          {
            message: {
              content: JSON.stringify({
                target_locale: "en",
                title: "Interior Ministry investigates building permit failures in Fez",
                description: null,
                summary_paragraph: "The Ministry is investigating construction irregularities.",
                short_summary: "The ministry opened a Fez probe.",
                key_points: ["Interior Ministry investigates Fez", "Probe follows 22 deaths", "Permits are under review"],
              }),
            },
          },
        ],
      }), {
        headers: { "content-type": "application/json" },
      })) as unknown as typeof fetch,
    })

    expect(result.resultRef).toBe("ready:https://example.ma/story:en")
    const rows = await controlPlaneClient.execute("SELECT translations_json FROM link_enrichments")
    const translations = JSON.parse(String(rows.rows[0]?.translations_json)) as Record<string, { title: string }>
    expect(translations.en?.title).toBe("Interior Ministry investigates building permit failures in Fez")
  })

  test("marks ready enrichments without markdown as unavailable", async () => {
    const controlPlaneClient = await createControlPlaneClient()
    await controlPlaneClient.execute({
      sql: `
        INSERT INTO link_enrichments (
          link_enrichment_id, normalized_url, canonical_url, provider, status,
          title, description, publisher, published_at, image_url,
          markdown, summary_json, summary_status, summary_model, error,
          fetched_at, summarized_at, created_at, updated_at
        ) VALUES (
          'len_no_markdown', 'https://example.com/no-markdown', 'https://example.com/no-markdown',
          'native', 'ready', 'Native title', NULL, NULL,
          NULL, 'https://cdn.example.com/card.jpg',
          NULL, NULL, NULL, NULL,
          NULL, '2026-05-02T09:00:00.000Z', NULL,
          '2026-05-02T09:00:00.000Z', '2026-05-02T09:00:00.000Z'
        )
      `,
    })

    const result = await generateAndStoreLinkSummary({
      env: {
        OPENROUTER_API_KEY: "or-test",
      },
      controlPlaneClient,
      normalizedUrl: "https://example.com/no-markdown",
      now: "2026-05-02T10:00:00.000Z",
      fetcher: (() => {
        throw new Error("summary provider should not be called without markdown")
      }) as unknown as typeof fetch,
    })

    expect(result.resultRef).toBe("unavailable:no_markdown")
    const rows = await controlPlaneClient.execute("SELECT summary_status, error, summarized_at FROM link_enrichments")
    expect(rows.rows[0]?.summary_status).toBe("unavailable")
    expect(rows.rows[0]?.error).toBe("no_markdown")
    expect(rows.rows[0]?.summarized_at).toBe("2026-05-02T10:00:00.000Z")
  })

  test("reuses an existing ready summary without calling the provider", async () => {
    const controlPlaneClient = await createControlPlaneClient()
    await controlPlaneClient.execute({
      sql: `
        INSERT INTO link_enrichments (
          link_enrichment_id, normalized_url, canonical_url, provider, status,
          title, description, publisher, published_at, image_url,
          markdown, summary_json, summary_status, summary_model, error,
          fetched_at, summarized_at, created_at, updated_at
        ) VALUES (
          'len_ready', 'https://example.com/ready', 'https://example.com/ready',
          'firecrawl', 'ready', 'Ready title', NULL, 'Example News',
          NULL, 'https://cdn.example.com/ready.jpg',
          '# Ready', '{"summary_paragraph":"Existing paragraph.","short_summary":"Existing short.","key_points":["One.","Two.","Three."],"generated_at":"2026-05-02T09:00:00.000Z","model":"test/model"}',
          'ready', 'test/model',
          NULL, '2026-05-02T09:00:00.000Z', '2026-05-02T09:00:00.000Z',
          '2026-05-02T09:00:00.000Z', '2026-05-02T09:00:00.000Z'
        )
      `,
    })

    const result = await generateAndStoreLinkSummary({
      env: {
        OPENROUTER_API_KEY: "or-test",
      },
      controlPlaneClient,
      normalizedUrl: "https://example.com/ready",
      now: "2026-05-02T10:00:00.000Z",
      fetcher: (() => {
        throw new Error("summary provider should not be called for ready summaries")
      }) as unknown as typeof fetch,
    })

    expect(result.resultRef).toBe("skipped:summary_ready")
    expect(result.snapshotJson).toContain("Existing paragraph.")
  })

  test("fans generated summaries out to community post snapshots", async () => {
    const rootDir = await createCommunityJobRunnerRoot("pirate-link-summary-fanout-")
    const communityId = "cmt_link_summary_fanout"
    const controlPlanePath = join(rootDir, "control-plane.db")
    const controlPlaneClient = await createControlPlaneClient(`file:${controlPlanePath}`)
    const env: Env = {
      LOCAL_COMMUNITY_DB_ROOT: rootDir,
      CONTROL_PLANE_DATABASE_URL: `file:${controlPlanePath}`,
      OPENROUTER_API_KEY: "or-test",
      OPENROUTER_BASE_URL: "https://openrouter.test/v1",
      OPENROUTER_LINK_SUMMARY_MODEL: "test/summary-model",
    }
    const repo = buildCommunityRepository(join(rootDir, "community.db"), communityId)

    await seedCommunityState({
      env,
      repo,
      communityId,
      memberUserIds: ["usr_owner"],
    })

    let firstPostId = ""
    let secondPostId = ""
    const db = await openCommunityDb(env, repo, communityId)
    try {
      const now = "2026-05-02T09:00:00.000Z"
      const first = await insertPost({
        client: db.client,
        communityId,
        authorUserId: "usr_owner",
        body: {
          post_type: "link",
          link_url: "https://example.com/story",
          idempotency_key: "summary-fanout-1",
        },
        createdAt: now,
      })
      const second = await insertPost({
        client: db.client,
        communityId,
        authorUserId: "usr_owner",
        body: {
          post_type: "link",
          link_url: "https://example.com/story",
          idempotency_key: "summary-fanout-2",
        },
        createdAt: now,
      })
      firstPostId = first.post_id
      secondPostId = second.post_id
    } finally {
      db.close()
    }

    await controlPlaneClient.execute({
      sql: `
        INSERT INTO link_enrichments (
          link_enrichment_id, normalized_url, canonical_url, provider, status,
          title, description, publisher, published_at, image_url,
          markdown, summary_json, summary_status, summary_model, error,
          fetched_at, summarized_at, created_at, updated_at
        ) VALUES (
          'len_fanout', 'https://example.com/story', 'https://example.com/story',
          'firecrawl', 'ready', 'Fanout title', 'Description', 'Example News',
          '2026-05-02T09:00:00.000Z', 'https://cdn.example.com/story.jpg',
          '# Fanout title\\n\\nArticle body.', NULL, NULL, NULL,
          NULL, '2026-05-02T09:00:00.000Z', NULL,
          '2026-05-02T09:00:00.000Z', '2026-05-02T09:00:00.000Z'
        )
      `,
    })
    for (const postId of [firstPostId, secondPostId]) {
      await controlPlaneClient.execute({
        sql: `
          INSERT INTO link_enrichment_usages (
            normalized_url, community_id, post_id, link_enrichment_id,
            snapshot_synced_at, created_at, updated_at
          ) VALUES (
            'https://example.com/story', ?1, ?2, 'len_fanout',
            NULL, '2026-05-02T09:00:00.000Z', '2026-05-02T09:00:00.000Z'
          )
        `,
        args: [communityId, postId],
      })
    }

    await withMockedFetch(() => (async () => new Response(JSON.stringify({
      choices: [
        {
          message: {
            content: JSON.stringify({
              summary_paragraph: "A fan-out paragraph summary.",
              short_summary: "A fan-out short summary.",
              key_points: ["First fan-out point.", "Second fan-out point.", "Third fan-out point."],
            }),
          },
        },
      ],
    }), {
      headers: { "content-type": "application/json" },
    })), async () => {
      const resultRef = await runCommunityJob({
        env,
        communityRepository: repo,
        job: {
          job_id: "cjb_link_summary",
          community_id: communityId,
          job_type: "link_summary_materialize",
          subject_type: "link_enrichment",
          subject_id: "https://example.com/story",
          status: "running",
          payload_json: JSON.stringify({ normalized_url: "https://example.com/story" }),
          result_ref: null,
          error_code: null,
          attempt_count: 1,
          available_at: null,
          created_at: "2026-05-02T10:00:00.000Z",
          updated_at: "2026-05-02T10:00:00.000Z",
        },
      })
      expect(resultRef).toContain("ready:https://example.com/story:synced:2:failed:0")
    })

    const verifyDb = await openCommunityDb(env, repo, communityId)
    try {
      const rows = await verifyDb.client.execute({
        sql: `
          SELECT post_id, link_og_title, link_og_image_url, link_enrichment_snapshot_json
          FROM posts
          WHERE post_id IN (?1, ?2)
          ORDER BY post_id ASC
        `,
        args: [firstPostId, secondPostId],
      })
      expect(rows.rows).toHaveLength(2)
      for (const row of rows.rows) {
        expect(row.link_og_title).toBe("Fanout title")
        expect(row.link_og_image_url).toBe("https://cdn.example.com/story.jpg")
        const snapshot = JSON.parse(String(row.link_enrichment_snapshot_json)) as {
          summary: {
            summary_paragraph: string
            key_points: string[]
          }
        }
        expect(snapshot.summary.summary_paragraph).toBe("A fan-out paragraph summary.")
        expect(snapshot.summary.key_points).toEqual([
          "First fan-out point.",
          "Second fan-out point.",
          "Third fan-out point.",
        ])
      }
    } finally {
      verifyDb.close()
    }

    const usageRows = await controlPlaneClient.execute("SELECT snapshot_synced_at FROM link_enrichment_usages")
    expect(usageRows.rows.every((row) => typeof row.snapshot_synced_at === "string")).toBe(true)
  })

  test("summary job registers its originating post when usage index is missing", async () => {
    const rootDir = await createCommunityJobRunnerRoot("pirate-link-summary-origin-")
    const communityId = "cmt_link_summary_origin"
    const controlPlanePath = join(rootDir, "control-plane.db")
    const controlPlaneClient = await createControlPlaneClient(`file:${controlPlanePath}`)
    const env: Env = {
      LOCAL_COMMUNITY_DB_ROOT: rootDir,
      CONTROL_PLANE_DATABASE_URL: `file:${controlPlanePath}`,
      OPENROUTER_API_KEY: "or-test",
      OPENROUTER_BASE_URL: "https://openrouter.test/v1",
      OPENROUTER_LINK_SUMMARY_MODEL: "test/summary-model",
    } as Env
    const repo = buildCommunityRepository(join(rootDir, "community.db"), communityId)
    await seedCommunityState({
      env,
      repo,
      communityId,
      memberUserIds: ["usr_owner"],
    })

    let postId = ""
    const db = await openCommunityDb(env, repo, communityId)
    try {
      const post = await insertPost({
        client: db.client,
        communityId,
        authorUserId: "usr_owner",
        body: {
          post_type: "link",
          link_url: "https://example.com/origin",
          idempotency_key: "summary-origin-1",
        },
        createdAt: "2026-05-02T09:00:00.000Z",
      })
      postId = post.post_id
    } finally {
      db.close()
    }

    await controlPlaneClient.execute({
      sql: `
        INSERT INTO link_enrichments (
          link_enrichment_id, normalized_url, canonical_url, provider, status,
          title, description, publisher, published_at, image_url,
          markdown, summary_json, summary_status, summary_model, error,
          fetched_at, summarized_at, created_at, updated_at
        ) VALUES (
          'len_origin', 'https://example.com/origin', 'https://example.com/origin',
          'firecrawl', 'ready', 'Origin title', 'Description', 'Example News',
          '2026-05-02T09:00:00.000Z', 'https://cdn.example.com/origin.jpg',
          '# Origin title\\n\\nArticle body.', NULL, NULL, NULL,
          NULL, '2026-05-02T09:00:00.000Z', NULL,
          '2026-05-02T09:00:00.000Z', '2026-05-02T09:00:00.000Z'
        )
      `,
    })

    await withMockedFetch(() => (async () => new Response(JSON.stringify({
      choices: [
        {
          message: {
            content: JSON.stringify({
              summary_paragraph: "An origin paragraph summary.",
              short_summary: "An origin short summary.",
              key_points: ["First origin point.", "Second origin point.", "Third origin point."],
            }),
          },
        },
      ],
    }), {
      headers: { "content-type": "application/json" },
    })), async () => {
      const resultRef = await runCommunityJob({
        env,
        communityRepository: repo,
        job: {
          job_id: "cjb_link_summary_origin",
          community_id: communityId,
          job_type: "link_summary_materialize",
          subject_type: "link_enrichment",
          subject_id: "https://example.com/origin",
          status: "running",
          payload_json: JSON.stringify({
            normalized_url: "https://example.com/origin",
            post_id: postId,
          }),
          result_ref: null,
          error_code: null,
          attempt_count: 1,
          available_at: null,
          created_at: "2026-05-02T10:00:00.000Z",
          updated_at: "2026-05-02T10:00:00.000Z",
        },
      })
      expect(resultRef).toContain("ready:https://example.com/origin:synced:1:failed:0")
    })

    const verifyDb = await openCommunityDb(env, repo, communityId)
    try {
      const rows = await verifyDb.client.execute({
        sql: "SELECT link_enrichment_snapshot_json FROM posts WHERE post_id = ?1",
        args: [postId],
      })
      const snapshot = JSON.parse(String(rows.rows[0]?.link_enrichment_snapshot_json)) as {
        summary: { key_points: string[] }
      }
      expect(snapshot.summary.key_points).toEqual([
        "First origin point.",
        "Second origin point.",
        "Third origin point.",
      ])
    } finally {
      verifyDb.close()
    }

    const usageRows = await controlPlaneClient.execute("SELECT community_id, post_id, snapshot_synced_at FROM link_enrichment_usages")
    expect(usageRows.rows).toHaveLength(1)
    expect(usageRows.rows[0]?.community_id).toBe(communityId)
    expect(usageRows.rows[0]?.post_id).toBe(postId)
    expect(typeof usageRows.rows[0]?.snapshot_synced_at).toBe("string")
  })
})
