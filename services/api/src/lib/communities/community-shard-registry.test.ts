import { expect, test } from "bun:test"
import type { Env } from "../../env"
import { resolveCommunityShardRpc } from "./community-shard-registry"

const primary = { execute: async () => ({ ok: true, value: { rows: [] } }) }
const secondary = { execute: async () => ({ ok: true, value: { rows: [] } }) }

function env(): Env {
  return {
    COMMUNITY_D1_SHARD: primary,
    COMMUNITY_D1_SHARD_SECONDARY: secondary,
    COMMUNITY_D1_SHARD_ROUTES: JSON.stringify({
      "community-d1-shard-staging": "COMMUNITY_D1_SHARD",
      "community-d1-shard-staging-2": "COMMUNITY_D1_SHARD_SECONDARY",
    }),
  } as unknown as Env
}

test("dispatches each persisted shard_worker_id to its configured service binding", () => {
  expect(resolveCommunityShardRpc(env(), "community-d1-shard-staging")).toBe(primary)
  expect(resolveCommunityShardRpc(env(), "community-d1-shard-staging-2")).toBe(secondary)
})

test("fails closed instead of falling back to the primary shard Worker", () => {
  expect(() => resolveCommunityShardRpc(env(), "community-d1-shard-unknown")).toThrow(
    expect.objectContaining({ code: "d1_shard_worker_not_configured", retryable: false }),
  )
})

test("fails closed when the configured service binding is absent", () => {
  const missing = env()
  missing.COMMUNITY_D1_SHARD_ROUTES = JSON.stringify({
    "community-d1-shard-staging-2": "COMMUNITY_D1_SHARD_MISSING",
  })
  expect(() => resolveCommunityShardRpc(missing, "community-d1-shard-staging-2")).toThrow(
    expect.objectContaining({ code: "d1_shard_binding_not_configured", retryable: false }),
  )
})

test("rejects missing worker ids and malformed registries", () => {
  expect(() => resolveCommunityShardRpc(env(), null)).toThrow(
    expect.objectContaining({ code: "d1_shard_worker_missing" }),
  )
  const malformed = env()
  malformed.COMMUNITY_D1_SHARD_ROUTES = "[]"
  expect(() => resolveCommunityShardRpc(malformed, "community-d1-shard-staging")).toThrow(
    expect.objectContaining({ code: "d1_shard_registry_invalid" }),
  )
})
