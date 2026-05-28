import { afterEach, describe, expect, test } from "bun:test"
import { mkdtemp, rm } from "node:fs/promises"
import { tmpdir } from "node:os"
import { join } from "node:path"
import type { CommunityDatabaseBindingRepository } from "../src/lib/communities/db-community-repository"
import type { ProfileRepository, UserRepository } from "../src/lib/auth/repositories"
import { openCommunityDb } from "../src/lib/communities/community-db-factory"
import { setLockedAssetDeliveryPreparerForTests } from "../src/lib/communities/commerce/asset-delivery"
import { createSongAssetForPost, listCommunityDerivativeSources } from "../src/lib/communities/commerce/service"
import { insertPost } from "../src/lib/posts/community-post-store"
import {
  isStoryRoyaltyRegistrationConfigured,
  resolvePilTermsForLicense,
  resolveStoryRoyaltyDerivativeParents,
  setStoryRoyaltyRegistrarForTests,
} from "../src/lib/story/story-royalty-registration-service"
import type { Env, Profile, SongArtifactBundle, User, WalletAttachmentSummary } from "../src/types"

const cleanupPaths: string[] = []

afterEach(async () => {
  setLockedAssetDeliveryPreparerForTests(null)
  setStoryRoyaltyRegistrarForTests(null)
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

const testWallet = "0x2222222222222222222222222222222222222222"

function buildUser(userId: string): User {
  const now = new Date().toISOString()
  return {
    user_id: userId,
    primary_wallet_attachment_id: "wal_primary",
    verification_state: "verified",
    verification_capabilities: {
      unique_human: { state: "verified" },
      minimum_age: { state: "unverified" },
      nationality: { state: "unverified" },
      gender: { state: "unverified" },
    },
    created_at: now,
    updated_at: now,
  } as User
}

function buildWalletAttachment(): WalletAttachmentSummary {
  return {
    wallet_attachment: "wal_primary",
    chain_namespace: "eip155:1",
    wallet_address: testWallet,
    is_primary: true,
  }
}

function buildBundle(input: { id: string; title: string; contentHash?: string }): SongArtifactBundle {
  return {
    id: input.id,
    title: input.title,
    primary_audio: {
      id: "sau_primary",
      artifact_kind: "primary_audio",
      storage_ref: "filebase://songs/primary.wav",
      mime_type: "audio/wav",
      content_hash: input.contentHash ?? "0xabc123",
    },
  } as unknown as SongArtifactBundle
}

function buildProfileRepository(profile: Profile | null = null, userId: string | null = null): ProfileRepository {
  return {
    async getProfileByUserId(requestedUserId) {
      return profile && userId === requestedUserId ? profile : null
    },
    async listProfilesByUserIds(userIds) {
      return new Map(profile && userId && userIds.includes(userId) ? [[userId, profile]] : [])
    },
  } as ProfileRepository
}

function buildStoryUserRepository(userId: string): UserRepository {
  return {
    async getUserById(requestedUserId) {
      return requestedUserId === userId ? buildUser(userId) : null
    },
    async getWalletAttachmentsByUserId() {
      return [buildWalletAttachment()]
    },
    async getWalletAttachmentById() {
      return null
    },
  }
}

async function seedStoryCommunity(input: {
  env: Env
  repo: CommunityDatabaseBindingRepository
  communityId: string
  userId: string
}): Promise<void> {
  const now = "2026-04-21T00:00:00.000Z"
  const db = await openCommunityDb(input.env, input.repo, input.communityId)
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
      args: [input.communityId, "Story Royalty Test Community", input.userId, now],
    })
    await db.client.execute({
      sql: `
        INSERT INTO community_memberships (
          membership_id, community_id, user_id, status, joined_at, left_at, banned_at, created_at, updated_at
        ) VALUES (
          ?1, ?2, ?3, 'member', ?4, NULL, NULL, ?4, ?4
        )
      `,
      args: [`mbr_${input.userId}`, input.communityId, input.userId, now],
    })
  } finally {
    db.close()
  }
}

