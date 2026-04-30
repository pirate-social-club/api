import { afterEach, describe, expect, test } from "bun:test"
import { mkdtemp, rm } from "node:fs/promises"
import { tmpdir } from "node:os"
import { join } from "node:path"
import type { CommunityDatabaseBindingRepository } from "../src/lib/communities/db-community-repository"
import { openCommunityDb } from "../src/lib/communities/community-db-factory"
import { insertPost } from "../src/lib/posts/community-post-store"
import {
  resolvePilTermsForLicense,
  resolveStoryRoyaltyDerivativeParents,
} from "../src/lib/story/story-royalty-registration-service"
import type { Env } from "../src/types"

const cleanupPaths: string[] = []

afterEach(async () => {
  await Promise.all(cleanupPaths.splice(0).map((path) => rm(path, { recursive: true, force: true })))
})

function buildRepository(): CommunityDatabaseBindingRepository {
  const repo = {
    async getPrimaryCommunityDatabaseBinding() {
      return null
    },
    async getActiveCommunityDbCredential() {
      return null
    },
  }
  return repo
}

describe("story royalty registration service", () => {
  test("resolves creator-selected PIL terms by license preset", () => {
    const base = {
      defaultMintingFee: 0n,
      currency: "0x1514000000000000000000000000000000000000" as `0x${string}`,
      royaltyPolicy: "0xBe54FB168b3c982b7AaE60dB6CF75Bd8447b390E" as `0x${string}`,
    }

    expect(() =>
      resolvePilTermsForLicense({
        ...base,
        licensePreset: "non-commercial",
        commercialRevSharePct: null,
      })
    ).not.toThrow()
    expect(() =>
      resolvePilTermsForLicense({
        ...base,
        licensePreset: "commercial-use",
        commercialRevSharePct: null,
      })
    ).not.toThrow()
    expect(() =>
      resolvePilTermsForLicense({
        ...base,
        licensePreset: "commercial-remix",
        commercialRevSharePct: 10,
      })
    ).not.toThrow()
  })

  test("requires valid revenue share only for commercial remix PIL terms", () => {
    const base = {
      defaultMintingFee: 0n,
      currency: "0x1514000000000000000000000000000000000000" as `0x${string}`,
      royaltyPolicy: "0xBe54FB168b3c982b7AaE60dB6CF75Bd8447b390E" as `0x${string}`,
    }

    expect(() =>
      resolvePilTermsForLicense({
        ...base,
        licensePreset: "commercial-remix",
        commercialRevSharePct: null,
      })
    ).toThrow("commercialRevSharePct must be an integer from 0 to 100")
    expect(() =>
      resolvePilTermsForLicense({
        ...base,
        licensePreset: "commercial-remix",
        commercialRevSharePct: 10.5,
      })
    ).toThrow("commercialRevSharePct must be an integer from 0 to 100")
  })

  test("resolves derivative parents from local story asset references", async () => {
    const rootDir = await mkdtemp(join(tmpdir(), "pirate-story-royalty-"))
    cleanupPaths.push(rootDir)

    const env = { LOCAL_COMMUNITY_DB_ROOT: rootDir } as Env
    const repo = buildRepository()
    const communityId = "cmt_story_royalty_local_parent"
    const now = "2026-04-21T00:00:00.000Z"

    const db = await openCommunityDb(env, repo, communityId)
    try {
      await db.client.execute({
        sql: `
          INSERT INTO communities (
            community_id, display_name, description, status, artist_identity_id, artist_governance_state,
            membership_mode, default_age_gate_policy, allow_anonymous_identity, anonymous_identity_scope,
            donation_partner_id, donation_policy_mode, donation_partner_status, governance_mode,
            settings_json, created_by_user_id, created_at, updated_at
          ) VALUES (
            ?1, ?2, NULL, 'active', NULL, 'fan_run',
            'request', 'none', 1, 'thread_stable',
            NULL, 'none', 'unconfigured', 'centralized',
            NULL, ?3, ?4, ?4
          )
        `,
        args: [communityId, "Story Royalty Test Community", "usr_author_story", now],
      })

      const post = await insertPost({
        client: db.client,
        communityId,
        authorUserId: "usr_author_story",
        body: {
          post_type: "song",
          identity_mode: "public",
          title: "Parent song",
          idempotency_key: "story-parent-post",
          song_mode: "original",
          rights_basis: "original",
          access_mode: "locked",
        },
        createdAt: now,
      })

      await db.client.execute({
        sql: `
          INSERT INTO assets (
            asset_id, community_id, source_post_id, song_artifact_bundle_id, creator_user_id, asset_kind,
            rights_basis, access_mode, primary_content_ref, primary_content_hash, publication_status,
            story_status, story_error, story_ip_id, story_ip_nft_contract, story_ip_nft_token_id,
            story_publish_model, story_license_terms_id, story_license_template, story_royalty_policy,
            story_royalty_policy_id, story_derivative_parent_ip_ids_json, story_derivative_registered_at,
            story_revenue_token, story_royalty_registration_status, locked_delivery_status, locked_delivery_ref,
            locked_delivery_error, created_at, updated_at
          ) VALUES (
            ?1, ?2, ?3, NULL, ?4, 'song_audio',
            'original', 'locked', ?5, ?6, 'draft',
            'published', NULL, ?7, NULL, NULL,
            'story_ip_v1', ?8, NULL, NULL,
            ?9, NULL, NULL,
            NULL, 'registered', 'ready', NULL,
            NULL, ?10, ?10
          )
        `,
        args: [
          "ast_parent_story",
          communityId,
          post.post_id,
          "usr_author_story",
          "locked:ast_parent_story",
          "0xabc123",
          "0x9999999999999999999999999999999999999999",
          "17",
          "0xBe54FB168b3c982b7AaE60dB6CF75Bd8447b390E",
          now,
        ],
      })

      const resolved = await resolveStoryRoyaltyDerivativeParents({
        client: db.client,
        communityId,
        upstreamAssetRefs: ["story:asset:ast_parent_story"],
      })

      expect(resolved).toEqual([
        {
          ipId: "0x9999999999999999999999999999999999999999",
          licenseTermsId: 17n,
        },
      ])
    } finally {
      db.close()
    }
  })
})
