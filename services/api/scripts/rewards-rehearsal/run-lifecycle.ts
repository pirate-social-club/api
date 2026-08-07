#!/usr/bin/env bun

import { chmodSync, writeFileSync } from "node:fs"
import { resolve } from "node:path"

import type { Env } from "../../src/env"

type Options = {
  campaignId: string
  userId: string
  output: string
  now: string
  passes: number
  cashoutCents: number | null
  apiOrigin: string
  operatorToken: string
  accessToken: string | null
}

function required(name: string, argv: string[]): string {
  const index = argv.indexOf(`--${name}`)
  const value = index >= 0 ? argv[index + 1]?.trim() : ""
  if (!value) throw new Error(`missing_${name.replaceAll("-", "_")}`)
  return value
}

function optional(name: string, argv: string[]): string | null {
  const index = argv.indexOf(`--${name}`)
  return index >= 0 ? argv[index + 1]?.trim() || null : null
}

function positive(value: string, field: string): number {
  const parsed = Number(value)
  if (!Number.isSafeInteger(parsed) || parsed <= 0) throw new Error(`${field}_must_be_positive_integer`)
  return parsed
}

function parseOptions(argv: string[]): Options {
  const cashoutRaw = optional("cashout-cents", argv)
  const accessToken = optional("access-token", argv) ?? process.env.REWARDS_REHEARSAL_ACCESS_TOKEN?.trim() ?? null
  const apiOrigin = optional("api-origin", argv) ?? process.env.REWARDS_REHEARSAL_API_ORIGIN?.trim() ?? ""
  const operatorToken = optional("operator-token", argv) ?? process.env.REWARDS_REHEARSAL_OPERATOR_TOKEN?.trim() ?? ""
  if (!apiOrigin || !operatorToken) throw new Error("api_origin_and_operator_token_are_required")
  if (cashoutRaw && !accessToken) {
    throw new Error("cashout_requires_api_origin_and_access_token")
  }
  const now = optional("now", argv) ?? new Date().toISOString()
  if (!Number.isFinite(Date.parse(now))) throw new Error("now_must_be_iso_timestamp")
  return {
    campaignId: required("campaign-id", argv),
    userId: required("user-id", argv),
    output: resolve(required("output", argv)),
    now,
    passes: positive(optional("passes", argv) ?? "3", "passes"),
    cashoutCents: cashoutRaw === null ? null : positive(cashoutRaw, "cashout_cents"),
    apiOrigin,
    operatorToken,
    accessToken,
  }
}

function assertStaging(env: Env): void {
  if (String(env.ENVIRONMENT ?? "").trim().toLowerCase() !== "staging") {
    throw new Error("refusing_reward_lifecycle_rehearsal_outside_staging")
  }
}

function assertStagingOrigin(origin: string): void {
  const hostname = new URL(origin).hostname.toLowerCase()
  if (
    hostname !== "api-staging.pirate.sc"
    && !hostname.endsWith(".staging.pirate.sc")
    && hostname !== "localhost"
    && hostname !== "127.0.0.1"
  ) {
    throw new Error("refusing_reward_lifecycle_rehearsal_against_non_staging_api")
  }
}

async function requestLifecycle(input: {
  origin: string
  operatorToken: string
  campaignId: string
  userId: string
  passes: number
}): Promise<Record<string, unknown>> {
  const response = await fetch(new URL("/operator/reward_campaigns/rehearsal", input.origin), {
    method: "POST",
    headers: {
      accept: "application/json",
      authorization: input.operatorToken.startsWith("Operator ") ? input.operatorToken : `Operator ${input.operatorToken}`,
      "content-type": "application/json",
    },
    body: JSON.stringify({
      campaign_id: input.campaignId,
      user_id: input.userId,
      passes: input.passes,
    }),
  })
  const text = await response.text()
  const body = text.trim() ? JSON.parse(text) as Record<string, unknown> : {}
  if (response.status !== 200) throw new Error(`lifecycle_rehearsal_failed_${response.status}: ${text}`)
  return body
}

async function requestCashout(input: {
  origin: string
  accessToken: string
  amountCents: number
  idempotencyKey: string
}): Promise<{ status: number; payoutId: string | null; body: unknown }> {
  const response = await fetch(new URL("/me/rewards/cashouts", input.origin), {
    method: "POST",
    headers: {
      accept: "application/json",
      authorization: `Bearer ${input.accessToken}`,
      "content-type": "application/json",
    },
    body: JSON.stringify({ amount_cents: input.amountCents, idempotency_key: input.idempotencyKey }),
  })
  const text = await response.text()
  const body = text.trim() ? JSON.parse(text) as Record<string, unknown> : null
  if (response.status !== 202) throw new Error(`cashout_failed_${response.status}: ${text}`)
  const payout = body?.payout
  return {
    status: response.status,
    payoutId: payout && typeof payout === "object" && typeof (payout as Record<string, unknown>).id === "string"
      ? (payout as Record<string, unknown>).id as string
      : null,
    body,
  }
}

async function main(): Promise<void> {
  const options = parseOptions(process.argv.slice(2))
  const env = { ...process.env } as unknown as Env
  assertStaging(env)
  assertStagingOrigin(options.apiOrigin)
  const lifecycle = await requestLifecycle({
    origin: options.apiOrigin,
    operatorToken: options.operatorToken,
    campaignId: options.campaignId,
    userId: options.userId,
    passes: options.passes,
  })
  let cashout: { first: unknown; replay: unknown } | null = null
  if (options.cashoutCents !== null) {
    const idempotencyKey = `rewards-lifecycle-rehearsal:${options.campaignId}:${options.now}`
    const firstCashout = await requestCashout({
      origin: options.apiOrigin,
      accessToken: options.accessToken as string,
      amountCents: options.cashoutCents,
      idempotencyKey,
    })
    const replayCashout = await requestCashout({
      origin: options.apiOrigin,
      accessToken: options.accessToken as string,
      amountCents: options.cashoutCents,
      idempotencyKey,
    })
    if (firstCashout.payoutId !== replayCashout.payoutId) throw new Error("cashout_replay_changed_payout")
    cashout = { first: firstCashout, replay: replayCashout }
  }

  const report = {
    version: 1,
    purpose: "rewards_lifecycle_rehearsal",
    campaign_id: options.campaignId,
    user_id: options.userId,
    now: options.now,
    lifecycle,
    cashout,
  }
  writeFileSync(options.output, `${JSON.stringify(report, null, 2)}\n`, { flag: "wx", mode: 0o600 })
  chmodSync(options.output, 0o600)
  console.log(`rewards_lifecycle_rehearsal_passed campaign_id=${options.campaignId}`)
  console.log(`snapshot=${options.output}`)
}

await main()
