import { describe, expect, test } from "bun:test"
import {
  isPostgresControlPlaneUrl,
  resolvePublicProfileByHandleFromPostgres,
} from "../src/lib/auth/control-plane-public-profile-postgres"
import type { Env } from "../src/types"

const baseEnv: Env = {
  CONTROL_PLANE_DATABASE_URL: "postgresql://pirate:secret@example.neon.tech/pirate",
}

describe("postgres public profile resolution", () => {
  test("detects postgres control-plane URLs", () => {
    expect(isPostgresControlPlaneUrl("postgresql://example.com/db")).toBe(true)
    expect(isPostgresControlPlaneUrl("postgres://example.com/db")).toBe(true)
    expect(isPostgresControlPlaneUrl("libsql://example.com")).toBe(false)
  })

  test("resolves a canonical public profile from postgres rows", async () => {
    const query = (async (sql: string, params?: unknown[]) => {
      if (sql.includes("FROM global_handles") && sql.includes("WHERE label_normalized = $1")) {
        expect(params).toEqual(["captainpublic"])
        return [{
          global_handle_id: "ghd_captain",
          user_id: "usr_captain",
          label_normalized: "captainpublic",
          label_display: "captainpublic.pirate",
          status: "active",
          tier: "standard",
          issuance_source: "free_cleanup_rename",
          redirect_target_global_handle_id: null,
          price_paid_usd: null,
          free_rename_consumed: 1,
          issued_at: "2026-04-17T00:00:00.000Z",
          replaced_at: null,
          created_at: "2026-04-17T00:00:00.000Z",
          updated_at: "2026-04-17T00:00:00.000Z",
        }]
      }
      if (sql.includes("FROM profiles")) {
        return [{
          user_id: "usr_captain",
          display_name: "Captain Public",
          bio: "Bio",
          avatar_ref: "ipfs://avatar",
          cover_ref: "ipfs://cover",
          preferred_locale: "en-US",
          global_handle_id: "ghd_captain",
          primary_linked_handle_id: "lnh_ens",
          created_at: "2026-04-17T00:00:00.000Z",
          updated_at: "2026-04-17T00:00:00.000Z",
        }]
      }
      if (sql.includes("FROM linked_handles")) {
        return [{
          linked_handle_id: "lnh_ens",
          user_id: "usr_captain",
          wallet_attachment_id: "wat_1",
          kind: "ens",
          label_normalized: "captain.eth",
          label_display: "captain.eth",
          verification_state: "verified",
          metadata_json: null,
          created_at: "2026-04-17T00:00:00.000Z",
          updated_at: "2026-04-17T00:00:00.000Z",
        }]
      }
      throw new Error(`Unexpected SQL: ${sql}`)
    }) as Parameters<typeof resolvePublicProfileByHandleFromPostgres>[0]["query"]

    const resolved = await resolvePublicProfileByHandleFromPostgres({
      env: baseEnv,
      handleLabel: "captainpublic",
      query,
    })

    expect(resolved).not.toBeNull()
    expect(resolved?.requested_handle_label).toBe("captainpublic.pirate")
    expect(resolved?.resolved_handle_label).toBe("captainpublic.pirate")
    expect(resolved?.is_canonical).toBe(true)
    expect(resolved?.profile.user_id).toBe("usr_captain")
    expect(resolved?.profile.primary_public_handle?.label).toBe("captain.eth")
    expect((resolved?.profile.linked_handles ?? []).map((handle) => handle.label)).toEqual([
      "captainpublic.pirate",
      "captain.eth",
    ])
  })

  test("resolves redirects to the canonical handle from postgres rows", async () => {
    const query = (async (sql: string, params?: unknown[]) => {
      if (sql.includes("FROM global_handles") && sql.includes("WHERE label_normalized = $1")) {
        expect(params).toEqual(["oldcaptain"])
        return [{
          global_handle_id: "ghd_old",
          user_id: "usr_captain",
          label_normalized: "oldcaptain",
          label_display: "oldcaptain.pirate",
          status: "redirect",
          tier: "generated",
          issuance_source: "generated_signup",
          redirect_target_global_handle_id: "ghd_new",
          price_paid_usd: null,
          free_rename_consumed: 0,
          issued_at: "2026-04-16T00:00:00.000Z",
          replaced_at: "2026-04-17T00:00:00.000Z",
          created_at: "2026-04-16T00:00:00.000Z",
          updated_at: "2026-04-17T00:00:00.000Z",
        }]
      }
      if (sql.includes("FROM global_handles") && sql.includes("WHERE global_handle_id = $1")) {
        expect(params).toEqual(["ghd_new"])
        return [{
          global_handle_id: "ghd_new",
          user_id: "usr_captain",
          label_normalized: "captainpublic",
          label_display: "captainpublic.pirate",
          status: "active",
          tier: "standard",
          issuance_source: "free_cleanup_rename",
          redirect_target_global_handle_id: null,
          price_paid_usd: null,
          free_rename_consumed: 1,
          issued_at: "2026-04-17T00:00:00.000Z",
          replaced_at: null,
          created_at: "2026-04-17T00:00:00.000Z",
          updated_at: "2026-04-17T00:00:00.000Z",
        }]
      }
      if (sql.includes("FROM profiles")) {
        return [{
          user_id: "usr_captain",
          display_name: "Captain Public",
          bio: null,
          avatar_ref: null,
          cover_ref: null,
          preferred_locale: null,
          global_handle_id: "ghd_new",
          primary_linked_handle_id: null,
          created_at: "2026-04-17T00:00:00.000Z",
          updated_at: "2026-04-17T00:00:00.000Z",
        }]
      }
      if (sql.includes("FROM linked_handles")) {
        return []
      }
      throw new Error(`Unexpected SQL: ${sql}`)
    }) as Parameters<typeof resolvePublicProfileByHandleFromPostgres>[0]["query"]

    const resolved = await resolvePublicProfileByHandleFromPostgres({
      env: baseEnv,
      handleLabel: "oldcaptain",
      query,
    })

    expect(resolved).not.toBeNull()
    expect(resolved?.requested_handle_label).toBe("oldcaptain.pirate")
    expect(resolved?.resolved_handle_label).toBe("captainpublic.pirate")
    expect(resolved?.is_canonical).toBe(false)
    expect(resolved?.profile.global_handle.label).toBe("captainpublic.pirate")
  })
})
