#!/usr/bin/env bun

import { createHash, randomBytes } from "node:crypto"
import { chmodSync, writeFileSync } from "node:fs"
import { SQL } from "bun"

export const BOOKING_SETTLEMENT_RESOLVE_SCOPE = "bookings:settlement:resolve"
export const REWARD_CAMPAIGN_INCIDENT_RESOLVE_SCOPE = "rewards:campaign-incidents:resolve"
export const STORY_SETTLEMENT_REPAIR_SCOPE = "story:settlement:repair"
export const STORY_SETTLEMENT_FEE_REPLACE_SCOPE = "story:settlement:fee-replace"

export const ALLOWED_SCOPES = new Set([
  BOOKING_SETTLEMENT_RESOLVE_SCOPE,
  REWARD_CAMPAIGN_INCIDENT_RESOLVE_SCOPE,
  STORY_SETTLEMENT_REPAIR_SCOPE,
  STORY_SETTLEMENT_FEE_REPLACE_SCOPE,
])

export function normalizeOperatorDatabaseUrl(value: string): string {
  const url = new URL(value)
  url.searchParams.delete("sslrootcert")
  return url.toString()
}

const BOOKING_CREDENTIAL_ENV_NAME = "PIRATE_BOOKING_SETTLEMENT_OPERATOR_CREDENTIAL"
const REWARD_CREDENTIAL_ENV_NAME = "PIRATE_REWARD_CAMPAIGN_OPERATOR_CREDENTIAL"
const STORY_SETTLEMENT_CREDENTIAL_ENV_NAME = "PIRATE_STORY_SETTLEMENT_OPERATOR_CREDENTIAL"
const STORY_SETTLEMENT_FEE_REPLACE_CREDENTIAL_ENV_NAME = "PIRATE_STORY_SETTLEMENT_FEE_REPLACE_OPERATOR_CREDENTIAL"

type Mode = "issue" | "rotate" | "revoke"

type Options = {
  mode: Mode
  databaseUrlEnv: string
  operatorActorId: string
  label: string
  scopes: string[]
  expiresAt: string
  credentialId: string | null
  rotateCredentialId: string | null
  revokeCredentialId: string | null
  credentialEnvFile: string | null
  credentialEnvName: string
}

function usage(exitCode = 1): never {
  console.error(`Usage:
  bun scripts/operator-credentials.ts issue --operator-actor-id svc_... --label "Name" --scope bookings:settlement:resolve --expires-at 2026-07-31T00:00:00Z
  bun scripts/operator-credentials.ts issue --operator-actor-id svc_... --label "Name" --scope rewards:campaign-incidents:resolve --expires-at 2026-08-14T00:00:00Z
  bun scripts/operator-credentials.ts issue --operator-actor-id svc_... --label "Name" --scope story:settlement:repair --expires-at 2026-08-14T00:00:00Z
  bun scripts/operator-credentials.ts rotate --credential-id opc_... --operator-actor-id svc_... --label "Name" --scope rewards:campaign-incidents:resolve --expires-at 2026-08-14T00:00:00Z
  bun scripts/operator-credentials.ts revoke --credential-id opc_...

Uses CONTROL_PLANE_MIGRATOR_DATABASE_URL by default. This is operator tooling only; never expose
issuance, rotation, or revocation through the public API runtime.

Use --credential-env-file /path/to/file with issue/rotate to write the credential
without printing the secret. The variable name defaults from the single scope:
${BOOKING_CREDENTIAL_ENV_NAME} or ${REWARD_CREDENTIAL_ENV_NAME}.
Use --credential-env-name NAME to override it; multi-scope credentials require an explicit name.`)
  process.exit(exitCode)
}

function readValue(argv: string[], index: number, flag: string): string {
  const value = argv[index + 1]?.trim()
  if (!value) {
    console.error(`${flag} requires a value`)
    usage()
  }
  return value
}

