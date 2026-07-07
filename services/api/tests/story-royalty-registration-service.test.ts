import { afterEach, describe, expect, test } from "bun:test"
import { mkdtemp, rm } from "node:fs/promises"
import { tmpdir } from "node:os"
import { join } from "node:path"
import type { CommunityDatabaseBindingRepository } from "../src/lib/communities/db-community-repository"
import type { ProfileRepository, UserRepository } from "../src/lib/auth/repositories"
import { openCommunityDb } from "../src/lib/communities/community-db-factory"
import { setLockedAssetDeliveryPreparerForTests } from "../src/lib/communities/commerce/asset-delivery"
import { createSongAssetForPost, listCommunityDerivativeSources } from "../src/lib/communities/commerce/service"
import { insertPostForTest as insertPost } from "./community-test-helpers"
import { listStoryRegisteredAssetProjectionRows } from "../src/lib/communities/commerce/derivative-source-projection"
import { createControlPlaneTestClient } from "./helpers"
import {
  isStoryRoyaltyRegistrationConfigured,
  maybeRegisterStoryRoyaltyForAsset,
  resolvePilTermsForLicense,
  resolveStoryRoyaltyDerivativeParents,
  setStoryRoyaltyRegistrarForTests,
  setStoryRoyaltySdkClientFactoryForTests,
} from "../src/lib/story/story-royalty-registration-service"
import { setStoryJsonMetadataPublisherForTests } from "../src/lib/story/story-metadata-publisher"
import { setStoryRuntimeFundingAssertionForTests } from "../src/lib/story/story-runtime-funding"
import type { Env, Profile, SongArtifactBundle, User, WalletAttachmentSummary } from "../src/types"

const cleanupPaths: string[] = []

afterEach(async () => {
  setLockedAssetDeliveryPreparerForTests(null)
  setStoryRoyaltyRegistrarForTests(null)
  setStoryRoyaltySdkClientFactoryForTests(null)
  setStoryJsonMetadataPublisherForTests(null)
  setStoryRuntimeFundingAssertionForTests(null)
  await Promise.all(cleanupPaths.splice(0).map((path) => rm(path, { recursive: true, force: true })))
})

