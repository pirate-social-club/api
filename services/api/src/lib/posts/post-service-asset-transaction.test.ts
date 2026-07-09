import { afterEach, describe, expect, mock, test } from "bun:test"
import { createClient } from "@libsql/client"
import { existsSync, unlinkSync } from "node:fs"

import type { Env } from "../../env"
// Snapshotted BEFORE the mock.module() calls below. bun's mock.module is
// process-global and sticky (it never auto-restores), so this file's
// openCommunityDb mock leaks into every later test file. Capturing the real
// module here lets the mock delegate back to it whenever it is reached without
// an activeClient configured — i.e. from another test file (e.g. the karaoke
// policy tests, which reach openCommunityDb through the d1-aware clients).
import * as realCommunityDbFactory from "../communities/community-db-factory"
import * as realCommunityCreateRepository from "../communities/create/repository"
import * as realCommunityCreateShared from "../communities/create/shared"
import * as realPostCreatePreparation from "./post-create-preparation"
import * as realSongArtifactPostResolution from "../song-artifacts/song-artifact-post-resolution-service"
const realCommunityDbFactorySnapshot = { ...realCommunityDbFactory }
const realCommunityCreateRepositorySnapshot = { ...realCommunityCreateRepository }
const realCommunityCreateSharedSnapshot = { ...realCommunityCreateShared }
const realPostCreatePreparationSnapshot = { ...realPostCreatePreparation }
const realSongArtifactPostResolutionSnapshot = { ...realSongArtifactPostResolution }

type TestClient = ReturnType<typeof createClient>

let activeClient: TestClient | null = null
let events: string[] = []
const communityDbFactoryModule = "../communities/community-db-factory"
const communityDbFactoryUrl = new URL("../communities/community-db-factory.ts", import.meta.url)
const communityDbFactoryPath = communityDbFactoryUrl.pathname
const communityCreateRepositoryModule = "../communities/create/repository"
const communityCreateRepositoryUrl = new URL("../communities/create/repository.ts", import.meta.url)
const communityCreateRepositoryPath = communityCreateRepositoryUrl.pathname
const communityCreateSharedModule = "../communities/create/shared"
const communityCreateSharedUrl = new URL("../communities/create/shared.ts", import.meta.url)
const communityCreateSharedPath = communityCreateSharedUrl.pathname
const postCreatePreparationModule = "./post-create-preparation"
const postCreatePreparationUrl = new URL("./post-create-preparation.ts", import.meta.url)
const postCreatePreparationPath = postCreatePreparationUrl.pathname
const songArtifactPostResolutionModule = "../song-artifacts/song-artifact-post-resolution-service"
const songArtifactPostResolutionUrl = new URL(
  "../song-artifacts/song-artifact-post-resolution-service.ts",
  import.meta.url,
)
const songArtifactPostResolutionPath = songArtifactPostResolutionUrl.pathname

function wrapClient(client: TestClient): TestClient {
  return {
    execute: client.execute.bind(client),
    batch: client.batch.bind(client),
    transaction: async (mode?: "read" | "write") => {
      const tx = await client.transaction(mode)
      return {
        execute: tx.execute.bind(tx),
        batch: tx.batch.bind(tx),
        commit: async () => {
          events.push("tx:commit")
          await tx.commit()
        },
        rollback: async () => {
          events.push("tx:rollback")
          await tx.rollback()
        },
        close: () => {
          events.push("tx:close")
          tx.close()
        },
      }
    },
    close: client.close.bind(client),
  } as TestClient
}

// bun >=1.3 evaluates a mock.module factory ONCE at registration time — when
// activeClient is still null — so a factory-level `activeClient == null ?
// real : fake` branch permanently bakes in the real module. The branch must
// happen inside each exported function (call time). Delegating to the real
// snapshot whenever no activeClient is configured also keeps these sticky,
// process-global mocks harmless to later test files in the same run.
function switchByActiveClient<T extends Record<string, unknown>>(real: T, fake: Record<string, unknown>): () => T {
  const merged: Record<string, unknown> = { ...real }
  for (const [key, fakeValue] of Object.entries(fake)) {
    if (typeof fakeValue !== "function") {
      merged[key] = fakeValue
      continue
    }
    const realValue = (real as Record<string, unknown>)[key]
    merged[key] = (...args: unknown[]) => {
      if (activeClient == null && typeof realValue === "function") {
        return (realValue as (...a: unknown[]) => unknown)(...args)
      }
      return (fakeValue as (...a: unknown[]) => unknown)(...args)
    }
  }
  const moduleExports = merged as T
  return () => moduleExports
}

