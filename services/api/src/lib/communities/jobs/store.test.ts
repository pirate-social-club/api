import { describe, expect, test } from "bun:test"
import { enqueueCommunityJob } from "./store"

type Statement = { sql: string; args?: unknown[] }

function makeExecutor(input: { rowsAffected?: number } = {}) {
  const statements: Statement[] = []
  return {
    statements,
    executor: {
      async execute(statement: Statement | string) {
        const normalized = typeof statement === "string" ? { sql: statement, args: [] } : statement
        statements.push(normalized)
        return { rows: [], rowsAffected: input.rowsAffected ?? 1 }
      },
    },
  }
}

describe("enqueueCommunityJob", () => {
  test("dedupe:false performs only an INSERT OR IGNORE write", async () => {
    const { executor, statements } = makeExecutor()

    const job = await enqueueCommunityJob({
      client: executor,
      communityId: "cmt_1",
      jobType: "post_publish_finalize",
      subjectType: "post",
      subjectId: "pst_1",
      payloadJson: "{\"post_id\":\"pst_1\"}",
      createdAt: "2026-07-05T00:00:00.000Z",
      dedupe: false,
    })

    expect(job.subject_id).toBe("pst_1")
    expect(statements).toHaveLength(1)
    expect(statements[0]?.sql).toContain("INSERT OR IGNORE INTO community_jobs")
    expect(statements[0]?.sql.toUpperCase()).not.toContain("SELECT")
  })
})
