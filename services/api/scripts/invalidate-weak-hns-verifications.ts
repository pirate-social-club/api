import { getControlPlaneClient, withRequestControlPlaneClients } from "../src/lib/runtime-deps"
import type { Env } from "../src/env"

type CandidateRow = {
  namespace_verification_id: string
  source_namespace_verification_session_id: string
  user_id: string
  normalized_root_label: string
  status: string
  observation_provider: string | null
  attached_community_count: number
}

function hasFlag(name: string): boolean {
  return process.argv.includes(name)
}

function readLimit(): number {
  const index = process.argv.indexOf("--limit")
  if (index === -1) return 50
  const value = Number(process.argv[index + 1])
  if (!Number.isInteger(value) || value < 1 || value > 500) {
    throw new Error("--limit must be an integer between 1 and 500")
  }
  return value
}

function requireEnv(): Env {
  const databaseUrl = String(process.env.CONTROL_PLANE_DATABASE_URL || "").trim()
  if (!databaseUrl) {
    throw new Error("CONTROL_PLANE_DATABASE_URL is required")
  }

  return {
    CONTROL_PLANE_DATABASE_URL: databaseUrl,
    ENVIRONMENT: process.env.ENVIRONMENT || "production",
  } as Env
}

async function main() {
  const execute = hasFlag("--execute")
  const confirmProduction = hasFlag("--confirm-production")
  const limit = readLimit()
  const env = requireEnv()

  if (execute && !confirmProduction) {
    throw new Error("--execute requires --confirm-production")
  }

  await withRequestControlPlaneClients(async () => {
    const client = getControlPlaneClient(env)
    const candidates = await client.execute({
      sql: `
        SELECT
          nv.namespace_verification_id,
          nv.source_namespace_verification_session_id,
          nv.user_id,
          nv.normalized_root_label,
          nv.status,
          nv.observation_provider,
          (
            SELECT COUNT(*)
            FROM communities AS c
            WHERE c.namespace_verification_id = nv.namespace_verification_id
          ) AS attached_community_count
        FROM namespace_verifications AS nv
        WHERE nv.family = 'hns'
          AND nv.status = 'verified'
          AND nv.observation_provider = 'powerdns_sqlite'
        ORDER BY nv.created_at ASC
        LIMIT ?1
      `,
      args: [limit],
    })

    const rows = candidates.rows as unknown as CandidateRow[]
    console.log(JSON.stringify({
      mode: execute ? "execute" : "dry-run",
      candidate_count: rows.length,
      candidates: rows,
    }, null, 2))

    if (!execute || rows.length === 0) {
      return
    }

    const result = await client.batch([
      {
        sql: `
          UPDATE communities
          SET namespace_verification_id = NULL,
              updated_at = ?1
          WHERE namespace_verification_id IN (
            SELECT namespace_verification_id
            FROM namespace_verifications
            WHERE family = 'hns'
              AND status = 'verified'
              AND observation_provider = 'powerdns_sqlite'
          )
        `,
        args: [new Date().toISOString()],
      },
      {
        sql: `
          UPDATE namespace_verification_sessions
          SET namespace_verification_id = NULL,
              status = 'dns_setup_required',
              challenge_kind = NULL,
              challenge_host = NULL,
              challenge_txt_value = NULL,
              challenge_expires_at = NULL,
              root_control_verified = 0,
              pirate_dns_authority_verified = 0,
              club_attach_allowed = 0,
              pirate_web_routing_allowed = 0,
              pirate_subdomain_issuance_allowed = 0,
              failure_reason = 'dns_delegation_not_confirmed',
              accepted_at = NULL,
              updated_at = ?1
          WHERE namespace_verification_session_id IN (
            SELECT source_namespace_verification_session_id
            FROM namespace_verifications
            WHERE family = 'hns'
              AND status = 'verified'
              AND observation_provider = 'powerdns_sqlite'
          )
        `,
        args: [new Date().toISOString()],
      },
      {
        sql: `
          UPDATE namespace_verifications
          SET status = 'stale',
              root_control_verified = 0,
              pirate_dns_authority_verified = 0,
              club_attach_allowed = 0,
              pirate_web_routing_allowed = 0,
              pirate_subdomain_issuance_allowed = 0,
              observation_provider = 'powerdns_sqlite_invalidated',
              updated_at = ?1
          WHERE family = 'hns'
            AND status = 'verified'
            AND observation_provider = 'powerdns_sqlite'
        `,
        args: [new Date().toISOString()],
      },
    ], "write")

    console.log(JSON.stringify({
      invalidated: true,
      communities_detached: result[0]?.rowsAffected ?? null,
      sessions_reset: result[1]?.rowsAffected ?? null,
      verifications_staled: result[2]?.rowsAffected ?? null,
    }, null, 2))
  })
}

main().catch((error) => {
  console.error(error)
  process.exit(1)
})