const communityDbFactoryMock = () => ({
  ...realCommunityDbFactorySnapshot,
  openCommunityDb: async (...args: Parameters<typeof realCommunityDbFactory.openCommunityDb>) => {
    if (!activeClient) {
      // Reached from another test file; use the real implementation so the
      // sticky mock does not break it.
      return realCommunityDbFactorySnapshot.openCommunityDb(...args)
    }
    return {
      client: wrapClient(activeClient),
      close: () => {},
      databaseUrl: "file::memory:",
    }
  },
})

mock.module(communityDbFactoryModule, communityDbFactoryMock)
mock.module(communityDbFactoryPath, communityDbFactoryMock)
mock.module(communityDbFactoryUrl.href, communityDbFactoryMock)

const fakeCommunityCreateRepository = {
  assertPublicV0GateConfiguration: () => {},
  assertUpdateCommunityGatesRequest: () => {},
  assertUpdateCommunityLabelPolicyRequest: () => {},
  assertUpdateCommunityReferenceLinksRequest: () => {},
  assertUpdateCommunityRequest: () => {},
  assertUpdateCommunitySafetyRequest: () => {},
  assertUpdateCommunityVisualPolicyRequest: () => {},
  bootstrapCommunityLocalSnapshot: async () => {},
  buildLocalCommunityBootstrapInput: () => ({}),
  localCommunityShardStatements: () => [],
  buildBootstrapGatePolicy: () => null,
  buildBootstrapInitialSettings: () => ({}),
  buildBootstrapRules: () => [],
  buildPendingD1CommunityBindingUrl: (communityId: string) => `d1://pending-${communityId}.invalid`,
  isPendingD1CommunityBindingUrl: () => false,
  communityMutationActorFromUserId: (userId: string) => ({
    userId,
    authType: "user",
  }),
  isExpired: () => false,
  loadCommunityLocalSnapshot: async () => null,
  loadCommunityProjection: async (_env: Env, _repo: unknown, communityRow: { community_id: string }) => ({
    community_id: communityRow.community_id,
    display_name: "Test Community",
    status: "active",
    provisioning_state: "active",
    membership_mode: "open",
    allow_anonymous_identity: false,
    human_verification_lane: "self",
    human_verification_lane_origin: "derived",
    agent_posting_policy: "disallow",
    guest_comment_policy: "disallow",
    agent_posting_scope: "replies_only",
    accepted_agent_ownership_providers: [],
    accepted_agent_ownership_providers_origin: "derived",
    donation_policy_mode: "none",
    label_policy: null,
    default_age_gate_policy: "none",
  }),
  normalizeDonationPolicyMode: () => "none",
  normalizeInputRules: () => [],
  parseCommunitySettingsJson: () => ({}),
  parseEndaomentLookupTerm: () => null,
  requireAdminOverrideOrOwnedCommunity: async () => ({
    community_id: "cmt_test",
    status: "active",
    provisioning_state: "active",
  }),
  requireOwnedCommunity: async () => ({
    community_id: "cmt_test",
    status: "active",
    provisioning_state: "active",
  }),
  selectEndaomentOrganizationMatch: () => null,
  resolveCommunityDbRoot: () => "/tmp",
  resolveProvisioningRetryAction: async () => ({ action: "return_existing" }),
}
const communityCreateRepositoryMock = switchByActiveClient(
  realCommunityCreateRepositorySnapshot,
  fakeCommunityCreateRepository,
)
const communityCreateSharedMock = switchByActiveClient(
  realCommunityCreateSharedSnapshot,
  fakeCommunityCreateRepository,
)

mock.module(communityCreateRepositoryModule, communityCreateRepositoryMock)
mock.module(communityCreateRepositoryPath, communityCreateRepositoryMock)
mock.module(communityCreateRepositoryUrl.href, communityCreateRepositoryMock)
mock.module(communityCreateSharedModule, communityCreateSharedMock)
mock.module(communityCreateSharedPath, communityCreateSharedMock)
mock.module(communityCreateSharedUrl.href, communityCreateSharedMock)

