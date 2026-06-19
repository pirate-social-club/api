import { afterEach, beforeEach, expect, test } from "bun:test"
import { mkdtempSync, rmSync } from "node:fs"
import { tmpdir } from "node:os"
import { join } from "node:path"
import { createClient, type Client } from "@libsql/client"
import {
  createCommunityProvisioningRequest,
  markCommunityProvisioningSucceeded,
} from "./repository"
import { persistProvisionedCommunityCredential } from "./service"
import type { CommunityProvisioningRepository, InitialCommunityDatabaseBinding } from "../community-repository-types"
import type { Env } from "../../../env"

let cp: Client
let tmpDir: string
let dbPath: string

const d1InitialBinding: InitialCommunityDatabaseBinding = {
  organizationSlug: "shard",
  groupName: "shard",
  groupId: null,
  databaseName: "pending",
  databaseId: null,
  databaseUrl: "d1://pending-cmt_d1_persist.invalid",
  location: "weur",
  requiresCredentials: false,
  provisioningMode: "d1_native",
}

const SCHEMA_STATEMENTS = [
  `CREATE TABLE users (
    user_id TEXT PRIMARY KEY,
    verification_state TEXT NOT NULL,
    verification_capabilities_json TEXT NOT NULL,
    created_at TEXT NOT NULL,
    updated_at TEXT NOT NULL
  )`,
  `CREATE TABLE communities (
    community_id TEXT PRIMARY KEY,
    creator_user_id TEXT NOT NULL REFERENCES users(user_id),
    display_name TEXT NOT NULL,
    description TEXT,
    avatar_ref TEXT,
    banner_ref TEXT,
    membership_mode TEXT NOT NULL,
    status TEXT NOT NULL,
    provisioning_state TEXT NOT NULL,
    transfer_state TEXT NOT NULL,
    route_slug TEXT,
    namespace_verification_id TEXT,
    pending_namespace_verification_session_id TEXT,
    primary_database_binding_id TEXT,
    follower_count INTEGER,
    created_at TEXT NOT NULL,
    updated_at TEXT NOT NULL
  )`,
  `CREATE TABLE community_database_bindings (
    community_database_binding_id TEXT PRIMARY KEY,
    community_id TEXT NOT NULL REFERENCES communities(community_id),
    binding_role TEXT NOT NULL,
    organization_slug TEXT NOT NULL,
    group_name TEXT NOT NULL,
    group_id TEXT,
    database_name TEXT NOT NULL,
    database_id TEXT,
    database_url TEXT NOT NULL,
    location TEXT,
    requires_credentials INTEGER NOT NULL DEFAULT 1,
    status TEXT NOT NULL,
    transferred_at TEXT,
    created_at TEXT NOT NULL,
    updated_at TEXT NOT NULL
  )`,
  `CREATE TABLE community_db_credentials (
    community_db_credential_id TEXT PRIMARY KEY,
    community_database_binding_id TEXT NOT NULL REFERENCES community_database_bindings(community_database_binding_id),
    credential_kind TEXT NOT NULL,
    token_name TEXT NOT NULL,
    encrypted_token TEXT NOT NULL,
    encryption_key_version INTEGER NOT NULL,
    token_scope TEXT NOT NULL,
    status TEXT NOT NULL,
    issued_at TEXT NOT NULL,
    invalidated_at TEXT,
    expires_at TEXT,
    created_at TEXT NOT NULL,
    updated_at TEXT NOT NULL
  )`,
  `CREATE TABLE jobs (
    job_id TEXT PRIMARY KEY,
    job_type TEXT NOT NULL,
    job_scope TEXT NOT NULL,
    community_id TEXT REFERENCES communities(community_id),
    subject_type TEXT NOT NULL,
    subject_id TEXT NOT NULL,
    status TEXT NOT NULL,
    payload_json TEXT,
    result_ref TEXT,
    error_code TEXT,
    attempt_count INTEGER NOT NULL DEFAULT 0,
    available_at TEXT,
    created_at TEXT NOT NULL,
    updated_at TEXT NOT NULL
  )`,
  `CREATE TABLE audit_log (
    audit_event_id TEXT PRIMARY KEY,
    actor_type TEXT NOT NULL,
    actor_id TEXT,
    action TEXT NOT NULL,
    target_type TEXT NOT NULL,
    target_id TEXT NOT NULL,
    community_id TEXT REFERENCES communities(community_id),
    metadata_json TEXT,
    created_at TEXT NOT NULL
  )`,
]

beforeEach(async () => {
  // file: (not :memory:) because libsql :memory: opens a fresh per-connection
  // database, so writes inside a transaction (createCommunityProvisioningRequest,
  // markCommunityProvisioningSucceeded) are not visible to the main client
  // handle afterwards.
  tmpDir = mkdtempSync(join(tmpdir(), "d1-persist-"))
  dbPath = join(tmpDir, "cp.db")
  cp = createClient({ url: `file:${dbPath}` })
  await cp.execute("PRAGMA foreign_keys = ON")
  for (const sql of SCHEMA_STATEMENTS) {
    await cp.execute(sql)
  }
})

afterEach(() => {
  cp.close()
  rmSync(tmpDir, { recursive: true, force: true })
})

async function seedUser(userId: string): Promise<void> {
  await cp.execute({
    sql: `INSERT INTO users (user_id, verification_state, verification_capabilities_json, created_at, updated_at)
          VALUES (?1, 'verified', '{}', 't0', 't0')`,
    args: [userId],
  })
}