describe("story royalty registration service", () => {
  test("Story royalty configuration only requires the SPG NFT contract", () => {
    expect(isStoryRoyaltyRegistrationConfigured({
      STORY_ROYALTY_SPG_NFT_CONTRACT: "0x8888888888888888888888888888888888888888",
    })).toBe(true)
    expect(isStoryRoyaltyRegistrationConfigured({
      STORY_ROYALTY_SPG_NFT_CONTRACT: "",
    })).toBe(false)
  })

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

  test("marks royalty-enabled assets failed instead of leaving pending when registration is unavailable", async () => {
    async function createUnavailableAsset(input: {
      env: Env
      communityId: string
      userId: string
      title: string
      assetId: string
    }) {
      const repo = buildRepository()
      const now = "2026-04-21T00:00:00.000Z"
      await seedStoryCommunity({
        env: input.env,
        repo,
        communityId: input.communityId,
        userId: input.userId,
      })

      const db = await openCommunityDb(input.env, repo, input.communityId)
      try {
        const post = await insertPost({
          client: db.client,
          communityId: input.communityId,
          authorUserId: input.userId,
          body: {
            post_type: "song",
            identity_mode: "public",
            title: input.title,
            idempotency_key: `${input.assetId}-post`,
            song_mode: "original",
            rights_basis: "original",
            access_mode: "public",
          },
          createdAt: now,
        })
        const assetPost = {
          ...post,
          asset_id: input.assetId,
        }

        return {
          repo,
          asset: await createSongAssetForPost({
            env: input.env,
            client: db.client,
            communityId: input.communityId,
            post: assetPost,
            bundle: buildBundle({ id: `sab_${input.assetId}`, title: input.title }),
            licensePreset: "commercial-remix",
            commercialRevSharePct: 10,
            userRepository: {
              async getUserById(requestedUserId) {
                return requestedUserId === input.userId ? buildUser(input.userId) : null
              },
              async getWalletAttachmentsByUserId() {
                return [buildWalletAttachment()]
              },
              async getWalletAttachmentById() {
                return null
              },
            },
          }),
        }
      } finally {
        db.close()
      }
    }

    const configMissingRootDir = await mkdtemp(join(tmpdir(), "pirate-story-royalty-config-missing-"))
    cleanupPaths.push(configMissingRootDir)
    const configMissingEnv = { LOCAL_COMMUNITY_DB_ROOT: configMissingRootDir } as Env
    const configMissingCommunityId = "cmt_story_royalty_config_missing"
    const configMissingUserId = "usr_author_story_config_missing"
    const configMissing = await createUnavailableAsset({
      env: configMissingEnv,
      communityId: configMissingCommunityId,
      userId: configMissingUserId,
      title: "Config missing song",
      assetId: "ast_config_missing_song",
    })

    expect(configMissing.asset.story_royalty_registration_status).toBe("failed")
    expect(configMissing.asset.publication_status).toBe("draft")
    expect(configMissing.asset.story_status).toBe("none")
    expect(configMissing.asset.story_error).toContain("story_royalty_config_missing")

    const configMissingSources = await listCommunityDerivativeSources({
      env: configMissingEnv,
      userId: configMissingUserId,
      communityId: configMissingCommunityId,
      kind: "song",
      query: "Config missing",
      limit: 25,
      communityRepository: configMissing.repo,
      profileRepository: buildProfileRepository(),
    })
    expect(configMissingSources.items).toEqual([])

    const unavailableRootDir = await mkdtemp(join(tmpdir(), "pirate-story-royalty-unavailable-"))
    cleanupPaths.push(unavailableRootDir)
    const unavailableEnv = {
      LOCAL_COMMUNITY_DB_ROOT: unavailableRootDir,
      STORY_ROYALTY_SPG_NFT_CONTRACT: "0x8888888888888888888888888888888888888888",
      STORY_ROYALTY_COMMERCIAL_REV_SHARE_PCT: "10",
    } as Env
    const unavailable = await createUnavailableAsset({
      env: unavailableEnv,
      communityId: "cmt_story_royalty_unavailable",
      userId: "usr_author_story_unavailable",
      title: "Unavailable registrar song",
      assetId: "ast_unavailable_registrar_song",
    })

    expect(unavailable.asset.story_royalty_registration_status).toBe("failed")
    expect(unavailable.asset.publication_status).toBe("draft")
    expect(unavailable.asset.story_status).toBe("none")
    expect(unavailable.asset.story_error).toContain("story_royalty_registration_unavailable")
  })

  test("rolls back the post transaction when required royalty registration fails", async () => {
    const rootDir = await mkdtemp(join(tmpdir(), "pirate-story-royalty-required-"))
    cleanupPaths.push(rootDir)

    const env = { LOCAL_COMMUNITY_DB_ROOT: rootDir } as Env
    const repo = buildRepository()
    const communityId = "cmt_story_royalty_required"
    const userId = "usr_author_story_required"
    const now = "2026-04-21T00:00:00.000Z"
    const assetId = "ast_required_story_registration"
    let postId: string | null = null

    await seedStoryCommunity({ env, repo, communityId, userId })
    const db = await openCommunityDb(env, repo, communityId)
    try {
      const tx = await db.client.transaction("write")
      let caughtError: unknown
      try {
        const post = await insertPost({
          client: tx,
          communityId,
          authorUserId: userId,
          body: {
            post_type: "song",
            identity_mode: "public",
            title: "Required Story song",
            idempotency_key: "required-story-registration-post",
            song_mode: "original",
            rights_basis: "original",
            access_mode: "public",
          },
          createdAt: now,
        })
        postId = post.post_id

        await createSongAssetForPost({
          env,
          client: tx,
          communityId,
          post: {
            ...post,
            asset_id: assetId,
          },
          bundle: buildBundle({ id: "sab_required_story_registration", title: "Required Story song" }),
          licensePreset: "commercial-remix",
          commercialRevSharePct: 10,
          requireStoryRoyaltyRegistration: true,
          userRepository: buildStoryUserRepository(userId),
        })
      } catch (error) {
        caughtError = error
        await tx.rollback()
      } finally {
        tx.close()
      }

      expect(caughtError).toBeInstanceOf(Error)
      expect((caughtError as Error).message).toContain("Story registration failed before publishing this asset")
      expect((caughtError as Error).message).toContain("Story royalty configuration is missing")

      const posts = await db.client.execute({
        sql: "SELECT post_id FROM posts WHERE post_id = ?1",
        args: [postId],
      })
      expect(posts.rows).toHaveLength(0)

      const assets = await db.client.execute({
        sql: "SELECT asset_id FROM assets WHERE asset_id = ?1",
        args: [assetId],
      })
      expect(assets.rows).toHaveLength(0)
    } finally {
      db.close()
    }
  })

  test("allows derivative publishing when the same content was already registered as an original", async () => {
    const rootDir = await mkdtemp(join(tmpdir(), "pirate-story-royalty-original-collision-"))
    cleanupPaths.push(rootDir)

    const env = { LOCAL_COMMUNITY_DB_ROOT: rootDir } as Env
    const repo = buildRepository()
    const communityId = "cmt_story_royalty_original_collision"
    const userId = "usr_author_story_original_collision"
    const now = "2026-04-21T00:00:00.000Z"
    const originalIpId = "0x9999999999999999999999999999999999999999"
    const derivativeIpId = "0x3333333333333333333333333333333333333333"
    const userRepository = buildStoryUserRepository(userId)
    let derivativePostId: string | null = null
    let derivativeAssetId: string | null = null
    let derivativeRegistrarCalls = 0

    await seedStoryCommunity({ env, repo, communityId, userId })
    setStoryRoyaltyRegistrarForTests(async () => ({
      storyIpId: originalIpId,
      storyIpNftContract: "0x8888888888888888888888888888888888888888",
      storyIpNftTokenId: "123",
      storyLicenseTermsId: "17",
      storyLicenseTemplate: "0x7777777777777777777777777777777777777777",
      storyRoyaltyPolicy: "0x6666666666666666666666666666666666666666",
      storyDerivativeParentIpIds: null,
      storyRevenueToken: "0x1514000000000000000000000000000000000000",
      storyRoyaltyRegistrationStatus: "registered",
      storyDerivativeRegisteredAt: null,
    }))

    const db = await openCommunityDb(env, repo, communityId)
    try {
      const originalPost = await insertPost({
        client: db.client,
        communityId,
        authorUserId: userId,
        body: {
          post_type: "song",
          identity_mode: "public",
          title: "Accidentally original mix",
          idempotency_key: "story-original-collision-original-post",
          song_mode: "original",
          rights_basis: "original",
          access_mode: "public",
        },
        createdAt: now,
      })
      const original = await createSongAssetForPost({
        env,
        client: db.client,
        communityId,
        post: {
          ...originalPost,
          asset_id: "ast_original_collision_registered",
        },
        bundle: buildBundle({ id: "sab_original_collision_registered", title: "Accidentally original mix" }),
        licensePreset: "commercial-remix",
        commercialRevSharePct: 10,
        userRepository,
      })
      expect(original.story_royalty_registration_status).toBe("registered")
      expect(original.story_ip).toBe(originalIpId)

      await db.client.execute({
        sql: "UPDATE posts SET status = 'deleted' WHERE community_id = ?1 AND post_id = ?2",
        args: [communityId, originalPost.post_id],
      })

      setStoryRoyaltyRegistrarForTests(async () => {
        derivativeRegistrarCalls += 1
        return {
          storyIpId: derivativeIpId,
          storyIpNftContract: "0x8888888888888888888888888888888888888888",
          storyIpNftTokenId: "456",
          storyLicenseTermsId: "23",
          storyLicenseTemplate: "0x7777777777777777777777777777777777777777",
          storyRoyaltyPolicy: "0x6666666666666666666666666666666666666666",
          storyDerivativeParentIpIds: [originalIpId],
          storyRevenueToken: "0x1514000000000000000000000000000000000000",
          storyRoyaltyRegistrationStatus: "registered",
          storyDerivativeRegisteredAt: now,
        }
      })

      const tx = await db.client.transaction("write")
      try {
        const derivativePost = await insertPost({
          client: tx,
          communityId,
          authorUserId: userId,
          body: {
            post_type: "song",
            identity_mode: "public",
            title: "Same bytes remix",
            idempotency_key: "story-original-collision-derivative-post",
            song_mode: "remix",
            rights_basis: "derivative",
            access_mode: "public",
            upstream_asset_refs: [`story:ip:${originalIpId}#licenseTermsId=17`],
          },
          createdAt: now,
        })
        derivativePostId = derivativePost.post_id

        const derivative = await createSongAssetForPost({
          env,
          client: tx,
          communityId,
          post: {
            ...derivativePost,
            asset_id: "ast_original_collision_derivative",
          },
          bundle: buildBundle({ id: "sab_original_collision_derivative", title: "Same bytes remix" }),
          licensePreset: null,
          commercialRevSharePct: null,
          requireStoryRoyaltyRegistration: true,
          userRepository,
        })
        derivativeAssetId = derivative.id
        await tx.commit()
      } catch (error) {
        await tx.rollback()
        throw error
      } finally {
        tx.close()
      }

      expect(derivativeRegistrarCalls).toBe(1)
      expect(derivativeAssetId).toBe("asset_ast_original_collision_derivative")

      const derivativePosts = await db.client.execute({
        sql: "SELECT post_id FROM posts WHERE post_id = ?1",
        args: [derivativePostId],
      })
      expect(derivativePosts.rows).toHaveLength(1)

      const derivativeAssets = await db.client.execute({
        sql: `
          SELECT asset_id, rights_basis, primary_content_hash, story_ip_id, story_royalty_registration_status
          FROM assets
          WHERE asset_id = ?1
        `,
        args: ["ast_original_collision_derivative"],
      })
      expect(derivativeAssets.rows).toHaveLength(1)
      expect(derivativeAssets.rows[0]?.rights_basis).toBe("derivative")
      expect(derivativeAssets.rows[0]?.primary_content_hash).toBe(original.primary_content_hash)
      expect(derivativeAssets.rows[0]?.story_ip_id).toBe(derivativeIpId)
      expect(derivativeAssets.rows[0]?.story_royalty_registration_status).toBe("registered")
    } finally {
      db.close()
    }
  })

  test("skips duplicate royalty registration when locked delivery already registered the asset", async () => {
    const rootDir = await mkdtemp(join(tmpdir(), "pirate-story-royalty-locked-"))
    cleanupPaths.push(rootDir)

    const env = { LOCAL_COMMUNITY_DB_ROOT: rootDir } as Env
    const repo = buildRepository()
    const communityId = "cmt_story_royalty_locked_registered"
    const userId = "usr_author_story_locked"
    const now = "2026-04-21T00:00:00.000Z"
    await seedStoryCommunity({ env, repo, communityId, userId })
    let registrarCalls = 0
    setStoryRoyaltyRegistrarForTests(async () => {
      registrarCalls += 1
      throw new Error("duplicate royalty registration")
    })
    setLockedAssetDeliveryPreparerForTests(async (input) => ({
      storyStatus: "published",
      storyPublishTxRef: "0xpublish",
      storyIpId: "0x9999999999999999999999999999999999999999",
      storyRoyaltyPolicyId: "0x6666666666666666666666666666666666666666",
      storyDerivativeParentIpIdsJson: null,
      storyRoyaltyRegistrationStatus: "registered",
      storyAssetVersionId: "0xassetversion",
      storyCdrVaultUuid: 4242,
      storyNamespace: "story-namespace",
      storyEntitlementTokenId: "1",
      storyReadCondition: "0x1111111111111111111111111111111111111111",
      storyWriteCondition: "0x2222222222222222222222222222222222222222",
      lockedDeliveryStatus: "ready",
      lockedDeliveryRef: `/communities/${input.communityId}/assets/${input.assetId}/content`,
      lockedDeliveryStorageRef: "locked-assets/payload.bin",
      lockedDeliveryMetadataJson: "{}",
    }))

    const db = await openCommunityDb(env, repo, communityId)
    try {
      const post = await insertPost({
        client: db.client,
        communityId,
        authorUserId: userId,
        body: {
          post_type: "song",
          identity_mode: "public",
          title: "Locked registered song",
          idempotency_key: "locked-registered-post",
          song_mode: "original",
          rights_basis: "original",
          access_mode: "locked",
        },
        createdAt: now,
      })
      const asset = await createSongAssetForPost({
        env,
        client: db.client,
        communityId,
        post: {
          ...post,
          asset_id: "ast_locked_registered_song",
        },
        bundle: buildBundle({ id: "sab_locked_registered", title: "Locked registered song" }),
        licensePreset: "commercial-remix",
        commercialRevSharePct: 10,
        userRepository: {
          async getUserById(requestedUserId) {
            return requestedUserId === userId ? buildUser(userId) : null
          },
          async getWalletAttachmentsByUserId() {
            return [buildWalletAttachment()]
          },
          async getWalletAttachmentById() {
            return null
          },
        },
      })

      expect(registrarCalls).toBe(0)
      expect(asset.story_royalty_registration_status).toBe("registered")
      expect(asset.publication_status).toBe("story_published")
      expect(asset.story_status).toBe("published")
    } finally {
      db.close()
    }
  })

  test("registered original song assets become derivative sources", async () => {
    const rootDir = await mkdtemp(join(tmpdir(), "pirate-story-royalty-registered-"))
    cleanupPaths.push(rootDir)

    const env = { LOCAL_COMMUNITY_DB_ROOT: rootDir } as Env
    const repo = buildRepository()
    const communityId = "cmt_story_royalty_registered"
    const userId = "usr_author_story_registered"
    const now = "2026-04-21T00:00:00.000Z"
    await seedStoryCommunity({ env, repo, communityId, userId })

    setStoryRoyaltyRegistrarForTests(async (input) => ({
      storyIpId: "0x9999999999999999999999999999999999999999",
      storyIpNftContract: "0x8888888888888888888888888888888888888888",
      storyIpNftTokenId: "123",
      storyLicenseTermsId: "17",
      storyLicenseTemplate: "0x7777777777777777777777777777777777777777",
      storyRoyaltyPolicy: "0x6666666666666666666666666666666666666666",
      storyDerivativeParentIpIds: null,
      storyRevenueToken: "0x1514000000000000000000000000000000000000",
      storyRoyaltyRegistrationStatus: "registered",
      storyDerivativeRegisteredAt: input.rightsBasis === "derivative" ? now : null,
    }))

    const db = await openCommunityDb(env, repo, communityId)
    let publicAssetId: string
    try {
      const post = await insertPost({
        client: db.client,
        communityId,
        authorUserId: userId,
        body: {
          post_type: "song",
          identity_mode: "public",
          title: "Registered source song",
          idempotency_key: "story-registered-post",
          song_mode: "original",
          rights_basis: "original",
          access_mode: "public",
        },
        createdAt: now,
      })
      const assetPost = {
        ...post,
        asset_id: "ast_registered_source_song",
      }

      const asset = await createSongAssetForPost({
        env,
        client: db.client,
        communityId,
        post: assetPost,
        bundle: buildBundle({ id: "sab_registered", title: "Registered source song" }),
        licensePreset: "commercial-remix",
        commercialRevSharePct: 15,
        userRepository: {
          async getUserById(requestedUserId) {
            return requestedUserId === userId ? buildUser(userId) : null
          },
          async getWalletAttachmentsByUserId() {
            return [buildWalletAttachment()]
          },
          async getWalletAttachmentById() {
            return null
          },
        },
      })

      publicAssetId = asset.id
      expect(asset.publication_status).toBe("story_published")
      expect(asset.story_status).toBe("published")
      expect(asset.story_royalty_registration_status).toBe("registered")
      expect(asset.story_ip).toBe("0x9999999999999999999999999999999999999999")
      expect(asset.story_license_terms).toBe("17")
    } finally {
      db.close()
    }

    const profile: Profile = {
      user_id: userId,
      display_name: "Registered Artist",
      handle: "registeredartist",
      global_handle: { label: "registeredartist.pirate" },
      avatar_url: null,
      bio: null,
      location: null,
      website_url: null,
      social_links: null,
      created_at: now,
      updated_at: now,
    } as unknown as Profile

    const sources = await listCommunityDerivativeSources({
      env,
      userId,
      communityId,
      kind: "song",
      query: "Registered",
      limit: 25,
      communityRepository: repo,
      profileRepository: buildProfileRepository(profile, userId),
    })

    expect(sources.items).toHaveLength(1)
    expect(sources.items[0]).toMatchObject({
      id: publicAssetId,
      asset: publicAssetId,
      title: "Registered source song",
      kind: "song",
      story_ip: "0x9999999999999999999999999999999999999999",
      story_license_terms: "17",
      creator_display_name: "Registered Artist",
    })
  })

  test("uses derivative source asset refs to register remix parents", async () => {
    const rootDir = await mkdtemp(join(tmpdir(), "pirate-story-royalty-remix-source-"))
    cleanupPaths.push(rootDir)

    const env = { LOCAL_COMMUNITY_DB_ROOT: rootDir } as Env
    const repo = buildRepository()
    const communityId = "cmt_story_royalty_remix_source"
    const userId = "usr_author_story_remix_source"
    const now = "2026-04-21T00:00:00.000Z"
    const parentIpId = "0x9999999999999999999999999999999999999999"
    const derivativeIpId = "0x3333333333333333333333333333333333333333"
    await seedStoryCommunity({ env, repo, communityId, userId })

    setStoryRoyaltyRegistrarForTests(async (input) => {
      if (input.rightsBasis === "derivative") {
        const parents = await resolveStoryRoyaltyDerivativeParents({
          client: input.client,
          communityId: input.communityId,
          upstreamAssetRefs: input.upstreamAssetRefs,
        })
        expect(parents).toEqual([
          {
            ipId: parentIpId,
            licenseTermsId: 17n,
          },
        ])
        if (!parents) {
          throw new Error("expected derivative parents")
        }
        return {
          storyIpId: derivativeIpId,
          storyIpNftContract: "0x8888888888888888888888888888888888888888",
          storyIpNftTokenId: "456",
          storyLicenseTermsId: "23",
          storyLicenseTemplate: "0x7777777777777777777777777777777777777777",
          storyRoyaltyPolicy: "0x6666666666666666666666666666666666666666",
          storyDerivativeParentIpIds: parents.map((parent) => parent.ipId),
          storyRevenueToken: "0x1514000000000000000000000000000000000000",
          storyRoyaltyRegistrationStatus: "registered",
          storyDerivativeRegisteredAt: now,
        }
      }

      return {
        storyIpId: parentIpId,
        storyIpNftContract: "0x8888888888888888888888888888888888888888",
        storyIpNftTokenId: "123",
        storyLicenseTermsId: "17",
        storyLicenseTemplate: "0x7777777777777777777777777777777777777777",
        storyRoyaltyPolicy: "0x6666666666666666666666666666666666666666",
        storyDerivativeParentIpIds: null,
        storyRevenueToken: "0x1514000000000000000000000000000000000000",
        storyRoyaltyRegistrationStatus: "registered",
        storyDerivativeRegisteredAt: null,
      }
    })

    const userRepository = buildStoryUserRepository(userId)
    const db = await openCommunityDb(env, repo, communityId)
    let derivativeAssetId: string
    try {
      const originalPost = await insertPost({
        client: db.client,
        communityId,
        authorUserId: userId,
        body: {
          post_type: "song",
          identity_mode: "public",
          title: "Palestine, Don't Cry",
          idempotency_key: "story-remix-source-original-post",
          song_mode: "original",
          rights_basis: "original",
          access_mode: "public",
        },
        createdAt: now,
      })
      const original = await createSongAssetForPost({
        env,
        client: db.client,
        communityId,
        post: {
          ...originalPost,
          asset_id: "ast_palestine_dont_cry",
        },
        bundle: buildBundle({ id: "sab_palestine_dont_cry", title: "Palestine, Don't Cry" }),
        licensePreset: "commercial-remix",
        commercialRevSharePct: 10,
        userRepository,
      })
      expect(original.story_ip).toBe(parentIpId)

      const sources = await listCommunityDerivativeSources({
        env,
        userId,
        communityId,
        kind: "song",
        query: "Palestine",
        limit: 25,
        communityRepository: repo,
        profileRepository: buildProfileRepository(),
      })
      expect(sources.items).toHaveLength(1)
      const upstreamAssetRef = `story:asset:${sources.items[0].asset}`
      expect(upstreamAssetRef).toBe("story:asset:asset_ast_palestine_dont_cry")

      const remixPost = await insertPost({
        client: db.client,
        communityId,
        authorUserId: userId,
        body: {
          post_type: "song",
          identity_mode: "public",
          title: "Palestine, Don't Cry Remix",
          idempotency_key: "story-remix-source-derivative-post",
          song_mode: "remix",
          rights_basis: "derivative",
          access_mode: "public",
          upstream_asset_refs: [upstreamAssetRef],
        },
        createdAt: now,
      })
      const derivative = await createSongAssetForPost({
        env,
        client: db.client,
        communityId,
        post: {
          ...remixPost,
          asset_id: "ast_palestine_dont_cry_remix",
        },
        bundle: buildBundle({
          id: "sab_palestine_dont_cry_remix",
          title: "Palestine, Don't Cry Remix",
          contentHash: "0xdef456",
        }),
        licensePreset: null,
        commercialRevSharePct: null,
        userRepository,
      })
      derivativeAssetId = derivative.id

      expect(derivative.publication_status).toBe("story_published")
      expect(derivative.story_status).toBe("published")
      expect(derivative.story_royalty_registration_status).toBe("registered")
      expect(derivative.story_ip).toBe(derivativeIpId)
      expect(derivative.story_derivative_parent_ip_ids).toEqual([parentIpId])
    } finally {
      db.close()
    }

    const derivativeSources = await listCommunityDerivativeSources({
      env,
      userId,
      communityId,
      kind: "song",
      query: "Remix",
      limit: 25,
      communityRepository: repo,
      profileRepository: buildProfileRepository(),
    })
    expect(derivativeSources.items.map((source) => source.asset)).toContain(derivativeAssetId)
  })

  test("uses a remix source Story ref when registering a remix of a remix", async () => {
    const rootDir = await mkdtemp(join(tmpdir(), "pirate-story-royalty-remix-chain-"))
    cleanupPaths.push(rootDir)

    const env = { LOCAL_COMMUNITY_DB_ROOT: rootDir } as Env
    const repo = buildRepository()
    const communityId = "cmt_story_royalty_remix_chain"
    const userId = "usr_author_story_remix_chain"
    const now = "2026-04-21T00:00:00.000Z"
    const originalIpId = "0xaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaa"
    const firstRemixIpId = "0xbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbb"
    const secondRemixIpId = "0xcccccccccccccccccccccccccccccccccccccccc"
    await seedStoryCommunity({ env, repo, communityId, userId })

    setStoryRoyaltyRegistrarForTests(async (input) => {
      if (input.assetId === "ast_chain_first_remix") {
        const parents = await resolveStoryRoyaltyDerivativeParents({
          client: input.client,
          communityId: input.communityId,
          upstreamAssetRefs: input.upstreamAssetRefs,
        })
        expect(parents).toEqual([{ ipId: originalIpId, licenseTermsId: 17n }])
        return {
          storyIpId: firstRemixIpId,
          storyIpNftContract: "0x8888888888888888888888888888888888888888",
          storyIpNftTokenId: "456",
          storyLicenseTermsId: "23",
          storyLicenseTemplate: "0x7777777777777777777777777777777777777777",
          storyRoyaltyPolicy: "0x6666666666666666666666666666666666666666",
          storyDerivativeParentIpIds: parents?.map((parent) => parent.ipId) ?? null,
          storyRevenueToken: "0x1514000000000000000000000000000000000000",
          storyRoyaltyRegistrationStatus: "registered",
          storyDerivativeRegisteredAt: now,
        }
      }
      if (input.assetId === "ast_chain_second_remix") {
        const parents = await resolveStoryRoyaltyDerivativeParents({
          client: input.client,
          communityId: input.communityId,
          upstreamAssetRefs: input.upstreamAssetRefs,
        })
        expect(parents).toEqual([{ ipId: firstRemixIpId, licenseTermsId: 23n }])
        return {
          storyIpId: secondRemixIpId,
          storyIpNftContract: "0x8888888888888888888888888888888888888888",
          storyIpNftTokenId: "789",
          storyLicenseTermsId: "31",
          storyLicenseTemplate: "0x7777777777777777777777777777777777777777",
          storyRoyaltyPolicy: "0x6666666666666666666666666666666666666666",
          storyDerivativeParentIpIds: parents?.map((parent) => parent.ipId) ?? null,
          storyRevenueToken: "0x1514000000000000000000000000000000000000",
          storyRoyaltyRegistrationStatus: "registered",
          storyDerivativeRegisteredAt: now,
        }
      }

      return {
        storyIpId: originalIpId,
        storyIpNftContract: "0x8888888888888888888888888888888888888888",
        storyIpNftTokenId: "123",
        storyLicenseTermsId: "17",
        storyLicenseTemplate: "0x7777777777777777777777777777777777777777",
        storyRoyaltyPolicy: "0x6666666666666666666666666666666666666666",
        storyDerivativeParentIpIds: null,
        storyRevenueToken: "0x1514000000000000000000000000000000000000",
        storyRoyaltyRegistrationStatus: "registered",
        storyDerivativeRegisteredAt: null,
      }
    })

    const userRepository = buildStoryUserRepository(userId)
    const db = await openCommunityDb(env, repo, communityId)
    try {
      const originalPost = await insertPost({
        client: db.client,
        communityId,
        authorUserId: userId,
        body: {
          post_type: "song",
          identity_mode: "public",
          title: "Chain Original",
          idempotency_key: "story-remix-chain-original-post",
          song_mode: "original",
          rights_basis: "original",
          access_mode: "public",
        },
        createdAt: now,
      })
      await createSongAssetForPost({
        env,
        client: db.client,
        communityId,
        post: {
          ...originalPost,
          asset_id: "ast_chain_original",
        },
        bundle: buildBundle({ id: "sab_chain_original", title: "Chain Original" }),
        licensePreset: "commercial-remix",
        commercialRevSharePct: 10,
        userRepository,
      })

      const originalSources = await listCommunityDerivativeSources({
        env,
        userId,
        communityId,
        kind: "song",
        query: "Original",
        limit: 25,
        communityRepository: repo,
        profileRepository: buildProfileRepository(),
      })
      const originalRef = originalSources.items[0]?.source_ref
      expect(originalRef).toBe(`story:ip:${originalIpId}#licenseTermsId=17`)

      const firstRemixPost = await insertPost({
        client: db.client,
        communityId,
        authorUserId: userId,
        body: {
          post_type: "song",
          identity_mode: "public",
          title: "Chain First Remix",
          idempotency_key: "story-remix-chain-first-post",
          song_mode: "remix",
          rights_basis: "derivative",
          access_mode: "public",
          upstream_asset_refs: [originalRef],
        },
        createdAt: now,
      })
      const firstRemix = await createSongAssetForPost({
        env,
        client: db.client,
        communityId,
        post: {
          ...firstRemixPost,
          asset_id: "ast_chain_first_remix",
        },
        bundle: buildBundle({
          id: "sab_chain_first_remix",
          title: "Chain First Remix",
          contentHash: "0xdef456",
        }),
        licensePreset: "commercial-remix",
        commercialRevSharePct: 15,
        userRepository,
      })
      expect(firstRemix.story_derivative_parent_ip_ids).toEqual([originalIpId])

      const remixSources = await listCommunityDerivativeSources({
        env,
        userId,
        communityId,
        kind: "song",
        query: "First Remix",
        limit: 25,
        communityRepository: repo,
        profileRepository: buildProfileRepository(),
      })
      const firstRemixRef = remixSources.items[0]?.source_ref
      expect(firstRemixRef).toBe(`story:ip:${firstRemixIpId}#licenseTermsId=23`)

      const secondRemixPost = await insertPost({
        client: db.client,
        communityId,
        authorUserId: userId,
        body: {
          post_type: "song",
          identity_mode: "public",
          title: "Chain Second Remix",
          idempotency_key: "story-remix-chain-second-post",
          song_mode: "remix",
          rights_basis: "derivative",
          access_mode: "public",
          upstream_asset_refs: [firstRemixRef],
        },
        createdAt: now,
      })
      const secondRemix = await createSongAssetForPost({
        env,
        client: db.client,
        communityId,
        post: {
          ...secondRemixPost,
          asset_id: "ast_chain_second_remix",
        },
        bundle: buildBundle({
          id: "sab_chain_second_remix",
          title: "Chain Second Remix",
          contentHash: "0xfedcba",
        }),
        licensePreset: "commercial-remix",
        commercialRevSharePct: 20,
        userRepository,
      })

      expect(secondRemix.story_ip).toBe(secondRemixIpId)
      expect(secondRemix.story_derivative_parent_ip_ids).toEqual([firstRemixIpId])
    } finally {
      db.close()
    }
  })
})
