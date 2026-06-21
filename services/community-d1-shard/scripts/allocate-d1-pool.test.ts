import { describe, expect, test } from "bun:test"
import {
  allocateD1Pool,
  buildPoolInsertSql,
  buildWranglerD1Entry,
  parseD1CreateDatabaseId,
  planPoolBindings,
  poolBindingName,
  poolDatabaseName,
} from "./allocate-d1-pool"

describe("naming", () => {
  test("zero-pads binding + database names", () => {
    expect(poolBindingName(1)).toBe("DB_CMTY_0001")
    expect(poolBindingName(42)).toBe("DB_CMTY_0042")
    expect(poolDatabaseName(7)).toBe("community-d1-pool-0007-staging")
  })
})

describe("planPoolBindings", () => {
  test("plans contiguous slots from startIndex", () => {
    expect(planPoolBindings(3, 2)).toEqual([
      { index: 3, bindingName: "DB_CMTY_0003", databaseName: "community-d1-pool-0003-staging" },
      { index: 4, bindingName: "DB_CMTY_0004", databaseName: "community-d1-pool-0004-staging" },
    ])
  })

  test("rejects invalid args", () => {
    expect(() => planPoolBindings(0, 1)).toThrow(/startIndex/)
    expect(() => planPoolBindings(1, 0)).toThrow(/count/)
  })
})

describe("parseD1CreateDatabaseId", () => {
  test("extracts the database_id field from wrangler output", () => {
    const out = `
      ✅ Successfully created DB 'community-d1-pool-0001-staging'
      {
        "d1_databases": [
          { "binding": "DB", "database_name": "x", "database_id": "d7d47bef-ffcd-4744-842d-c11b60c52dd8" }
        ]
      }`
    expect(parseD1CreateDatabaseId(out)).toBe("d7d47bef-ffcd-4744-842d-c11b60c52dd8")
  })

  test("throws when no id is present", () => {
    expect(() => parseD1CreateDatabaseId("no uuid here")).toThrow(/could not parse/)
  })
})

describe("config + sql construction", () => {
  test("buildWranglerD1Entry shapes a d1_databases entry", () => {
    const entry = buildWranglerD1Entry(
      { index: 1, bindingName: "DB_CMTY_0001", databaseName: "community-d1-pool-0001-staging" },
      "uuid-1",
    )
    expect(entry).toEqual({
      binding: "DB_CMTY_0001",
      database_name: "community-d1-pool-0001-staging",
      database_id: "uuid-1",
    })
  })

  test("buildPoolInsertSql inserts FREE rows (community_id NULL) idempotently", () => {
    const sql = buildPoolInsertSql(["DB_CMTY_0001", "DB_CMTY_0002"])
    expect(sql).toBe(
      "INSERT OR IGNORE INTO d1_pool (binding_name, community_id, version) VALUES ('DB_CMTY_0001', NULL, 0), ('DB_CMTY_0002', NULL, 0);",
    )
  })
})

describe("allocateD1Pool orchestration", () => {
  test("creates each D1 and returns entries + insert SQL (create is the only side effect)", async () => {
    const createdNames: string[] = []
    const result = await allocateD1Pool({
      count: 2,
      startIndex: 5,
      runWranglerCreate: async (databaseName) => {
        createdNames.push(databaseName)
        const idx = databaseName.match(/(\d{4})/)![1]
        return `{ "database_id": "0000000${idx[3]}-1111-2222-3333-444444444444" }`
      },
      log: () => {},
    })

    // Phase 1 created exactly the planned databases.
    expect(createdNames).toEqual(["community-d1-pool-0005-staging", "community-d1-pool-0006-staging"])
    expect(result.created.map((c) => c.binding)).toEqual(["DB_CMTY_0005", "DB_CMTY_0006"])
    expect(result.created[0].database_id).toMatch(/^0000000/)
    expect(result.poolInsertSql).toContain("('DB_CMTY_0005', NULL, 0)")
    expect(result.poolInsertSql).toContain("('DB_CMTY_0006', NULL, 0)")
  })
})