function buildRepository(): CommunityDatabaseBindingRepository {
  const repo = {
    async getPrimaryCommunityDatabaseBinding() {
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

function buildBundle(input: { id: string; title: string; contentHash?: string; coverArtRef?: string }): SongArtifactBundle {
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
    cover_art: input.coverArtRef
      ? {
          id: "sau_cover",
          artifact_kind: "cover_art",
          storage_ref: input.coverArtRef,
          mime_type: "image/jpeg",
        }
      : null,
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
    async setIdentityWallet() {
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

async function seedControlPlaneCommunityForProjection(input: {
  client: Awaited<ReturnType<typeof createControlPlaneTestClient>>["client"]
  communityId: string
  userId: string
  now: string
}): Promise<void> {
  await input.client.execute({
    sql: `
      INSERT INTO users (
        user_id, primary_wallet_attachment_id, verification_state, capability_provider,
        verification_capabilities_json, verified_at, current_verification_session_id,
        created_at, updated_at
      ) VALUES (
        ?1, NULL, 'verified', 'self',
        '{}', ?2, NULL,
        ?2, ?2
      )
      ON CONFLICT(user_id) DO NOTHING
    `,
    args: [input.userId, input.now],
  })
  await input.client.execute({
    sql: `
      INSERT INTO communities (
        community_id, creator_user_id, display_name, description, avatar_ref, banner_ref,
        membership_mode, status, provisioning_state, transfer_state,
        route_slug, namespace_verification_id, pending_namespace_verification_session_id, created_at, updated_at
      ) VALUES (
        ?1, ?2, 'Story Royalty Test Community', NULL, NULL, NULL,
        'request', 'active', 'active', 'none',
        NULL, NULL, NULL,
        ?3, ?3
      )
      ON CONFLICT(community_id) DO NOTHING
  `,
    args: [input.communityId, input.userId, input.now],
  })
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

  test("derivative registration does not attach outbound PIL terms after minting", async () => {
    const rootDir = await mkdtemp(join(tmpdir(), "pirate-story-royalty-derivative-onchain-"))
    cleanupPaths.push(rootDir)

    const env = {
      LOCAL_COMMUNITY_DB_ROOT: rootDir,
      STORY_ROYALTY_SPG_NFT_CONTRACT: "0x8888888888888888888888888888888888888888",
      STORY_OPERATOR_PRIVATE_KEY: "0x0000000000000000000000000000000000000000000000000000000000000001",
    } as Env
    const repo = buildRepository()
    const communityId = "cmt_story_royalty_derivative_onchain"
    const userId = "usr_author_story_derivative_onchain"
    const now = "2026-04-21T00:00:00.000Z"
    const parentIpId = "0x9999999999999999999999999999999999999999"
    const derivativeIpId = "0x3333333333333333333333333333333333333333"
    const derivativeVault = "0x4444444444444444444444444444444444444444"
    const coverArtRef = "https://media.test/derivative-cover.jpg"
    const derivativeRequests: Array<{
      nft: { recipient: string }
      derivData: { parentIpIds: string[]; licenseTermsIds: bigint[] }
      royaltyShares?: Array<{ recipient: string; percentage: number }>
    }> = []
    const metadataPayloads: Array<{ path: string; payload: unknown }> = []
    let attachCalls = 0

    await seedStoryCommunity({ env, repo, communityId, userId })
    setStoryRuntimeFundingAssertionForTests(async () => {})
    setStoryJsonMetadataPublisherForTests(async (input) => {
      metadataPayloads.push({ path: input.path, payload: input.payload })
      return {
        uri: `ipfs://metadata/${input.path}`,
        hash: "0x1111111111111111111111111111111111111111111111111111111111111111",
      }
    })
    setStoryRoyaltySdkClientFactoryForTests(() => ({
      ipAsset: {
        async registerDerivativeIpAsset(request) {
          derivativeRequests.push(request)
          return {
            ipId: derivativeIpId,
            tokenId: 456n,
            ipRoyaltyVault: derivativeVault,
            distributeRoyaltyTokensTxHash: "0xdddddddddddddddddddddddddddddddddddddddddddddddddddddddddddddddd",
          }
        },
        async registerIpAsset() {
          throw new Error("original registration should not run")
        },
      },
      license: {
        async registerPilTermsAndAttach() {
          attachCalls += 1
          throw new Error("derivative outbound license attachment should not run")
        },
      },
      royalty: {
        async getRoyaltyVaultAddress(ipId) {
          expect(ipId).toBe(derivativeIpId)
          return derivativeVault
        },
      },
    }))

    const db = await openCommunityDb(env, repo, communityId)
    try {
      const parentPost = await insertPost({
        client: db.client,
        communityId,
        authorUserId: userId,
        body: {
          post_type: "song",
          identity_mode: "public",
          title: "Parent song",
          idempotency_key: "story-derivative-onchain-parent",
          song_mode: "original",
          rights_basis: "original",
          access_mode: "public",
        },
        createdAt: now,
      })
      await db.client.execute({
        sql: `
          INSERT INTO assets (
            asset_id, community_id, source_post_id, song_artifact_bundle_id, creator_user_id, asset_kind,
            rights_basis, access_mode, license_preset, commercial_rev_share_pct,
            primary_content_ref, primary_content_hash, publication_status,
            story_status, story_error, story_ip_id, story_ip_nft_contract, story_ip_nft_token_id,
            story_publish_model, story_license_terms_id, story_license_template, story_royalty_policy,
            story_royalty_policy_id, story_derivative_parent_ip_ids_json, story_derivative_registered_at,
            story_revenue_token, story_royalty_registration_status, locked_delivery_status, locked_delivery_ref,
            locked_delivery_error, created_at, updated_at
          ) VALUES (
            ?1, ?2, ?3, NULL, ?4, 'song_audio',
            'original', 'public', 'commercial-remix', 10,
            ?5, ?6, 'story_published',
            'published', NULL, ?7, ?8, ?9,
            'story_ip_v1', ?10, NULL, ?11,
            ?11, NULL, NULL,
            ?12, 'registered', 'none', NULL,
            NULL, ?13, ?13
          )
        `,
        args: [
          "ast_derivative_onchain_parent",
          communityId,
          parentPost.post_id,
          userId,
          "filebase://songs/parent.wav",
          "0xabc123",
          parentIpId,
          "0x8888888888888888888888888888888888888888",
          "123",
          "17",
          "0x6666666666666666666666666666666666666666",
          "0x1514000000000000000000000000000000000000",
          now,
        ],
      })

      const result = await maybeRegisterStoryRoyaltyForAsset({
        env,
        client: db.client,
        communityId,
        assetId: "ast_derivative_onchain_child",
        creatorWalletAddress: testWallet,
        title: "Derivative child",
        rightsBasis: "derivative",
        licensePreset: "commercial-remix",
        commercialRevSharePct: 15,
        upstreamAssetRefs: ["story:asset:ast_derivative_onchain_parent"],
        assetKind: "song_audio",
        bundle: buildBundle({
          id: "sab_derivative_onchain_child",
          title: "Derivative child",
          contentHash: "0xdef456",
          coverArtRef,
        }),
        primaryContentHash: "0xdef456",
        royaltyShares: [
          { walletAddressNormalized: testWallet, shareBps: 9000, percentage: 90 },
          { walletAddressNormalized: "0xbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbb", shareBps: 1000, percentage: 10 },
        ],
      })

      expect(derivativeRequests).toHaveLength(1)
      expect(derivativeRequests[0]?.nft.recipient).toBe(testWallet)
      expect(derivativeRequests[0]?.derivData.parentIpIds).toEqual([parentIpId])
      expect(derivativeRequests[0]?.derivData.licenseTermsIds).toEqual([17n])
      expect(derivativeRequests[0]?.royaltyShares).toEqual([
        { recipient: testWallet, percentage: 90 },
        { recipient: "0xbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbb", percentage: 10 },
      ])
      expect(attachCalls).toBe(0)
      expect(metadataPayloads.find((entry) => entry.path.endsWith("/ip.json"))?.payload).toMatchObject({
        cover_art_ref: coverArtRef,
      })
      expect(metadataPayloads.find((entry) => entry.path.endsWith("/nft.json"))?.payload).toMatchObject({
        image: coverArtRef,
      })
      expect(result).toMatchObject({
        storyIpId: derivativeIpId,
        ipRoyaltyVault: derivativeVault,
        royaltyDistributionTxHash: "0xdddddddddddddddddddddddddddddddddddddddddddddddddddddddddddddddd",
        storyIpNftTokenId: "456",
        storyLicenseTermsId: null,
        storyDerivativeParentIpIds: [parentIpId],
        storyRoyaltyRegistrationStatus: "registered",
      })
    } finally {
      db.close()
    }
  })

  test("original registration records txHash when royalty shares are folded into the mint tx", async () => {
    const rootDir = await mkdtemp(join(tmpdir(), "pirate-story-royalty-original-shares-"))
    cleanupPaths.push(rootDir)

    const env = {
      LOCAL_COMMUNITY_DB_ROOT: rootDir,
      STORY_ROYALTY_SPG_NFT_CONTRACT: "0x8888888888888888888888888888888888888888",
      STORY_OPERATOR_PRIVATE_KEY: "0x0000000000000000000000000000000000000000000000000000000000000001",
    } as Env
    const repo = buildRepository()
    const communityId = "cmt_story_royalty_original_shares"
    const userId = "usr_author_story_original_shares"
    const originalIpId = "0x3333333333333333333333333333333333333333"
    const originalVault = "0x4444444444444444444444444444444444444444"
    const originalTx = "0xaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaa"
    const originalRequests: Array<{
      nft: { recipient: string }
      royaltyShares?: Array<{ recipient: string; percentage: number }>
    }> = []

    await seedStoryCommunity({ env, repo, communityId, userId })
    setStoryRuntimeFundingAssertionForTests(async () => {})
    setStoryJsonMetadataPublisherForTests(async (input) => ({
      uri: `ipfs://metadata/${input.path}`,
      hash: "0x1111111111111111111111111111111111111111111111111111111111111111",
    }))
    setStoryRoyaltySdkClientFactoryForTests(() => ({
      ipAsset: {
        async registerDerivativeIpAsset() {
          throw new Error("derivative registration should not run")
        },
        async registerIpAsset(request) {
          originalRequests.push(request)
          return {
            ipId: originalIpId,
            tokenId: 123n,
            txHash: originalTx,
            ipRoyaltyVault: originalVault,
            licenseTermsIds: [17n],
          }
        },
      },
      royalty: {
        async getRoyaltyVaultAddress(ipId) {
          expect(ipId).toBe(originalIpId)
          return originalVault
        },
      },
    }))

    const db = await openCommunityDb(env, repo, communityId)
    try {
      const result = await maybeRegisterStoryRoyaltyForAsset({
        env,
        client: db.client,
        communityId,
        assetId: "ast_original_shares",
        creatorWalletAddress: testWallet,
        title: "Original shares",
        rightsBasis: "original",
        licensePreset: "commercial-remix",
        commercialRevSharePct: 10,
        upstreamAssetRefs: null,
        assetKind: "song_audio",
        bundle: buildBundle({ id: "sab_original_shares", title: "Original shares" }),
        primaryContentHash: "0xabc123",
        royaltyShares: [
          { walletAddressNormalized: testWallet, shareBps: 6667, percentage: 66.67 },
          { walletAddressNormalized: "0xbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbb", shareBps: 3333, percentage: 33.33 },
        ],
      })

      expect(originalRequests).toHaveLength(1)
      expect(originalRequests[0]?.nft.recipient).toBe(testWallet)
      expect(originalRequests[0]?.royaltyShares).toEqual([
        { recipient: testWallet, percentage: 66.67 },
        { recipient: "0xbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbb", percentage: 33.33 },
      ])
      expect(result).toMatchObject({
        storyIpId: originalIpId,
        ipRoyaltyVault: originalVault,
        royaltyDistributionTxHash: originalTx,
        storyLicenseTermsId: "17",
        storyRoyaltyRegistrationStatus: "registered",
      })
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
              async setIdentityWallet() {
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
    const configMissingControlPlane = await createControlPlaneTestClient({ includeAllMigrations: true })
    const configMissingEnv = {
      ENVIRONMENT: "test",
      LOCAL_COMMUNITY_DB_ROOT: configMissingRootDir,
      CONTROL_PLANE_DATABASE_URL: `file:${configMissingControlPlane.databasePath}`,
    } as Env
    const configMissingCommunityId = "cmt_story_royalty_config_missing"
    const configMissingUserId = "usr_author_story_config_missing"
    try {
      await seedControlPlaneCommunityForProjection({
        client: configMissingControlPlane.client,
        communityId: configMissingCommunityId,
        userId: configMissingUserId,
        now: "2026-04-21T00:00:00.000Z",
      })
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
    } finally {
      await configMissingControlPlane.cleanup()
    }

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
          client: { execute: tx.execute.bind(tx), transaction: db.client.transaction.bind(db.client) },
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
      expect((caughtError as Error).message).toContain(
        "This asset could not be published because Story registration is not configured",
      )

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

  test("rolls back before Story registration when the runtime signer is underfunded", async () => {
    const rootDir = await mkdtemp(join(tmpdir(), "pirate-story-royalty-funding-"))
    cleanupPaths.push(rootDir)

    const env = {
      LOCAL_COMMUNITY_DB_ROOT: rootDir,
      STORY_ROYALTY_SPG_NFT_CONTRACT: "0x1111111111111111111111111111111111111111",
      STORY_OPERATOR_PRIVATE_KEY: "0x0000000000000000000000000000000000000000000000000000000000000001",
    } as Env
    const repo = buildRepository()
    const communityId = "cmt_story_royalty_underfunded"
    const userId = "usr_author_story_underfunded"
    const now = "2026-04-21T00:00:00.000Z"
    const assetId = "ast_underfunded_story_registration"
    let postId: string | null = null
    let fundingAssertionNames: string[] = []

    setStoryRuntimeFundingAssertionForTests(async (_env, names) => {
      fundingAssertionNames = [...names]
      throw new Error(
        "Story runtime signer funding below floor: story-operator:0xc77Ad4de7d179FFFBa417cA24c055d86Af69F4BB:0.098<0.25",
      )
    })

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
            title: "Underfunded Story song",
            idempotency_key: "underfunded-story-registration-post",
            song_mode: "original",
            rights_basis: "original",
            access_mode: "public",
          },
          createdAt: now,
        })
        postId = post.post_id

        await createSongAssetForPost({
          env,
          client: { execute: tx.execute.bind(tx), transaction: db.client.transaction.bind(db.client) },
          communityId,
          post: {
            ...post,
            asset_id: assetId,
          },
          bundle: buildBundle({ id: "sab_underfunded_story_registration", title: "Underfunded Story song" }),
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

      expect(fundingAssertionNames).toEqual(["story-operator"])
      expect(caughtError).toBeInstanceOf(Error)
      // Operator funding below floor is not user-retryable — the message must say
      // so (no "try again") and must never leak raw wallet/balance detail.
      expect((caughtError as Error).message).toContain("operator funding issue")
      expect((caughtError as Error).message).not.toContain("try again")
      expect((caughtError as Error).message).not.toContain("funding below floor")
      expect((caughtError as Error).message).not.toContain("0xc77Ad4de")

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
          client: { execute: tx.execute.bind(tx), transaction: db.client.transaction.bind(db.client) },
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
          async setIdentityWallet() {
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
    const controlPlane = await createControlPlaneTestClient({ includeAllMigrations: true })

    const env = {
      ENVIRONMENT: "test",
      LOCAL_COMMUNITY_DB_ROOT: rootDir,
      CONTROL_PLANE_DATABASE_URL: `file:${controlPlane.databasePath}`,
    } as Env
    const repo = buildRepository()
    const communityId = "cmt_story_royalty_registered"
    const userId = "usr_author_story_registered"
    const now = "2026-04-21T00:00:00.000Z"
    try {
      await seedControlPlaneCommunityForProjection({
        client: controlPlane.client,
        communityId,
        userId,
        now,
      })
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
            async setIdentityWallet() {
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

      const projectedSources = await listStoryRegisteredAssetProjectionRows({
        env,
        kind: "song",
        query: "Registered",
        limit: 25,
      })
      expect(projectedSources).toHaveLength(1)
      expect(projectedSources[0]).toMatchObject({
        asset_id: "ast_registered_source_song",
        community_id: communityId,
        display_title: "Registered source song",
        creator_user_id: userId,
        asset_kind: "song_audio",
        license_preset: "commercial-remix",
        commercial_rev_share_pct: 15,
        story_ip_id: "0x9999999999999999999999999999999999999999",
        story_license_terms_id: "17",
      })
    } finally {
      await controlPlane.cleanup()
    }
  })

  test("uses derivative source asset refs to register remix parents without listing unattached derivatives as sources", async () => {
    const rootDir = await mkdtemp(join(tmpdir(), "pirate-story-royalty-remix-source-"))
    cleanupPaths.push(rootDir)
    const controlPlane = await createControlPlaneTestClient({ includeAllMigrations: true })

    const env = {
      ENVIRONMENT: "test",
      LOCAL_COMMUNITY_DB_ROOT: rootDir,
      CONTROL_PLANE_DATABASE_URL: `file:${controlPlane.databasePath}`,
    } as Env
    const repo = buildRepository()
    const communityId = "cmt_story_royalty_remix_source"
    const userId = "usr_author_story_remix_source"
    const now = "2026-04-21T00:00:00.000Z"
    const parentIpId = "0x9999999999999999999999999999999999999999"
    const derivativeIpId = "0x3333333333333333333333333333333333333333"
    try {
    await seedControlPlaneCommunityForProjection({
      client: controlPlane.client,
      communityId,
      userId,
      now,
    })
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
          storyLicenseTermsId: null,
          storyLicenseTemplate: null,
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
        licensePreset: "commercial-remix",
        commercialRevSharePct: 15,
        userRepository,
      })
      derivativeAssetId = derivative.id

      expect(derivative.publication_status).toBe("story_published")
      expect(derivative.story_status).toBe("published")
      expect(derivative.story_royalty_registration_status).toBe("registered")
      expect(derivative.story_ip).toBe(derivativeIpId)
      expect(derivative.story_license_terms).toBeNull()
      expect(derivative.license_preset).toBeNull()
      expect(derivative.commercial_rev_share_pct).toBeNull()
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
    expect(derivativeSources.items.map((source) => source.asset)).not.toContain(derivativeAssetId)
    } finally {
      await controlPlane.cleanup()
    }
  })

  test("uses a remix source Story ref when registering a remix of a remix", async () => {
    const rootDir = await mkdtemp(join(tmpdir(), "pirate-story-royalty-remix-chain-"))
    cleanupPaths.push(rootDir)
    const controlPlane = await createControlPlaneTestClient({ includeAllMigrations: true })

    const env = {
      ENVIRONMENT: "test",
      LOCAL_COMMUNITY_DB_ROOT: rootDir,
      CONTROL_PLANE_DATABASE_URL: `file:${controlPlane.databasePath}`,
    } as Env
    const repo = buildRepository()
    const communityId = "cmt_story_royalty_remix_chain"
    const userId = "usr_author_story_remix_chain"
    const now = "2026-04-21T00:00:00.000Z"
    const originalIpId = "0xaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaa"
    const firstRemixIpId = "0xbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbb"
    const secondRemixIpId = "0xcccccccccccccccccccccccccccccccccccccccc"
    try {
    await seedControlPlaneCommunityForProjection({
      client: controlPlane.client,
      communityId,
      userId,
      now,
    })
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
    } finally {
      await controlPlane.cleanup()
    }
  })
})