const postCreatePreparationMock = switchByActiveClient(realPostCreatePreparationSnapshot, {
  preparePostCreate: async (input: { body: Record<string, unknown> }) => {
    const analysisOverride = {
      analysis_state: "allow",
      content_safety_state: "safe",
      age_gate_policy: "none",
      status: "published",
    }
    if (input.body.post_type === "song") {
      return {
        writeBody: {
          ...input.body,
          identity_mode: "public",
          access_mode: "locked",
          asset_id: "ast_post_commit_song",
          rights_basis: "original",
          media_refs: [],
          song_artifact_bundle: "sab_sab_post_commit_bundle",
          song_title: "Post Commit Song",
        },
        analysisProviderResult: null,
        analysisOverride,
        resolvedSongBundleForAsset: {
          analysisState: "allow",
          contentSafetyState: "safe",
          ageGatePolicy: "none",
          mediaRefs: [],
          lyrics: null,
          bundle: {
            id: "sab_post_commit_bundle",
            title: "Post Commit Song",
            genius_annotations_url: null,
            cover_art: null,
            primary_audio: {
              storage_ref: "filebase://song.mp3",
              mime_type: "audio/mpeg",
              content_hash: "0xsong",
              duration_ms: 120000,
            },
            preview_audio: null,
            instrumental_audio: null,
            vocal_audio: null,
          },
        },
        resolvedVideoAsset: null,
      }
    }
    return {
      writeBody: {
        ...input.body,
        identity_mode: "public",
        access_mode: "locked",
        asset_id: "ast_post_commit_video",
        rights_basis: "original",
        media_refs: [{
          storage_ref: "https://cdn.example/video.mp4",
          mime_type: "video/mp4",
          media_kind: "video",
          width: 640,
          height: 360,
          duration_seconds: 12,
        }],
      },
      analysisProviderResult: null,
      analysisOverride,
      resolvedSongBundleForAsset: null,
      resolvedVideoAsset: {
        upload: {
          id: "upl_video",
          gateway_url: "https://cdn.example/video.mp4",
          storage_ref: "filebase://video.mp4",
          mime_type: "video/mp4",
          content_hash: "0xvideo",
        },
        previewUpload: null,
        mediaRefs: [],
      },
    }
  },
})

mock.module(postCreatePreparationModule, postCreatePreparationMock)
mock.module(postCreatePreparationPath, postCreatePreparationMock)
mock.module(postCreatePreparationUrl.href, postCreatePreparationMock)

const songArtifactPostResolutionMock = switchByActiveClient(realSongArtifactPostResolutionSnapshot, {
  consumeSongPostBundle: async () => {},
  resolveSongPostBundle: async () => ({
    analysisState: "allow",
    contentSafetyState: "safe",
    ageGatePolicy: "none",
    mediaRefs: [],
    lyrics: null,
    bundle: {
      id: "sab_post_commit_bundle",
      title: "Post Commit Song",
      genius_annotations_url: null,
      cover_art: null,
      primary_audio: {
        storage_ref: "filebase://song.mp3",
        mime_type: "audio/mpeg",
        content_hash: "0xsong",
        duration_ms: 120000,
      },
      preview_audio: null,
      instrumental_audio: null,
      vocal_audio: null,
    },
  }),
  resolveVideoPostAsset: async () => ({
    upload: {
      id: "upl_video",
      gateway_url: "https://cdn.example/video.mp4",
      storage_ref: "filebase://video.mp4",
      mime_type: "video/mp4",
      content_hash: "0xvideo",
    },
    previewUpload: null,
    mediaRefs: [],
  }),
})

mock.module(songArtifactPostResolutionModule, songArtifactPostResolutionMock)
mock.module(songArtifactPostResolutionPath, songArtifactPostResolutionMock)
mock.module(songArtifactPostResolutionUrl.href, songArtifactPostResolutionMock)

const clients: TestClient[] = []
const dbPaths: string[] = []

function createTestClient(label: string): TestClient {
  const path = `/tmp/post-service-asset-transaction-${label}-${crypto.randomUUID()}.sqlite`
  dbPaths.push(path)
  return createClient({ url: `file:${path}` })
}

type PostCommunityWriteOpenerForTest = (
  env: Parameters<typeof realCommunityDbFactory.openCommunityDb>[0],
  repo: Parameters<typeof realCommunityDbFactory.openCommunityDb>[1],
  communityId: string,
) => ReturnType<typeof realCommunityDbFactory.openCommunityDb>

function postCommunityWriteOpener(): PostCommunityWriteOpenerForTest {
  return async (...args) => {
    if (!activeClient) {
      return await realCommunityDbFactorySnapshot.openCommunityDb(...args)
    }
    return {
      client: wrapClient(activeClient),
      close: () => {},
      databaseUrl: "file::memory:",
    }
  }
}

