import { expect, test } from "bun:test"
import type { Env } from "../../env"
import {
  listConfiguredCommunityShards,
  resolveCommunityAllocationShard,
  resolveCommunityShardRpc,
} from "./community-shard-registry"

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

test("enumerates configured pools in stable worker-id order", () => {
  expect(listConfiguredCommunityShards(env()).map((entry) => ({
    shardWorkerId: entry.shardWorkerId,
    bindingName: entry.bindingName,
  }))).toEqual([
    { shardWorkerId: "community-d1-shard-staging", bindingName: "COMMUNITY_D1_SHARD" },
    { shardWorkerId: "community-d1-shard-staging-2", bindingName: "COMMUNITY_D1_SHARD_SECONDARY" },
  ])
})

test("requires an explicit allocation pool when multiple pools are configured", () => {
  expect(() => resolveCommunityAllocationShard(env())).toThrow(
    expect.objectContaining({ code: "d1_allocation_shard_ambiguous", retryable: false }),
  )

  const configured = env()
  configured.COMMUNITY_D1_ALLOCATION_SHARD_WORKER_ID = "community-d1-shard-staging-2"
  expect(resolveCommunityAllocationShard(configured)).toEqual({
    shardWorkerId: "community-d1-shard-staging-2",
    bindingName: "COMMUNITY_D1_SHARD_SECONDARY",
    shard: secondary,
  })
})

test("uses the sole configured route for allocation without a selector", () => {
  const configured = env()
  configured.COMMUNITY_D1_SHARD_ROUTES = JSON.stringify({
    "community-d1-shard-staging": "COMMUNITY_D1_SHARD",
  })
  expect(resolveCommunityAllocationShard(configured).shard).toBe(primary)
})

test("fails closed when the allocation selector names an unknown pool", () => {
  const configured = env()
  configured.COMMUNITY_D1_ALLOCATION_SHARD_WORKER_ID = "community-d1-shard-missing"
  expect(() => resolveCommunityAllocationShard(configured)).toThrow(
    expect.objectContaining({ code: "d1_allocation_shard_not_configured", retryable: false }),
  )
})
