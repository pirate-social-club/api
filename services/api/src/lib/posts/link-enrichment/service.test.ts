import { afterEach, describe, expect, test } from "bun:test"
import { createClient } from "@libsql/client"
import { hydrateGenericLinkEnrichment } from "./service"
import { MAX_POST_JSON_PROJECTION_LENGTH } from "../community-post-projection"

const clients: Array<{ close: () => void }> = []

afterEach(() => {
  for (const client of clients.splice(0)) {
    client.close()
  }
})

async function createControlPlaneClient() {
  const client = createClient({ url: "file::memory:" })
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

async function createCommunityClient() {
  const client = createClient({ url: "file::memory:" })
  clients.push(client)
  await client.execute(`
    CREATE TABLE posts (
      post_id TEXT PRIMARY KEY,
      post_type TEXT NOT NULL,
      link_og_image_url TEXT,
      link_og_title TEXT,
      link_enrichment_snapshot_json TEXT,
      link_enrichment_synced_at TEXT,
      updated_at TEXT NOT NULL
    )
  `)
  await client.execute(`
    CREATE TABLE community_jobs (
      job_id TEXT PRIMARY KEY,
      community_id TEXT NOT NULL,
      job_type TEXT NOT NULL,
      subject_type TEXT NOT NULL,
      subject_id TEXT NOT NULL,
      status TEXT NOT NULL,
      payload_json TEXT,
      result_ref TEXT,
      error_code TEXT,
      attempt_count INTEGER NOT NULL DEFAULT 0,
      available_at TEXT,
      created_at TEXT NOT NULL,
      updated_at TEXT NOT NULL
    )
  `)
  await client.execute({
    sql: `
      INSERT INTO posts (post_id, post_type, updated_at)
      VALUES ('pst_firecrawl', 'link', '2026-05-02T08:00:00.000Z')
    `,
  })
  return client
}

describe("hydrateGenericLinkEnrichment", () => {
  test("uses native metadata fallback when Firecrawl is not configured", async () => {
    const controlPlaneClient = await createControlPlaneClient()
    const communityClient = await createCommunityClient()
    const calls: string[] = []

    const result = await hydrateGenericLinkEnrichment({
      env: {},
      controlPlaneClient,
      communityClient,
      postId: "pst_firecrawl",
      url: "https://example.com/story?utm_campaign=launch",
      checkedAt: "2026-05-02T09:00:00.000Z",
      fetcher: (async (input: RequestInfo | URL) => {
        calls.push(String(input))
        return new Response(`
          <html>
            <head>
              <meta property="og:title" content="Native story title">
              <meta property="og:image" content="/native-card.jpg">
            </head>
          </html>
        `, {
          headers: { "content-type": "text/html" },
        })
      }) as unknown as typeof fetch,
    })

    expect(calls).toEqual(["https://example.com/story?utm_campaign=launch"])
    expect(result).toBe("https://example.com/native-card.jpg")

    const enrichmentRows = await controlPlaneClient.execute("SELECT provider, normalized_url FROM link_enrichments")
    expect(enrichmentRows.rows).toHaveLength(1)
    expect(enrichmentRows.rows[0]?.provider).toBe("native")
    expect(enrichmentRows.rows[0]?.normalized_url).toBe("https://example.com/story")

    const postRows = await communityClient.execute("SELECT * FROM posts WHERE post_id = 'pst_firecrawl'")
    expect(postRows.rows[0]?.link_og_title).toBe("Native story title")
    expect(postRows.rows[0]?.link_og_image_url).toBe("https://example.com/native-card.jpg")
  })

  test("falls back to native metadata after Firecrawl fails", async () => {
    const controlPlaneClient = await createControlPlaneClient()
    const communityClient = await createCommunityClient()
    const calls: string[] = []

    const result = await hydrateGenericLinkEnrichment({
      env: {
        FIRECRAWL_API_KEY: "fc-test",
      },
      controlPlaneClient,
      communityClient,
      postId: "pst_firecrawl",
      url: "https://example.com/firecrawl-fails",
      checkedAt: "2026-05-02T09:00:00.000Z",
      fetcher: (async (input: RequestInfo | URL) => {
        calls.push(String(input))
        if (String(input) === "https://api.firecrawl.dev/v2/scrape") {
          return new Response(JSON.stringify({ success: false, error: "blocked" }), {
            headers: { "content-type": "application/json" },
          })
        }
        return new Response(`
          <html>
            <head>
              <meta property="og:title" content="Fallback story title">
              <meta property="og:image" content="https://cdn.example.com/fallback.jpg">
            </head>
          </html>
        `, {
          headers: { "content-type": "text/html" },
        })
      }) as unknown as typeof fetch,
    })

    expect(calls).toEqual([
      "https://api.firecrawl.dev/v2/scrape",
      "https://example.com/firecrawl-fails",
    ])
    expect(result).toBe("https://cdn.example.com/fallback.jpg")

    const enrichmentRows = await controlPlaneClient.execute("SELECT provider, status, title, error FROM link_enrichments")
    expect(enrichmentRows.rows).toHaveLength(1)
    expect(enrichmentRows.rows[0]?.provider).toBe("native")
    expect(enrichmentRows.rows[0]?.status).toBe("ready")
    expect(enrichmentRows.rows[0]?.title).toBe("Fallback story title")
    expect(enrichmentRows.rows[0]?.error).toBeNull()
  })

  test("materializes a ready cache hit without outbound fetches", async () => {
    const controlPlaneClient = await createControlPlaneClient()
    const communityClient = await createCommunityClient()
    await controlPlaneClient.execute({
      sql: `
        INSERT INTO link_enrichments (
          link_enrichment_id, normalized_url, canonical_url, provider, status,
          title, description, publisher, published_at, image_url,
          markdown, summary_json, summary_status, summary_model, error,
          fetched_at, summarized_at, created_at, updated_at
        ) VALUES (
          'len_cached', 'https://example.com/cached', 'https://example.com/cached',
          'firecrawl', 'ready', 'Cached title', 'Cached description', 'Example',
          '2026-05-01T12:00:00.000Z', 'https://cdn.example.com/cached.jpg',
          '# Cached', NULL, NULL, NULL,
          NULL, '2026-05-02T08:00:00.000Z', NULL,
          '2026-05-02T08:00:00.000Z', '2026-05-02T08:00:00.000Z'
        )
      `,
    })

    const result = await hydrateGenericLinkEnrichment({
      env: {
        FIRECRAWL_API_KEY: "fc-test",
      },
      controlPlaneClient,
      communityClient,
      postId: "pst_firecrawl",
      url: "https://example.com/cached?utm_source=ignored",
      checkedAt: "2026-05-02T09:00:00.000Z",
      fetcher: (() => {
        throw new Error("fetch should not be called for cache hits")
      }) as unknown as typeof fetch,
    })

    expect(result).toBe("https://cdn.example.com/cached.jpg")
    const postRows = await communityClient.execute("SELECT * FROM posts WHERE post_id = 'pst_firecrawl'")
    expect(postRows.rows[0]?.link_og_title).toBe("Cached title")
    const snapshot = JSON.parse(String(postRows.rows[0]?.link_enrichment_snapshot_json)) as {
      provider: string
      description: string
      published_at: string
    }
    expect(snapshot.provider).toBe("firecrawl")
    expect(snapshot.description).toBe("Cached description")
    expect(snapshot.published_at).toBe("2026-05-01T12:00:00.000Z")
  })

  test("caps oversized cached enrichment fields before materializing a post snapshot", async () => {
    const controlPlaneClient = await createControlPlaneClient()
    const communityClient = await createCommunityClient()
    const oversizedText = "x".repeat(MAX_POST_JSON_PROJECTION_LENGTH)
    await controlPlaneClient.execute({
      sql: `
        INSERT INTO link_enrichments (
          link_enrichment_id, normalized_url, canonical_url, provider, status,
          title, description, publisher, published_at, image_url,
          markdown, summary_json, translations_json, summary_status, summary_model, error,
          fetched_at, summarized_at, created_at, updated_at
        ) VALUES (
          'len_oversized', 'https://example.com/oversized', 'https://example.com/oversized',
          'firecrawl', 'ready', ?1, ?1, 'Example',
          '2026-05-01T12:00:00.000Z', 'https://cdn.example.com/oversized.jpg',
          '# Oversized', ?2, NULL, 'ready', 'test-model',
          NULL, '2026-05-02T08:00:00.000Z', NULL,
          '2026-05-02T08:00:00.000Z', '2026-05-02T08:00:00.000Z'
        )
      `,
      args: [
        oversizedText,
        JSON.stringify({
          summary_paragraph: oversizedText,
          short_summary: oversizedText,
          key_points: [oversizedText, oversizedText],
          generated_at: "2026-05-02T08:30:00.000Z",
          model: "test-model",
        }),
      ],
    })

    await hydrateGenericLinkEnrichment({
      env: {
        FIRECRAWL_API_KEY: "fc-test",
      },
      controlPlaneClient,
      communityClient,
      postId: "pst_firecrawl",
      url: "https://example.com/oversized",
      checkedAt: "2026-05-02T09:00:00.000Z",
      fetcher: (() => {
        throw new Error("fetch should not be called for cache hits")
      }) as unknown as typeof fetch,
    })

    const postRows = await communityClient.execute("SELECT link_enrichment_snapshot_json FROM posts WHERE post_id = 'pst_firecrawl'")
    const rawSnapshot = String(postRows.rows[0]?.link_enrichment_snapshot_json)
    const snapshot = JSON.parse(rawSnapshot) as {
      title: string
      description: string
      summary: {
        summary_paragraph: string
        short_summary: string
        key_points: string[]
      }
    }
    expect(rawSnapshot.length < MAX_POST_JSON_PROJECTION_LENGTH).toBe(true)
    expect(snapshot.title).toHaveLength(2000)
    expect(snapshot.description).toHaveLength(2000)
    expect(snapshot.summary.summary_paragraph).toHaveLength(4000)
    expect(snapshot.summary.short_summary).toHaveLength(2000)
    expect(snapshot.summary.key_points[0]).toHaveLength(1000)
  })

  test("uses Firecrawl, caches the enrichment, and materializes a community snapshot", async () => {
    const controlPlaneClient = await createControlPlaneClient()
    const communityClient = await createCommunityClient()

    const result = await hydrateGenericLinkEnrichment({
      env: {
        FIRECRAWL_API_KEY: "fc-test",
      },
      controlPlaneClient,
      communityClient,
      communityId: "cmt_firecrawl",
      postId: "pst_firecrawl",
      url: "https://Reuters.com/world/story?utm_source=feed#section",
      checkedAt: "2026-05-02T09:00:00.000Z",
      fetcher: (async (input: RequestInfo | URL, init?: RequestInit) => {
        expect(String(input)).toBe("https://api.firecrawl.dev/v2/scrape")
        expect(init?.method).toBe("POST")
        expect((init?.headers as Record<string, string>).authorization).toBe("Bearer fc-test")
        return new Response(JSON.stringify({
          success: true,
          data: {
            markdown: "# Reuters story\n\nA short article body.",
            metadata: {
              title: "Fallback title",
              ogTitle: "Reuters story title",
              ogDescription: "Article description",
              ogImage: "https://cdn.example.com/story.jpg",
              ogSiteName: "Reuters",
              ogUrl: "https://www.reuters.com/world/story/",
              "article:published_time": "2026-04-29T15:14:00Z",
              statusCode: 200,
            },
          },
        }), {
          headers: { "content-type": "application/json" },
        })
      }) as unknown as typeof fetch,
    })

    expect(result).toBe("https://cdn.example.com/story.jpg")

    const enrichmentRows = await controlPlaneClient.execute("SELECT * FROM link_enrichments")
    expect(enrichmentRows.rows).toHaveLength(1)
    expect(enrichmentRows.rows[0]?.normalized_url).toBe("https://reuters.com/world/story")
    expect(enrichmentRows.rows[0]?.provider).toBe("firecrawl")
    expect(enrichmentRows.rows[0]?.title).toBe("Reuters story title")
    expect(enrichmentRows.rows[0]?.published_at).toBe("2026-04-29T15:14:00.000Z")
    expect(enrichmentRows.rows[0]?.markdown).toBe("# Reuters story\n\nA short article body.")

    const postRows = await communityClient.execute("SELECT * FROM posts WHERE post_id = 'pst_firecrawl'")
    const post = postRows.rows[0]!
    expect(post.link_og_title).toBe("Reuters story title")
    expect(post.link_og_image_url).toBe("https://cdn.example.com/story.jpg")
    expect(post.link_enrichment_synced_at).toBe("2026-05-02T09:00:00.000Z")
    const snapshot = JSON.parse(String(post.link_enrichment_snapshot_json)) as {
      version: number
      provider: string
      title: string
      image_url: string
      publisher: string
      published_at: string
    }
    expect(snapshot.version).toBe(1)
    expect(snapshot.provider).toBe("firecrawl")
    expect(snapshot.title).toBe("Reuters story title")
    expect(snapshot.image_url).toBe("https://cdn.example.com/story.jpg")
    expect(snapshot.publisher).toBe("Reuters")
    expect(snapshot.published_at).toBe("2026-04-29T15:14:00.000Z")

    const usageRows = await controlPlaneClient.execute("SELECT * FROM link_enrichment_usages")
    expect(usageRows.rows).toHaveLength(1)
    expect(usageRows.rows[0]?.normalized_url).toBe("https://reuters.com/world/story")
    expect(usageRows.rows[0]?.community_id).toBe("cmt_firecrawl")
    expect(usageRows.rows[0]?.post_id).toBe("pst_firecrawl")

    const jobRows = await communityClient.execute("SELECT job_type, subject_type, subject_id, payload_json FROM community_jobs")
    expect(jobRows.rows).toEqual([
      {
        job_type: "link_summary_materialize",
        subject_type: "link_enrichment",
        subject_id: "https://reuters.com/world/story",
        payload_json: JSON.stringify({
          normalized_url: "https://reuters.com/world/story",
          post_id: "pst_firecrawl",
        }),
      },
    ])
  })

  test("decodes HTML entities in Firecrawl title, description, and publisher at the storage seam", async () => {
    const controlPlaneClient = await createControlPlaneClient()
    const communityClient = await createCommunityClient()

    await hydrateGenericLinkEnrichment({
      env: {
        FIRECRAWL_API_KEY: "fc-test",
      },
      controlPlaneClient,
      communityClient,
      communityId: "cmt_firecrawl",
      postId: "pst_firecrawl",
      url: "https://daysofpalestine.ps/ben-and-jerry",
      checkedAt: "2026-05-02T09:00:00.000Z",
      fetcher: (async () => new Response(JSON.stringify({
        success: true,
        data: {
          markdown: "# Story",
          metadata: {
            ogTitle: "&#8220;Mmm&#8230;Tastes like genocide&#8221; Israel&#8217;s Ben &#038; Jerry",
            ogDescription: "Ben &amp; Jerry&#8217;s new flavour &mdash; near Gaza",
            ogSiteName: "Days of Palestine &amp; News",
            ogImage: "https://cdn.example.com/flavour.jpg",
            statusCode: 200,
          },
        },
      }), {
        headers: { "content-type": "application/json" },
      })) as unknown as typeof fetch,
    })

    const rows = await controlPlaneClient.execute("SELECT title, description, publisher FROM link_enrichments")
    expect(rows.rows[0]?.title).toBe("“Mmm…Tastes like genocide” Israel’s Ben & Jerry")
    expect(rows.rows[0]?.description).toBe("Ben & Jerry’s new flavour — near Gaza")
    expect(rows.rows[0]?.publisher).toBe("Days of Palestine & News")

    const postRows = await communityClient.execute("SELECT link_og_title FROM posts WHERE post_id = 'pst_firecrawl'")
    expect(postRows.rows[0]?.link_og_title).toBe("“Mmm…Tastes like genocide” Israel’s Ben & Jerry")
  })
})