afterEach(async () => {
  const { setPostAssetCreatorsForTests, setPostCommunityWriteOpenerForTests } = await import("./post-service")
  setPostAssetCreatorsForTests(null)
  setPostCommunityWriteOpenerForTests(null)
  activeClient = null
  events = []
  for (const client of clients.splice(0)) {
    client.close()
  }
  for (const path of dbPaths.splice(0)) {
    if (existsSync(path)) {
      unlinkSync(path)
    }
  }
})

async function createPostTables(client: TestClient): Promise<void> {
  await client.execute(`
    CREATE TABLE posts (
      post_id TEXT PRIMARY KEY,
      community_id TEXT NOT NULL,
      author_user_id TEXT,
      authorship_mode TEXT NOT NULL,
      agent_id TEXT,
      agent_ownership_record_id TEXT,
      identity_mode TEXT NOT NULL,
      anonymous_scope TEXT,
      anonymous_label TEXT,
      agent_display_name_snapshot TEXT,
      agent_owner_handle_snapshot TEXT,
      agent_ownership_provider_snapshot TEXT,
      agent_handle_snapshot TEXT,
      disclosed_qualifiers_json TEXT,
      label_id TEXT,
      label_assignment_status TEXT,
      label_assigned_by TEXT,
      label_assigned_at TEXT,
      label_ai_confidence REAL,
      label_assignment_error TEXT,
      label_assignment_model TEXT,
      label_assignment_result_json TEXT,
      post_type TEXT NOT NULL,
      status TEXT NOT NULL,
      comments_locked INTEGER NOT NULL DEFAULT 0,
      comments_locked_at TEXT,
      comments_locked_by_user_id TEXT,
      comments_lock_reason TEXT,
      visibility TEXT NOT NULL,
      title TEXT,
      body TEXT,
      caption TEXT,
      lyrics TEXT,
      link_url TEXT,
      link_og_image_url TEXT,
      link_og_title TEXT,
      link_enrichment_snapshot_json TEXT,
      link_enrichment_synced_at TEXT,
      embeds_json TEXT,
      media_refs_json TEXT,
      song_artifact_bundle_id TEXT,
      song_title TEXT,
      song_annotations_url TEXT,
      song_cover_art_ref TEXT,
      song_duration_ms INTEGER,
      source_language TEXT,
      translation_policy TEXT,
      access_mode TEXT,
      asset_id TEXT,
      parent_post_id TEXT,
      crosspost_source_json TEXT,
      upstream_asset_refs_json TEXT,
      song_mode TEXT,
      rights_basis TEXT,
      analysis_state TEXT NOT NULL,
      analysis_result_ref TEXT,
      content_safety_state TEXT NOT NULL,
      age_gate_policy TEXT NOT NULL,
      idempotency_key TEXT,
      created_at TEXT NOT NULL,
      updated_at TEXT NOT NULL
    )
  `)
  await client.execute(`
    CREATE TABLE live_rooms (
      live_room_id TEXT PRIMARY KEY,
      anchor_post_id TEXT,
      status TEXT NOT NULL DEFAULT 'open',
      visibility TEXT NOT NULL DEFAULT 'public'
    )
  `)
}

