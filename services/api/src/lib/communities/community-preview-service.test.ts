import { mkdtemp } from "node:fs/promises"
import { tmpdir } from "node:os"
import { join } from "node:path"
import { createClient } from "@libsql/client"
import { describe, expect, test } from "bun:test"

import { getPublicCommunityPreviewFromCommunityDb } from "./community-preview-service"
import { configureLocalCommunityDbClient, ensureCommunityDbSchema } from "./community-local-db"
import type { CommunityRow } from "../auth/auth-db-rows"
import type { Env } from "../../env"

// Regression guard: the public-post / public-community preview must surface the
// community's real `karaoke_enabled` value. A prior bug omitted the column from
// the preview SELECT, so every preview reported false and the web Sing button
// (gated on community.karaoke_enabled) never appeared even when karaoke was on.
async function buildCommunityDb(karaokeEnabled: 0 | 1) {
  const dir = await mkdtemp(join(tmpdir(), "preview-karaoke-"))
  const dbPath = join(dir, "community.db")
  const communityId = "cmt_preview_karaoke"
  const now = "2026-06-25T00:00:00.000Z"

  const client = createClient({ url: `file:${dbPath}` })
  await configureLocalCommunityDbClient(client)
  await ensureCommunityDbSchema(client)
  await client.execute({
    sql: `
      INSERT INTO communities (
        community_id, display_name, description, status, artist_identity_id,
        artist_governance_state, membership_mode, default_age_gate_policy, allow_anonymous_identity,
        anonymous_identity_scope, donation_partner_id, donation_policy_mode, donation_partner_status,
        governance_mode, settings_json, created_by_user_id, created_at, updated_at, karaoke_enabled
      ) VALUES (
        ?1, ?2, NULL, 'active', NULL,
        'fan_run', 'open', 'none', 0,
        NULL, NULL, 'none', 'unconfigured',
        'centralized', NULL, ?3, ?4, ?4, ?5
      )
    `,
    args: [communityId, "Preview Karaoke Test", "usr_owner", now, karaokeEnabled],
  })

  const community: CommunityRow = {
    community_id: communityId,
    creator_user_id: "usr_owner",
    display_name: "Preview Karaoke Test",
    description: null,
    avatar_ref: null,
    banner_ref: null,
    status: "active",
    provisioning_state: "active",
    transfer_state: "none",
    route_slug: "@preview",
    namespace_verification_id: null,
    pending_namespace_verification_session_id: null,
    primary_database_binding_id: null,
    follower_count: 0,
    created_at: now,
    updated_at: now,
  }

  const communityRepository = {
    getCommunityById: async (id: string) => (id === communityId ? community : null),
  } as unknown as Parameters<typeof getPublicCommunityPreviewFromCommunityDb>[0]["communityRepository"]

  return { client, communityId, communityRepository }
}

describe("community preview karaoke_enabled propagation", () => {
  test("preview reports karaoke_enabled: true when the community has it enabled", async () => {
    const ctx = await buildCommunityDb(1)
    try {
      const preview = await getPublicCommunityPreviewFromCommunityDb({
        env: {} as Env,
        client: ctx.client,
        communityId: ctx.communityId,
        communityRepository: ctx.communityRepository,
      })
      expect(preview.karaoke_enabled).toBe(true)
    } finally {
      ctx.client.close()
    }
  })

  test("preview reports karaoke_enabled: false when the community has it disabled", async () => {
    const ctx = await buildCommunityDb(0)
    try {
      const preview = await getPublicCommunityPreviewFromCommunityDb({
        env: {} as Env,
        client: ctx.client,
        communityId: ctx.communityId,
        communityRepository: ctx.communityRepository,
      })
      expect(preview.karaoke_enabled).toBe(false)
    } finally {
      ctx.client.close()
    }
  })
})