export function credentialEnvNameForScopes(scopes: string[], explicitName = ""): string {
  const normalizedName = explicitName.trim()
  if (normalizedName && !/^[A-Z][A-Z0-9_]*$/.test(normalizedName)) {
    throw new Error("--credential-env-name must be an uppercase environment variable name")
  }
  const uniqueScopes = Array.from(new Set(scopes))
  if (normalizedName) return normalizedName
  if (uniqueScopes.length === 1 && uniqueScopes[0] === BOOKING_SETTLEMENT_RESOLVE_SCOPE) {
    return BOOKING_CREDENTIAL_ENV_NAME
  }
  if (uniqueScopes.length === 1 && uniqueScopes[0] === REWARD_CAMPAIGN_INCIDENT_RESOLVE_SCOPE) {
    return REWARD_CREDENTIAL_ENV_NAME
  }
  if (uniqueScopes.length === 1 && uniqueScopes[0] === STORY_SETTLEMENT_REPAIR_SCOPE) {
    return STORY_SETTLEMENT_CREDENTIAL_ENV_NAME
  }
  if (uniqueScopes.length === 1 && uniqueScopes[0] === STORY_SETTLEMENT_FEE_REPLACE_SCOPE) {
    return STORY_SETTLEMENT_FEE_REPLACE_CREDENTIAL_ENV_NAME
  }
  throw new Error("multi-scope credentials require --credential-env-name")
}

function parseArgs(argv: string[]): Options {
  if (argv.includes("-h") || argv.includes("--help")) {
    usage(0)
  }

  const mode = argv[0] as Mode | undefined
  if (!mode || !["issue", "rotate", "revoke"].includes(mode)) {
    usage()
  }

  let databaseUrlEnv = "CONTROL_PLANE_MIGRATOR_DATABASE_URL"
  let operatorActorId = ""
  let label = ""
  const scopes: string[] = []
  let expiresAt = ""
  let credentialId: string | null = null
  let credentialEnvFile: string | null = null
  let credentialEnvName = ""

  for (let index = 1; index < argv.length;) {
    const arg = argv[index]
    switch (arg) {
      case "--database-url-env":
        databaseUrlEnv = readValue(argv, index, arg)
        index += 2
        break
      case "--operator-actor-id":
        operatorActorId = readValue(argv, index, arg)
        index += 2
        break
      case "--label":
        label = readValue(argv, index, arg)
        index += 2
        break
      case "--scope":
        scopes.push(readValue(argv, index, arg))
        index += 2
        break
      case "--expires-at":
        expiresAt = readValue(argv, index, arg)
        index += 2
        break
      case "--credential-id":
        credentialId = readValue(argv, index, arg)
        index += 2
        break
      case "--credential-env-file":
        credentialEnvFile = readValue(argv, index, arg)
        index += 2
        break
      case "--credential-env-name":
        credentialEnvName = readValue(argv, index, arg)
        index += 2
        break
      default:
        console.error(`unknown argument: ${arg}`)
        usage()
    }
  }

  if ((mode === "rotate" || mode === "revoke") && !credentialId) {
    console.error(`${mode} requires --credential-id`)
    usage()
  }
  if (mode !== "revoke") {
    if (!operatorActorId || !label || !expiresAt || scopes.length === 0) {
      console.error(`${mode} requires --operator-actor-id, --label, --scope, and --expires-at`)
      usage()
    }
    for (const scope of scopes) {
      if (!ALLOWED_SCOPES.has(scope)) {
        console.error(`unsupported operator scope: ${scope}`)
        usage()
      }
    }
    if (!Number.isFinite(Date.parse(expiresAt))) {
      console.error("--expires-at must be an ISO timestamp")
      usage()
    }
    try {
      credentialEnvName = credentialEnvNameForScopes(scopes, credentialEnvName)
    } catch (error) {
      console.error(error instanceof Error ? error.message : String(error))
      usage()
    }
  }

  return {
    mode,
    databaseUrlEnv,
    operatorActorId,
    label,
    scopes: Array.from(new Set(scopes)),
    expiresAt,
    credentialId: null,
    rotateCredentialId: mode === "rotate" ? credentialId : null,
    revokeCredentialId: mode === "revoke" ? credentialId : null,
    credentialEnvFile,
    credentialEnvName,
  }
}

