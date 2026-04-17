import { neon } from "@neondatabase/serverless"
import { globalSingleton } from "../db-helpers"
import { assembleProfile } from "./control-plane-auth-serializers"
import {
  toGlobalHandleRow,
  toLinkedHandleRow,
  toProfileRow,
} from "./control-plane-auth-rows"
import type { Env } from "../../types"
import type { PublicProfileResolution } from "./repositories"

type QueryRow = Record<string, unknown>
type PostgresQuery = <T extends QueryRow = QueryRow>(sql: string, params?: unknown[]) => Promise<T[]>

function normalizePublicHandleLabel(value: string): {
  labelDisplay: string
  labelNormalized: string
} {
  const trimmed = value.trim().toLowerCase().replace(/^@+/u, "")
  const withoutSuffix = trimmed.endsWith(".pirate")
    ? trimmed.slice(0, -".pirate".length)
    : trimmed

  return {
    labelDisplay: `${withoutSuffix}.pirate`,
    labelNormalized: withoutSuffix,
  }
}

export function isPostgresControlPlaneUrl(value: string | null | undefined): boolean {
  const trimmed = String(value || "").trim().toLowerCase()
  return trimmed.startsWith("postgres://") || trimmed.startsWith("postgresql://")
}

function requireControlPlanePostgresUrl(env: Env): string {
  const url = String(env.CONTROL_PLANE_DATABASE_URL || env.TURSO_CONTROL_PLANE_DATABASE_URL || "").trim()
  return url
}

function getPostgresQuery(env: Env): PostgresQuery {
  const url = requireControlPlanePostgresUrl(env)
  return globalSingleton("controlPlanePublicProfilePostgres", url, () => {
    const sql = neon(url)
    return async <T extends QueryRow = QueryRow>(text: string, params?: unknown[]) => {
      const rows = await sql.query(text, params ?? [])
      return rows as T[]
    }
  })
}

export async function resolvePublicProfileByHandleFromPostgres(input: {
  env: Env
  handleLabel: string
  query?: PostgresQuery
}): Promise<PublicProfileResolution | null> {
  const requestedHandle = normalizePublicHandleLabel(input.handleLabel)
  const query = input.query ?? getPostgresQuery(input.env)

  const requestedHandleRows = await query(`
    SELECT
      global_handle_id,
      user_id,
      label_normalized,
      label_display,
      status,
      tier,
      issuance_source,
      redirect_target_global_handle_id,
      price_paid_usd,
      free_rename_consumed,
      issued_at,
      replaced_at,
      created_at,
      updated_at
    FROM global_handles
    WHERE label_normalized = $1
    ORDER BY
      CASE status
        WHEN 'active' THEN 0
        WHEN 'redirect' THEN 1
        ELSE 2
      END,
      updated_at DESC
    LIMIT 1
  `, [requestedHandle.labelNormalized])
  const requestedHandleRaw = requestedHandleRows[0]
  if (!requestedHandleRaw) {
    return null
  }

  const requestedHandleRow = toGlobalHandleRow(requestedHandleRaw)
  const canonicalHandleRows = requestedHandleRow.status === "redirect" && requestedHandleRow.redirect_target_global_handle_id
    ? await query(`
      SELECT
        global_handle_id,
        user_id,
        label_normalized,
        label_display,
        status,
        tier,
        issuance_source,
        redirect_target_global_handle_id,
        price_paid_usd,
        free_rename_consumed,
        issued_at,
        replaced_at,
        created_at,
        updated_at
      FROM global_handles
      WHERE global_handle_id = $1
      LIMIT 1
    `, [requestedHandleRow.redirect_target_global_handle_id])
    : [requestedHandleRaw]
  const canonicalHandleRaw = canonicalHandleRows[0]
  if (!canonicalHandleRaw) {
    return null
  }

  const canonicalHandleRow = toGlobalHandleRow(canonicalHandleRaw)
  const profileRows = await query(`
    SELECT
      user_id,
      display_name,
      bio,
      avatar_ref,
      cover_ref,
      preferred_locale,
      global_handle_id,
      primary_linked_handle_id,
      created_at,
      updated_at
    FROM profiles
    WHERE user_id = $1
    LIMIT 1
  `, [canonicalHandleRow.user_id])
  const profileRaw = profileRows[0]
  if (!profileRaw) {
    return null
  }

  const linkedHandleRows = await query(`
    SELECT
      linked_handle_id,
      user_id,
      wallet_attachment_id,
      kind,
      label_normalized,
      label_display,
      verification_state,
      metadata_json,
      created_at,
      updated_at
    FROM linked_handles
    WHERE user_id = $1
    ORDER BY created_at ASC
  `, [canonicalHandleRow.user_id])

  return {
    profile: assembleProfile(
      toProfileRow(profileRaw),
      canonicalHandleRow,
      linkedHandleRows.map((row) => toLinkedHandleRow(row)),
    ),
    requested_handle_label: requestedHandle.labelDisplay,
    resolved_handle_label: canonicalHandleRow.label_display,
    is_canonical: requestedHandleRow.global_handle_id === canonicalHandleRow.global_handle_id,
  }
}
