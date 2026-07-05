import { describe, expect, test } from "bun:test"
import {
  getPostPublishRequest,
  insertPostPublishRequest,
  markPostPublishRequestStatus,
} from "./community-post-publish-request-store"

type Statement = { sql: string; args?: unknown[] }

function makeExecutor(rows: Array<Record<string, unknown>> = []) {
  const statements: Statement[] = []
  return {
    statements,
    executor: {
      async execute(statement: Statement | string) {
        const normalized = typeof statement === "string" ? { sql: statement, args: [] } : statement
        statements.push(normalized)
        return { rows, rowsAffected: 1 }
      },
    },
  }
}

describe("community-post-publish-request-store", () => {
  test("inserts finalize inputs as a pure write with serialized listing draft", async () => {
    const { executor, statements } = makeExecutor()

    await insertPostPublishRequest({
      client: executor,
      communityId: "cmt_1",
      postId: "pst_1",
      publishMode: "async",
      requestBodyHash: "0xabc",
      listingDraft: {
        price_cents: 499,
        regional_pricing_enabled: true,
        donation_partner: "don_1",
        donation_share_bps: 1000,
        status: "active",
      },
      publishOptions: {
        license_preset: "commercial-use",
        rights_basis: "original",
      },
      status: "pending",
      createdAt: "2026-07-05T00:00:00.000Z",
    })

    expect(statements).toHaveLength(1)
    expect(statements[0]?.sql).toContain("INSERT INTO post_publish_requests")
    expect(statements[0]?.sql).toContain("ON CONFLICT(community_id, post_id) DO NOTHING")
    expect(statements[0]?.sql.toUpperCase()).not.toContain("SELECT")
    expect(JSON.parse(String(statements[0]?.args?.[5]))).toMatchObject({
      price_cents: 499,
      donation_partner: "don_1",
    })
    expect(JSON.parse(String(statements[0]?.args?.[6]))).toMatchObject({
      license_preset: "commercial-use",
      rights_basis: "original",
    })
  })

  test("reads and updates request status", async () => {
    const row = {
      post_publish_request_id: "ppr_1",
      community_id: "cmt_1",
      post_id: "pst_1",
      publish_mode: "async",
      request_body_hash: "0xabc",
      listing_draft_json: "{\"price_cents\":499}",
      publish_options_json: "{\"license_preset\":\"commercial-use\"}",
      status: "failed",
      failure_code: "provider_unavailable",
      failure_message: "try later",
      created_at: "2026-07-05T00:00:00.000Z",
      updated_at: "2026-07-05T00:01:00.000Z",
    }
    const { executor, statements } = makeExecutor([row])

    await expect(getPostPublishRequest({
      client: executor,
      communityId: "cmt_1",
      postId: "pst_1",
    })).resolves.toMatchObject({
      post_publish_request_id: "ppr_1",
      status: "failed",
      failure_code: "provider_unavailable",
    })

    await markPostPublishRequestStatus({
      client: executor,
      communityId: "cmt_1",
      postId: "pst_1",
      status: "running",
      updatedAt: "2026-07-05T00:02:00.000Z",
    })

    expect(statements.at(-1)?.sql).toContain("UPDATE post_publish_requests")
    expect(statements.at(-1)?.args).toEqual([
      "cmt_1",
      "pst_1",
      "running",
      null,
      null,
      "2026-07-05T00:02:00.000Z",
    ])
  })
})