describe("createPost", () => {
  test("creates video assets after the post transaction commits", async () => {
    const client = createTestClient("video")
    clients.push(client)
    activeClient = client
    await createPostTables(client)

    const { createPost, setPostAssetCreatorsForTests, setPostCommunityWriteOpenerForTests } = await import("./post-service")
    setPostCommunityWriteOpenerForTests(postCommunityWriteOpener())
    setPostAssetCreatorsForTests({
      createAssetForPost: async (input) => {
        events.push("asset:create")
        expect(events).toContain("tx:commit")
        expect(events).toContain("tx:close")
        expect(input.client).not.toHaveProperty("commit")
        await input.client.execute("SELECT 1")
        return {
          asset_id: input.post.asset_id,
          community_id: input.communityId,
          source_post_id: input.post.post_id,
          display_title: null,
          song_artifact_bundle_id: null,
          creator_user_id: input.post.author_user_id ?? "",
          asset_kind: "video_file",
          rights_basis: "original",
          access_mode: "locked",
          license_preset: null,
          commercial_rev_share_pct: null,
          primary_content_ref: input.storageRef,
          primary_content_hash: input.contentHash,
          publication_status: "draft",
          story_status: "none",
          story_error: null,
          story_ip_id: null,
          story_ip_nft_contract: null,
          story_ip_nft_token_id: null,
          ip_royalty_vault: null,
          story_publish_model: "pirate_v1",
          story_license_terms_id: null,
          story_license_template: null,
          story_royalty_policy: null,
          story_royalty_policy_id: null,
          story_derivative_parent_ip_ids_json: null,
          story_derivative_registered_at: null,
          story_revenue_token: null,
          story_royalty_registration_status: "none",
          locked_delivery_status: "none",
          locked_delivery_ref: null,
          locked_delivery_error: null,
          locked_delivery_storage_ref: null,
          locked_delivery_secret_json: null,
          story_publish_tx_ref: null,
          story_asset_version_id: null,
          story_cdr_vault_uuid: null,
          story_namespace: null,
          story_entitlement_token_id: null,
          story_read_condition: null,
          story_write_condition: null,
          created_at: new Date(0).toISOString(),
          updated_at: new Date(0).toISOString(),
        } as never
      },
    })

    const projectionCalls: unknown[] = []
    const post = await createPost({
      env: { ENVIRONMENT: "test" } as Env,
      requestUrl: "https://api.example.test/communities/cmt_test/posts",
      userId: "usr_author",
      communityId: "cmt_test",
      bypassAuthorAccessChecks: true,
      body: {
        post_type: "video",
        idempotency_key: "video-post-commit-asset",
        access_mode: "locked",
        license_preset: "non-commercial",
        media_refs: [{
          storage_ref: "filebase://video.mp4",
          mime_type: "video/mp4",
        }],
        rights_basis: "original",
      },
      userRepository: {} as never,
      profileRepository: {} as never,
      communityRepository: {
        async getCommunityById() {
          return {
            community_id: "cmt_test",
            display_name: "Test Community",
            status: "active",
            provisioning_state: "active",
          }
        },
        async getPrimaryCommunityDatabaseBinding() {
          return null
        },
        async recordCommunityPostProjection(input: unknown) {
          projectionCalls.push(input)
        },
        async getCommunityPostProjectionByPostId() {
          return null
        },
      } as never,
    })

    expect(post.post_type).toBe("video")
    expect(post.asset_id).toBe("ast_post_commit_video")
    expect(events).toEqual(["tx:commit", "tx:close", "asset:create"])
    expect(projectionCalls).toHaveLength(1)
  })

  test("creates song assets after the post transaction commits", async () => {
    const client = createTestClient("song")
    clients.push(client)
    activeClient = client
    await createPostTables(client)

    const { createPost, setPostAssetCreatorsForTests, setPostCommunityWriteOpenerForTests } = await import("./post-service")
    setPostCommunityWriteOpenerForTests(postCommunityWriteOpener())
    setPostAssetCreatorsForTests({
      createSongAssetForPost: async (input) => {
        events.push("asset:create")
        expect(events).toContain("tx:commit")
        expect(events).toContain("tx:close")
        expect(input.client).not.toHaveProperty("commit")
        expect(input.bundle.id).toBe("sab_post_commit_bundle")
        await input.client.execute("SELECT 1")
        return {} as never
      },
    })

    const projectionCalls: unknown[] = []
    const post = await createPost({
      env: { ENVIRONMENT: "test" } as Env,
      requestUrl: "https://api.example.test/communities/cmt_test/posts",
      userId: "usr_author",
      communityId: "cmt_test",
      bypassAuthorAccessChecks: true,
      body: {
        post_type: "song",
        identity_mode: "public",
        idempotency_key: "song-post-commit-asset",
        song_artifact_bundle: "sab_sab_post_commit_bundle",
        access_mode: "locked",
        license_preset: "non-commercial",
        rights_basis: "original",
      },
      userRepository: {} as never,
      profileRepository: {} as never,
      communityRepository: {
        async getCommunityById() {
          return {
            community_id: "cmt_test",
            display_name: "Test Community",
            status: "active",
            provisioning_state: "active",
          }
        },
        async getPrimaryCommunityDatabaseBinding() {
          return null
        },
        async recordCommunityPostProjection(input: unknown) {
          projectionCalls.push(input)
        },
        async getCommunityPostProjectionByPostId() {
          return null
        },
      } as never,
    })

    expect(post.post_type).toBe("song")
    expect(post.asset_id).toBe("ast_post_commit_song")
    expect(events).toEqual(["tx:commit", "tx:close", "asset:create"])
    expect(projectionCalls).toHaveLength(1)
  })
})
