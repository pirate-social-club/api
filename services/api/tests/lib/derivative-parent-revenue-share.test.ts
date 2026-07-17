import { afterEach, expect, test } from "bun:test"
import { createClient } from "@libsql/client"
import { mkdtemp, rm } from "node:fs/promises"
import { tmpdir } from "node:os"
import { join } from "node:path"
import type { Env } from "../../src/env"
import {
  assertDerivativeParentRevenueShare,
  excludeKnownZeroRevenueShareStoryParents,
} from "../../src/lib/communities/commerce/derivative-parent-revenue-share"
import { resetRuntimeCaches } from "../helpers"

const cleanupPaths: string[] = []

afterEach(async () => {
  resetRuntimeCaches()
  await Promise.all(cleanupPaths.splice(0).map((path) => rm(path, { recursive: true, force: true })))
})

async function zeroShareProjectionEnv(parentIpId: string): Promise<Env> {
  const root = await mkdtemp(join(tmpdir(), "pirate-zero-share-parent-"))
  cleanupPaths.push(root)
  const databasePath = join(root, "control-plane.db")
  const client = createClient({ url: `file:${databasePath}` })
  try {
    await client.execute(`
      CREATE TABLE story_registered_asset_projections (
        story_ip_id TEXT NOT NULL,
        story_license_terms_id TEXT,
        commercial_rev_share_pct INTEGER
      )
    `)
    await client.execute({
      sql: `INSERT INTO story_registered_asset_projections (story_ip_id, story_license_terms_id, commercial_rev_share_pct) VALUES (?1, '17', 0)`,
      args: [parentIpId],
    })
  } finally {
    client.close()
  }
  return { CONTROL_PLANE_DATABASE_URL: `file:${databasePath}` } as Env
}

test("rejects a direct Story ref to a known zero-share parent", async () => {
  const parentIpId = "0x1111111111111111111111111111111111111111"
  const env = await zeroShareProjectionEnv(parentIpId)
  const unusedShardClient = { execute: async () => { throw new Error("shard lookup should not run") } }

  await expect(assertDerivativeParentRevenueShare({
    env,
    client: unusedShardClient,
    communityId: "cmt_zero_share",
    upstreamAssetRefs: [`story:ip:${parentIpId}#licenseTermsId=17`],
  })).rejects.toThrow("positive commercial revenue share")

  await expect(assertDerivativeParentRevenueShare({
    env,
    client: unusedShardClient,
    communityId: "cmt_zero_share",
    upstreamAssetRefs: [`story:ip:${parentIpId}#licenseTermsId=18`],
  })).resolves.toBeUndefined()
})

test("filters known zero-share parents while preserving unknown historical parents", async () => {
  const zeroShareParentIpId = "0x2222222222222222222222222222222222222222"
  const unknownParentIpId = "0x3333333333333333333333333333333333333333"
  const env = await zeroShareProjectionEnv(zeroShareParentIpId)

  const payableParents = await excludeKnownZeroRevenueShareStoryParents({
    env,
    parentIpIds: [zeroShareParentIpId, unknownParentIpId],
  })
  expect(payableParents).toEqual([unknownParentIpId])
})