function makeCredentialId(): string {
  return `opc_${randomBytes(16).toString("hex")}`
}

function makeSecret(): string {
  return randomBytes(32).toString("base64url")
}

function hashSecret(secret: string): string {
  return createHash("sha256").update(secret).digest("hex")
}

function writeCredentialEnvFile(path: string, envName: string, credential: string): void {
  writeFileSync(path, `${envName}=${credential}\n`, { mode: 0o600 })
  chmodSync(path, 0o600)
}

function printIssuedCredential(created: { id: string; secret: string }, options: Options): void {
  console.log(`operator_credential_id=${created.id}`)
  if (options.credentialEnvFile) {
    writeCredentialEnvFile(options.credentialEnvFile, options.credentialEnvName, `${created.id}.${created.secret}`)
    console.log(`operator_credential_env_file=${options.credentialEnvFile}`)
    console.log(`operator_credential_env_name=${options.credentialEnvName}`)
    return
  }
  console.log(`operator_credential=${created.id}.${created.secret}`)
}

async function issue(sql: SQL, options: Options): Promise<{ id: string; secret: string }> {
  const id = makeCredentialId()
  const secret = makeSecret()
  const now = new Date().toISOString()
  await sql`
    INSERT INTO operator_credentials (
      operator_credential_id, operator_actor_id, label, secret_hash, secret_hash_algo,
      secret_hash_version, scopes_json, status, created_at, expires_at
    ) VALUES (
      ${id}, ${options.operatorActorId}, ${options.label}, ${hashSecret(secret)}, 'sha256',
      1, ${JSON.stringify(options.scopes)}, 'active', ${now}, ${options.expiresAt}
    )
  `
  return { id, secret }
}

async function rotate(sql: SQL, options: Options): Promise<{ id: string; secret: string }> {
  if (!options.rotateCredentialId) throw new Error("missing rotate credential id")
  const now = new Date().toISOString()
  return await sql.begin(async (tx) => {
    const next = await issue(tx as unknown as SQL, options)
    const updated = await tx`
      UPDATE operator_credentials
      SET status = 'revoked',
          revoked_at = ${now},
          rotated_at = ${now},
          superseded_by_credential_id = ${next.id}
      WHERE operator_credential_id = ${options.rotateCredentialId}
        AND status = 'active'
      RETURNING operator_credential_id
    `
    if (updated.length !== 1) {
      throw new Error("credential_to_rotate_not_active")
    }
    return next
  })
}

async function revoke(sql: SQL, options: Options): Promise<void> {
  if (!options.revokeCredentialId) throw new Error("missing revoke credential id")
  const now = new Date().toISOString()
  const updated = await sql`
    UPDATE operator_credentials
    SET status = 'revoked', revoked_at = ${now}
    WHERE operator_credential_id = ${options.revokeCredentialId}
      AND status = 'active'
    RETURNING operator_credential_id
  `
  if (updated.length !== 1) {
    throw new Error("credential_to_revoke_not_active")
  }
}

async function main(): Promise<void> {
  const options = parseArgs(process.argv.slice(2))
  const databaseUrl = process.env[options.databaseUrlEnv]?.trim()
  if (!databaseUrl) {
    console.error(`missing ${options.databaseUrlEnv}`)
    process.exit(1)
  }

  const sql = new SQL({ url: normalizeOperatorDatabaseUrl(databaseUrl), max: 1 })
  try {
    if (options.mode === "issue") {
      const created = await issue(sql, options)
      printIssuedCredential(created, options)
    } else if (options.mode === "rotate") {
      const created = await rotate(sql, options)
      printIssuedCredential(created, options)
    } else {
      await revoke(sql, options)
      console.log("operator_credential_revoked=true")
    }
  } finally {
    await sql.end()
  }
}

if (import.meta.main) {
  await main()
}
