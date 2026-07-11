import { describe, expect, test } from "bun:test"
import type { Env } from "../../env"
import { shouldUseLocalCommunityDb } from "./community-local-mode"

function env(overrides: Partial<Env>): Env {
  return overrides as Env
}

describe("shouldUseLocalCommunityDb", () => {
  test("selects file-backed storage only for explicit development and test environments", () => {
    expect(shouldUseLocalCommunityDb(env({ ENVIRONMENT: "development", LOCAL_COMMUNITY_DB_ROOT: "/tmp/dbs" }))).toBe(true)
    expect(shouldUseLocalCommunityDb(env({ ENVIRONMENT: "test", LOCAL_COMMUNITY_DB_ROOT: "/tmp/dbs" }))).toBe(true)
  })

  test("fails closed in staging, production, and unknown environments", () => {
    expect(shouldUseLocalCommunityDb(env({ ENVIRONMENT: "staging", LOCAL_COMMUNITY_DB_ROOT: "/tmp/dbs" }))).toBe(false)
    expect(shouldUseLocalCommunityDb(env({ ENVIRONMENT: "production", LOCAL_COMMUNITY_DB_ROOT: "/tmp/dbs" }))).toBe(false)
    expect(shouldUseLocalCommunityDb(env({ LOCAL_COMMUNITY_DB_ROOT: "/tmp/dbs" }))).toBe(false)
  })

  test("requires a configured root and refuses local storage when a D1 shard exists", () => {
    expect(shouldUseLocalCommunityDb(env({ ENVIRONMENT: "development" }))).toBe(false)
    expect(shouldUseLocalCommunityDb(env({ ENVIRONMENT: "test", LOCAL_COMMUNITY_DB_ROOT: "  " }))).toBe(false)
    expect(shouldUseLocalCommunityDb(env({
      ENVIRONMENT: "development",
      LOCAL_COMMUNITY_DB_ROOT: "/tmp/dbs",
      COMMUNITY_D1_SHARD: {} as Env["COMMUNITY_D1_SHARD"],
    }))).toBe(false)
  })
})
