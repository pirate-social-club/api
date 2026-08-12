#!/usr/bin/env bun

import { isPostgresControlPlaneUrl, withStandaloneControlPlaneClient } from "../../src/lib/runtime-deps"
import type { Env } from "../../src/env"
import { archiveRehearsalFixtureCampaign } from "./archive-fixture"

function campaignIds(): string[] {
  const ids = process.argv.flatMap((value, index, args) => (
    value === "--campaign-id" && args[index + 1] ? [args[index + 1] as string] : []
  ))
  if (ids.length === 0 || new Set(ids).size !== ids.length) {
    throw new Error("fixture_archive_requires_unique_campaign_ids")
  }
  return ids
}

if (String(process.env.ENVIRONMENT ?? "").trim().toLowerCase() !== "staging") {
  throw new Error("refusing_to_archive_reward_fixtures_outside_staging")
}
const databaseUrl = String(process.env.CONTROL_PLANE_MIGRATOR_DATABASE_URL ?? "").trim()
if (!isPostgresControlPlaneUrl(databaseUrl)) {
  throw new Error("CONTROL_PLANE_MIGRATOR_DATABASE_URL_must_be_postgres")
}
const apply = process.argv.includes("--apply")
if (apply && process.env.STAGING_REWARD_FIXTURE_ARCHIVE_CONFIRMED !== "true") {
  throw new Error("fixture_archive_apply_requires_confirmation")
}
const env = {
  ...process.env,
  CONTROL_PLANE_DATABASE_URL: databaseUrl,
} as unknown as Env

const results = await withStandaloneControlPlaneClient(env, async (client) => {
  const archived = []
  for (const campaignId of campaignIds()) {
    archived.push(await archiveRehearsalFixtureCampaign({ client, campaignId, apply }))
  }
  return archived
})
console.log(JSON.stringify({ apply, results }, null, 2))
