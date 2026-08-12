import { SQL } from "bun"
import { afterAll, beforeAll, describe, expect, test } from "bun:test"
import type { Env } from "../../env"
import {
  getControlPlaneClient,
  setControlPlanePostgresPoolFactoryForTests,
  withRequestControlPlaneClients,
} from "../runtime-deps"
import {
  beginProxyContentUpload,
  createContentBlobIntent,
  markProxyContentBlobUploaded,
  requireOwnedContentBlob,
} from "./content-blob-repository"

const ADMIN_URL = process.env.BOOKINGS_REPO_TEST_ADMIN_URL
const RUN = Boolean(ADMIN_URL)
const TEST_DB = "content_blob_repository_test"
const PG_ENV = {
  CONTROL_PLANE_DATABASE_URL: `postgres://content-blob@localhost:5432/${TEST_DB}`,
} as unknown as Env

function urlFor(database?: string): string {
  const url = new URL(ADMIN_URL as string)
  if (database) url.pathname = `/${database}`
  if (!url.searchParams.get("sslmode")) url.searchParams.set("sslmode", "disable")
  return url.toString()
}

function connect(database?: string): SQL {
  return new SQL({
    connectionTimeout: 5,
    max: 1,
    tls: false,
    url: urlFor(database),
  } as Record<string, unknown>)
}

