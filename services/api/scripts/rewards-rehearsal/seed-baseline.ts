#!/usr/bin/env bun

import { chmodSync, writeFileSync } from "node:fs"
import { resolve } from "node:path"

import type { Env } from "../../src/env"
import {
  isPostgresControlPlaneUrl,
  withStandaloneControlPlaneClient,
} from "../../src/lib/runtime-deps"
import { seedRehearsalBaselineFixture } from "./baseline-fixture"

function arg(name: string): string {
  const index = process.argv.indexOf(`--${name}`)
  const value = index >= 0 ? process.argv[index + 1]?.trim() : ""
  if (!value) throw new Error(`missing_${name.replaceAll("-", "_")}`)
  return value
}

if (String(process.env.ENVIRONMENT ?? "").trim().toLowerCase() !== "staging") {
  throw new Error("refusing_to_seed_rehearsal_baseline_outside_staging")
}
const databaseUrl = String(process.env.CONTROL_PLANE_MIGRATOR_DATABASE_URL ?? "").trim()
if (!isPostgresControlPlaneUrl(databaseUrl)) {
  throw new Error("CONTROL_PLANE_MIGRATOR_DATABASE_URL_must_be_postgres")
}
const amountCents = Number(arg("amount-cents"))
const output = resolve(arg("output"))
const env = {
  ...process.env,
  CONTROL_PLANE_DATABASE_URL: databaseUrl,
} as unknown as Env

await withStandaloneControlPlaneClient(env, async (client) => {
  const fixture = await seedRehearsalBaselineFixture({
    client,
    userId: arg("user-id"),
    sourceCampaignId: arg("source-campaign-id"),
    amountCents,
  })
  writeFileSync(output, `${JSON.stringify(fixture, null, 2)}\n`, { flag: "wx", mode: 0o600 })
  chmodSync(output, 0o600)
  console.log(`rehearsal_baseline_seeded campaign_id=${fixture.campaignId}`)
  console.log(`reward_event_id=${fixture.rewardEventId}`)
  console.log(`recipient=${fixture.recipientAddress}`)
  console.log(`snapshot=${output}`)
})