test("persistProvisionedCommunityCredential({credential: null}) is a no-op — never invokes the credentials writer", async () => {
  // Regression net: if someone tightens this function to require a non-null
  // credential (e.g. adds a guard that throws on null), d1_native provisioning
  // — which always returns credential: null — starts throwing in production
  // without any test catching it. Pin the d1-native contract.
  let called = 0
  const fakeRepo: CommunityProvisioningRepository = {
    persistProvisionedCommunityDatabaseAccess: async () => {
      called += 1
    },
    // Other methods are never called on the null path; throw loudly if they
    // are, so a future refactor that touches the repo doesn't silently lose
    // coverage.
  } as unknown as CommunityProvisioningRepository

  await persistProvisionedCommunityCredential({
    env: {} as Env,
    repo: fakeRepo,
    communityId: "cmt_d1",
    bindingId: "cdb_d1",
    credential: null,
    updatedAt: "t0",
  })

  expect(called).toBe(0)
})

test("d1-native persist flow: create + null-credential persist + succeed writes zero credential rows and lands provisioning_state=active with a d1:// resultRef", async () => {
  await seedUser("usr_d1")
  const now = "2026-06-19T00:00:00Z"

  const prepared = await createCommunityProvisioningRequest(cp, {
    communityId: "cmt_d1",
    communityDatabaseBindingId: "cdb_d1",
    jobId: "job_d1",
    creatorUserId: "usr_d1",
    displayName: "Born on D1",
    description: null,
    avatarRef: null,
    bannerRef: null,
    membershipMode: "gated",
    namespaceVerificationId: null,
    routeSlug: null,
    binding: d1InitialBinding,
    createdAt: now,
  })
  expect(prepared.binding.database_url).toBe("d1://pending-cmt_d1_persist.invalid")
  expect(Number(prepared.binding.requires_credentials)).toBe(0)

  // The d1_native.provision() return shape: no credential, no snapshot, but
  // a concrete binding (in production this URL would be `d1://shard/<binding>`;
  // for the persist path the exact value is opaque — the test only checks it
  // is the same string the caller passed through).
  const resolvedD1Url = "d1://shard/DB_CMTY_PERSIST_001"
  const repo = {
    persistProvisionedCommunityDatabaseAccess: async () => {
      throw new Error("must not be called for d1_native (credential: null)")
    },
  } as unknown as CommunityProvisioningRepository

  await persistProvisionedCommunityCredential({
    env: {} as Env,
    repo,
    communityId: "cmt_d1",
    bindingId: prepared.binding.community_database_binding_id,
    credential: null,
    updatedAt: now,
  })

  const finalized = await markCommunityProvisioningSucceeded(cp, {
    communityId: "cmt_d1",
    communityDatabaseBindingId: prepared.binding.community_database_binding_id,
    jobId: prepared.job.job_id,
    actorUserId: "usr_d1",
    resultRef: resolvedD1Url,
    description: null,
    avatarRef: null,
    bannerRef: null,
    createdAt: now,
    metadata: {
      binding_id: prepared.binding.community_database_binding_id,
      database_url: resolvedD1Url,
      mode: "d1_native",
    },
  })

  // Community row: provisioning_state flipped to 'active'.
  expect(finalized.community.provisioning_state).toBe("active")
  expect(finalized.community.status).toBe("active")
  expect(finalized.community.primary_database_binding_id).toBe(prepared.binding.community_database_binding_id)

  // Job row: succeeded with the d1:// resultRef preserved.
  expect(finalized.job.status).toBe("succeeded")
  expect(finalized.job.result_ref).toBe(resolvedD1Url)
  expect(finalized.job.error_code).toBeNull()

  // Binding row: the pending sentinel URL is still there because
  // persistProvisionedD1Binding has not been called in this test — that is
  // the orchestrator's job (gap 1 / slice 3). What matters here is that the
  // persist path left it intact rather than crashing on the d1 shape.
  const binding = (await cp.execute({
    sql: "SELECT database_url, requires_credentials FROM community_database_bindings WHERE community_database_binding_id = ?1",
    args: [prepared.binding.community_database_binding_id],
  })).rows[0]
  expect(binding.database_url).toBe("d1://pending-cmt_d1_persist.invalid")
  expect(Number(binding.requires_credentials)).toBe(0)

  // The defining audit-g5 invariant: zero credential rows for a d1-native
  // community. A future refactor that accidentally calls the credentials
  // writer on the d1 path will surface here.
  const credRows = (await cp.execute({
    sql: "SELECT COUNT(*) AS n FROM community_db_credentials WHERE community_database_binding_id = ?1",
    args: [prepared.binding.community_database_binding_id],
  })).rows[0]
  expect(Number(credRows.n)).toBe(0)

  // The audit log records a provisioning_succeeded event with the d1_native
  // mode in metadata — proves the persist path's metadata is mode-aware
  // even when the call site is d1.
  const audit = (await cp.execute({
    sql: "SELECT action, metadata_json FROM audit_log WHERE community_id = ?1",
    args: ["cmt_d1"],
  })).rows[0]
  expect(audit.action).toBe("community.provisioning_succeeded")
  const metadata = JSON.parse(String(audit.metadata_json)) as Record<string, unknown>
  expect(metadata["mode"]).toBe("d1_native")
  expect(metadata["binding_id"]).toBe(prepared.binding.community_database_binding_id)
  expect(metadata["database_url"]).toBe(resolvedD1Url)
})