describe.skipIf(!RUN)("content blob repository (real Postgres)", () => {
  let database: SQL

  beforeAll(async () => {
    const root = connect()
    await root.unsafe(`DROP DATABASE IF EXISTS ${TEST_DB} WITH (FORCE)`)
    await root.unsafe(`CREATE DATABASE ${TEST_DB}`)
    await root.end()

    database = connect(TEST_DB)
    await database.unsafe(`
      CREATE TABLE content_blobs (
        content_blob_id TEXT PRIMARY KEY,
        community_id TEXT NOT NULL,
        uploader_user_id TEXT NOT NULL,
        status TEXT NOT NULL,
        validation_profile TEXT NOT NULL,
        declared_filename TEXT,
        declared_mime_type TEXT NOT NULL,
        declared_size_bytes BIGINT,
        declared_content_hash TEXT,
        detected_mime_type TEXT,
        verified_size_bytes BIGINT,
        verified_content_hash TEXT,
        security_scan_state TEXT NOT NULL DEFAULT 'pending',
        plaintext_retention_state TEXT NOT NULL DEFAULT 'active',
        storage_ref TEXT NOT NULL UNIQUE,
        storage_provider TEXT,
        storage_bucket TEXT,
        storage_object_key TEXT,
        storage_endpoint TEXT,
        gateway_url TEXT,
        ipfs_cid TEXT,
        rejection_code TEXT,
        created_at TIMESTAMPTZ NOT NULL,
        updated_at TIMESTAMPTZ NOT NULL
      );
      CREATE TABLE content_upload_sessions (
        content_upload_session_id TEXT PRIMARY KEY,
        content_blob_id TEXT NOT NULL REFERENCES content_blobs(content_blob_id) ON DELETE CASCADE,
        uploader_user_id TEXT NOT NULL,
        status TEXT NOT NULL,
        upload_mode TEXT NOT NULL,
        object_key TEXT NOT NULL,
        provider_upload_id TEXT,
        part_size_bytes INTEGER,
        total_parts INTEGER,
        bucket TEXT NOT NULL,
        storage_endpoint TEXT NOT NULL,
        expires_at TIMESTAMPTZ NOT NULL,
        created_at TIMESTAMPTZ NOT NULL,
        updated_at TIMESTAMPTZ NOT NULL,
        completed_at TIMESTAMPTZ,
        aborted_at TIMESTAMPTZ,
        aborted_reason TEXT
      );
    `)
  })

  afterAll(async () => {
    setControlPlanePostgresPoolFactoryForTests(null)
    if (database) await database.end()
    const root = connect()
    await root.unsafe(`DROP DATABASE IF EXISTS ${TEST_DB} WITH (FORCE)`).catch(() => {})
    await root.end()
  })

  test("creates and atomically completes a proxy upload", async () => {
    setControlPlanePostgresPoolFactoryForTests(() => {
      const query = async (sql: string, values?: unknown[]) => {
        const isUpdate = /^\s*UPDATE\b/i.test(sql)
        const statement = isUpdate ? `${sql} RETURNING 1 AS affected` : sql
        const rows = await database.unsafe(statement, values ?? []) as Record<string, unknown>[]
        return { rowCount: isUpdate ? rows.length : null, rows }
      }
      return {
        connect: async () => ({ query, release: () => {} }),
        end: async () => {},
        query,
      }
    })

    try {
      await withRequestControlPlaneClients(async () => {
        const client = getControlPlaneClient(PG_ENV)
        const now = "2026-08-12T00:00:00.000Z"
        const created = await createContentBlobIntent({
          client,
          intent: {
            contentBlobId: "cbl_repository_fixture",
            contentUploadSessionId: "cus_repository_fixture",
            communityId: "community_fixture",
            uploaderUserId: "user_fixture",
            validationProfile: "download_file_v1",
            declaredFilename: "records.csv",
            declaredMimeType: "text/csv",
            declaredSizeBytes: 12,
            declaredContentHash: null,
            storageRef: "https://api.example/content",
            uploadMode: "proxy",
            objectKey: "content-blobs/community_fixture/cbl_repository_fixture/payload",
            providerUploadId: null,
            partSizeBytes: null,
            totalParts: null,
            bucket: "fixture-bucket",
            storageEndpoint: "https://s3.example",
            expiresAt: "2026-08-12T01:00:00.000Z",
            createdAt: now,
          },
        })
        expect(created.blob.status).toBe("pending_upload")
        expect(created.uploadSession?.status).toBe("created")

        expect(await beginProxyContentUpload({
          client,
          communityId: "community_fixture",
          uploaderUserId: "user_fixture",
          contentBlobId: "cbl_repository_fixture",
          contentUploadSessionId: "cus_repository_fixture",
          updatedAt: "2026-08-12T00:00:10.000Z",
        })).toBe(true)
        expect(await beginProxyContentUpload({
          client,
          communityId: "community_fixture",
          uploaderUserId: "user_fixture",
          contentBlobId: "cbl_repository_fixture",
          contentUploadSessionId: "cus_repository_fixture",
          updatedAt: "2026-08-12T00:00:11.000Z",
        })).toBe(false)

        const uploaded = await markProxyContentBlobUploaded({
          client,
          communityId: "community_fixture",
          uploaderUserId: "user_fixture",
          contentBlobId: "cbl_repository_fixture",
          contentUploadSessionId: "cus_repository_fixture",
          verifiedSizeBytes: 12,
          verifiedContentHash: `0x${"a".repeat(64)}`,
          storageProvider: "filebase_ipfs",
          storageBucket: "fixture-bucket",
          storageObjectKey: "content-blobs/community_fixture/cbl_repository_fixture/payload",
          storageEndpoint: "https://s3.example",
          gatewayUrl: "https://api.example/content",
          ipfsCid: "bafyfixture",
          completedAt: "2026-08-12T00:00:20.000Z",
        })
        expect(uploaded.blob.status).toBe("uploaded")
        expect(uploaded.blob.security_scan_state).toBe("pending")
        expect(uploaded.uploadSession?.status).toBe("uploaded")

        const reread = await requireOwnedContentBlob({
          client,
          communityId: "community_fixture",
          uploaderUserId: "user_fixture",
          contentBlobId: "cbl_repository_fixture",
        })
        expect(reread.blob.verified_size_bytes).toBe(12)
        expect(reread.blob.storage_object_key).toBe(
          "content-blobs/community_fixture/cbl_repository_fixture/payload",
        )
      })
    } finally {
      setControlPlanePostgresPoolFactoryForTests(null)
    }
  })
})
