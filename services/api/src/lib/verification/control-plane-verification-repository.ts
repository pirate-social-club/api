import { createClient } from "@libsql/client"
import type { Client } from "@libsql/client"
import { internalError, verificationRequired } from "../errors"
import { makeId } from "../helpers"
import {
  firstRow,
  getUserRow,
  requireControlPlaneDbUrl,
} from "../auth/control-plane-auth-queries"
import {
  parseVerificationCapabilities,
  serializeNamespaceVerification,
  serializeNamespaceVerificationSession,
  serializeVerificationSession,
} from "../auth/control-plane-auth-serializers"
import type {
  NamespaceVerificationRow,
  NamespaceVerificationSessionRow,
  UserAttestationRow,
  UserRow,
  VerificationSessionRow,
} from "../auth/control-plane-auth-rows"
import {
  toNamespaceVerificationRow,
  toNamespaceVerificationSessionRow,
  toUserAttestationRow,
  toVerificationSessionRow,
} from "../auth/control-plane-auth-rows"
import type {
  Env,
  NamespaceVerification,
  NamespaceVerificationSession,
  VerificationSession,
} from "../../types"

async function getVerificationSessionRowForUser(
  client: Client,
  verificationSessionId: string,
  userId: string,
): Promise<VerificationSessionRow | null> {
  const row = await firstRow(client, {
    sql: `
      SELECT verification_session_id, user_id, provider, requested_capabilities_json,
             status, result_ref, failure_code, completed_at, expires_at, created_at, updated_at
      FROM verification_sessions
      WHERE verification_session_id = ?1
        AND user_id = ?2
      LIMIT 1
    `,
    args: [verificationSessionId, userId],
  })

  return row ? toVerificationSessionRow(row) : null
}

async function getAttestationBySourceSessionId(
  client: Client,
  verificationSessionId: string,
  userId: string,
): Promise<UserAttestationRow | null> {
  const row = await firstRow(client, {
    sql: `
      SELECT user_attestation_id, capability_key, status, verified_at, expires_at
      FROM user_attestations
      WHERE source_verification_session_id = ?1
        AND user_id = ?2
      ORDER BY created_at DESC
      LIMIT 1
    `,
    args: [verificationSessionId, userId],
  })

  return row ? toUserAttestationRow(row) : null
}

async function getNamespaceVerificationSessionRowForUser(
  client: Client,
  namespaceVerificationSessionId: string,
  userId: string,
): Promise<NamespaceVerificationSessionRow | null> {
  const row = await firstRow(client, {
    sql: `
      SELECT namespace_verification_session_id, namespace_verification_id, user_id, family, submitted_root_label,
             normalized_root_label, status, challenge_host, challenge_txt_value, challenge_expires_at,
             root_exists, root_control_verified, expiry_horizon_sufficient, routing_enabled,
             pirate_dns_authority_verified, club_attach_allowed, pirate_web_routing_allowed,
             pirate_subdomain_issuance_allowed, control_class, operation_class, observation_provider,
             evidence_bundle_ref, failure_reason, accepted_at, expires_at, created_at, updated_at
      FROM namespace_verification_sessions
      WHERE namespace_verification_session_id = ?1
        AND user_id = ?2
      LIMIT 1
    `,
    args: [namespaceVerificationSessionId, userId],
  })

  return row ? toNamespaceVerificationSessionRow(row) : null
}

async function getNamespaceVerificationRowForUser(
  client: Client,
  namespaceVerificationId: string,
  userId: string,
): Promise<NamespaceVerificationRow | null> {
  const row = await firstRow(client, {
    sql: `
      SELECT namespace_verification_id, user_id, family, normalized_root_label, status,
             root_exists, root_control_verified, expiry_horizon_sufficient, routing_enabled,
             pirate_dns_authority_verified, club_attach_allowed, pirate_web_routing_allowed,
             pirate_subdomain_issuance_allowed, control_class, operation_class, observation_provider,
             evidence_bundle_ref, accepted_at, expires_at, created_at, updated_at
      FROM namespace_verifications
      WHERE namespace_verification_id = ?1
        AND user_id = ?2
      LIMIT 1
    `,
    args: [namespaceVerificationId, userId],
  })

  return row ? toNamespaceVerificationRow(row) : null
}

export async function startVerificationSession(
  client: Client,
  input: {
    userId: string
    provider: "self" | "very"
    walletAttachmentId?: string | null
  },
): Promise<VerificationSession> {
  const now = new Date()
  const createdAt = now.toISOString()
  const expiresAt = new Date(now.getTime() + 24 * 60 * 60 * 1000).toISOString()
  const verificationSessionId = makeId("ver")

  await client.execute({
    sql: `
      INSERT INTO verification_sessions (
        verification_session_id, user_id, provider, session_kind, requested_capabilities_json,
        status, upstream_session_ref, result_ref, failure_code, started_at, completed_at,
        expires_at, created_at, updated_at
      ) VALUES (?1, ?2, ?3, 'identity_proof', ?4, 'pending', NULL, NULL, NULL, ?5, NULL, ?6, ?5, ?5)
    `,
    args: [verificationSessionId, input.userId, input.provider, JSON.stringify(["unique_human"]), createdAt, expiresAt],
  })

  const row = await getVerificationSessionRowForUser(client, verificationSessionId, input.userId)
  if (!row) {
    throw internalError("Verification session row is missing after creation")
  }
  return serializeVerificationSession({ row, attestationRow: null })
}

export async function getVerificationSession(
  client: Client,
  verificationSessionId: string,
  userId: string,
): Promise<VerificationSession | null> {
  const row = await getVerificationSessionRowForUser(client, verificationSessionId, userId)
  if (!row) {
    return null
  }
  const attestationRow = await getAttestationBySourceSessionId(client, verificationSessionId, userId)
  return serializeVerificationSession({ row, attestationRow })
}

export async function completeVerificationSession(
  client: Client,
  input: {
    verificationSessionId: string
    userId: string
    attestationId?: string | null
    proofHash?: string | null
  },
): Promise<VerificationSession | null> {
  const row = await getVerificationSessionRowForUser(client, input.verificationSessionId, input.userId)
  if (!row) {
    return null
  }

  const now = new Date()
  const updatedAt = now.toISOString()
  const attestationId = input.attestationId?.trim() || makeId("att")
  const expiresAt = row.expires_at ?? new Date(now.getTime() + 30 * 24 * 60 * 60 * 1000).toISOString()
  const userRow = await getUserRow(client, input.userId)
  if (!userRow) {
    throw internalError("User row missing while completing verification session")
  }

  const capabilities = parseVerificationCapabilities(userRow.verification_capabilities_json)
  capabilities.unique_human = {
    state: "verified",
    provider: row.provider === "self" || row.provider === "very" ? row.provider : null,
    proof_type: "unique_human",
    mechanism: "session_complete",
    verified_at: updatedAt,
  }

  await client.batch([
    {
      sql: `
        UPDATE verification_sessions
        SET status = 'verified',
            result_ref = ?2,
            failure_code = NULL,
            completed_at = ?3,
            updated_at = ?3
        WHERE verification_session_id = ?1
      `,
      args: [input.verificationSessionId, input.proofHash ?? null, updatedAt],
    },
    {
      sql: `
        INSERT INTO user_attestations (
          user_attestation_id, user_id, source_verification_session_id, provider, attestation_type,
          capability_key, status, value_json, verified_at, expires_at, revoked_at, created_at, updated_at
        ) VALUES (?1, ?2, ?3, ?4, 'unique_human', 'unique_human', 'accepted', ?5, ?6, ?7, NULL, ?6, ?6)
      `,
      args: [attestationId, input.userId, input.verificationSessionId, row.provider, JSON.stringify({ state: "verified" }), updatedAt, expiresAt],
    },
    {
      sql: `
        UPDATE users
        SET verification_state = 'verified',
            capability_provider = ?2,
            verification_capabilities_json = ?3,
            verified_at = ?4,
            current_verification_session_id = ?1,
            updated_at = ?4
        WHERE user_id = ?5
      `,
      args: [input.verificationSessionId, row.provider, JSON.stringify(capabilities), updatedAt, input.userId],
    },
  ], "write")

  return getVerificationSession(client, input.verificationSessionId, input.userId)
}

export async function startNamespaceVerificationSession(
  client: Client,
  input: {
    userId: string
    family: "hns"
    rootLabel: string
  },
): Promise<NamespaceVerificationSession> {
  const userRow = await getUserRow(client, input.userId)
  if (!userRow) {
    throw internalError("User row missing while starting namespace verification session")
  }
  const capabilities = parseVerificationCapabilities(userRow.verification_capabilities_json)
  if (capabilities.unique_human.state !== "verified") {
    throw verificationRequired("unique_human verification is required")
  }

  const now = new Date()
  const createdAt = now.toISOString()
  const expiresAt = new Date(now.getTime() + 30 * 24 * 60 * 60 * 1000).toISOString()
  const challengeExpiresAt = new Date(now.getTime() + 60 * 60 * 1000).toISOString()
  const normalizedRootLabel = input.rootLabel.trim().toLowerCase()
  const sessionId = makeId("nvs")
  const challengeHost = `_pirate.${normalizedRootLabel}`
  const challengeTxtValue = `pirate-verification=${sessionId}`

  await client.execute({
    sql: `
      INSERT INTO namespace_verification_sessions (
        namespace_verification_session_id, namespace_verification_id, user_id, family, submitted_root_label,
        normalized_root_label, status, challenge_host, challenge_txt_value, challenge_expires_at,
        root_exists, root_control_verified, expiry_horizon_sufficient, routing_enabled,
        pirate_dns_authority_verified, club_attach_allowed, pirate_web_routing_allowed,
        pirate_subdomain_issuance_allowed, control_class, operation_class, observation_provider,
        evidence_bundle_ref, failure_reason, accepted_at, expires_at, created_at, updated_at
      ) VALUES (
        ?1, NULL, ?2, ?3, ?4, ?5, 'challenge_required', ?6, ?7, ?8,
        NULL, NULL, NULL, NULL, NULL, NULL, NULL, NULL, NULL, NULL, 'local_stub',
        NULL, NULL, NULL, ?9, ?10, ?10
      )
    `,
    args: [sessionId, input.userId, input.family, input.rootLabel, normalizedRootLabel, challengeHost, challengeTxtValue, challengeExpiresAt, expiresAt, createdAt],
  })

  const row = await getNamespaceVerificationSessionRowForUser(client, sessionId, input.userId)
  if (!row) {
    throw internalError("Namespace verification session row is missing after creation")
  }
  return serializeNamespaceVerificationSession(row)
}

export async function getNamespaceVerificationSession(
  client: Client,
  namespaceVerificationSessionId: string,
  userId: string,
): Promise<NamespaceVerificationSession | null> {
  const row = await getNamespaceVerificationSessionRowForUser(client, namespaceVerificationSessionId, userId)
  return row ? serializeNamespaceVerificationSession(row) : null
}

export async function completeNamespaceVerificationSession(
  client: Client,
  input: {
    namespaceVerificationSessionId: string
    userId: string
    restartChallenge?: boolean | null
  },
): Promise<NamespaceVerificationSession | null> {
  const row = await getNamespaceVerificationSessionRowForUser(client, input.namespaceVerificationSessionId, input.userId)
  if (!row) {
    return null
  }

  const now = new Date()
  const updatedAt = now.toISOString()
  if (input.restartChallenge) {
    const challengeExpiresAt = new Date(now.getTime() + 60 * 60 * 1000).toISOString()
    await client.execute({
      sql: `
        UPDATE namespace_verification_sessions
        SET status = 'challenge_required',
            challenge_txt_value = ?2,
            challenge_expires_at = ?3,
            updated_at = ?4
        WHERE namespace_verification_session_id = ?1
      `,
      args: [input.namespaceVerificationSessionId, `pirate-verification=${makeId("nch")}`, challengeExpiresAt, updatedAt],
    })
    return getNamespaceVerificationSession(client, input.namespaceVerificationSessionId, input.userId)
  }

  const verificationId = row.namespace_verification_id ?? makeId("nv")
  const evidenceBundleId = makeId("nev")
  const expiresAt = row.expires_at

  await client.batch([
    {
      sql: `
        UPDATE namespace_verification_sessions
        SET namespace_verification_id = ?2,
            status = 'verified',
            root_exists = 1,
            root_control_verified = 1,
            expiry_horizon_sufficient = 1,
            routing_enabled = 1,
            pirate_dns_authority_verified = 0,
            club_attach_allowed = 1,
            pirate_web_routing_allowed = 1,
            pirate_subdomain_issuance_allowed = 0,
            control_class = 'single_holder_root',
            operation_class = 'owner_managed_namespace',
            observation_provider = 'local_stub',
            evidence_bundle_ref = ?3,
            failure_reason = NULL,
            accepted_at = ?4,
            updated_at = ?4
        WHERE namespace_verification_session_id = ?1
      `,
      args: [input.namespaceVerificationSessionId, verificationId, evidenceBundleId, updatedAt],
    },
    {
      sql: `
        INSERT OR REPLACE INTO namespace_verifications (
          namespace_verification_id, source_namespace_verification_session_id, user_id, family, normalized_root_label,
          status, root_exists, root_control_verified, expiry_horizon_sufficient, routing_enabled,
          pirate_dns_authority_verified, club_attach_allowed, pirate_web_routing_allowed, pirate_subdomain_issuance_allowed,
          control_class, operation_class, observation_provider, evidence_bundle_ref, accepted_at, expires_at, created_at, updated_at
        ) VALUES (
          ?1, ?2, ?3, 'hns', ?4, 'verified', 1, 1, 1, 1, 0, 1, 1, 0,
          'single_holder_root', 'owner_managed_namespace', 'local_stub', ?5, ?6, ?7, ?6, ?6
        )
      `,
      args: [verificationId, input.namespaceVerificationSessionId, input.userId, row.normalized_root_label ?? row.submitted_root_label.toLowerCase(), evidenceBundleId, updatedAt, expiresAt],
    },
    {
      sql: `
        INSERT INTO namespace_verification_evidence_bundles (
          evidence_bundle_id, namespace_verification_session_id, namespace_verification_id, family, normalized_root_label,
          evidence_kind, provider, resolver_path_json, raw_response_json, evidence_hash, observed_at, created_at, updated_at
        ) VALUES (?1, ?2, ?3, 'hns', ?4, 'accepted_snapshot', 'local_stub', ?5, ?6, NULL, ?7, ?7, ?7)
      `,
      args: [
        evidenceBundleId,
        input.namespaceVerificationSessionId,
        verificationId,
        row.normalized_root_label ?? row.submitted_root_label.toLowerCase(),
        JSON.stringify(["local_stub"]),
        JSON.stringify({ root_exists: true, root_control_verified: true, routing_enabled: true }),
        updatedAt,
      ],
    },
  ], "write")

  return getNamespaceVerificationSession(client, input.namespaceVerificationSessionId, input.userId)
}

export async function getNamespaceVerification(
  client: Client,
  namespaceVerificationId: string,
  userId: string,
): Promise<NamespaceVerification | null> {
  const row = await getNamespaceVerificationRowForUser(client, namespaceVerificationId, userId)
  return row ? serializeNamespaceVerification(row) : null
}

export interface VerificationRepository {
  startVerificationSession(input: {
    userId: string
    provider: "self" | "very"
    walletAttachmentId?: string | null
  }): Promise<VerificationSession>
  getVerificationSession(verificationSessionId: string, userId: string): Promise<VerificationSession | null>
  completeVerificationSession(input: {
    verificationSessionId: string
    userId: string
    attestationId?: string | null
    proofHash?: string | null
  }): Promise<VerificationSession | null>
  startNamespaceVerificationSession(input: {
    userId: string
    family: "hns"
    rootLabel: string
  }): Promise<NamespaceVerificationSession>
  getNamespaceVerificationSession(
    namespaceVerificationSessionId: string,
    userId: string,
  ): Promise<NamespaceVerificationSession | null>
  completeNamespaceVerificationSession(input: {
    namespaceVerificationSessionId: string
    userId: string
    restartChallenge?: boolean | null
  }): Promise<NamespaceVerificationSession | null>
  getNamespaceVerification(namespaceVerificationId: string, userId: string): Promise<NamespaceVerification | null>
}

export class ControlPlaneVerificationRepository implements VerificationRepository {
  constructor(private readonly client: Client) {}

  async startVerificationSession(input: {
    userId: string
    provider: "self" | "very"
    walletAttachmentId?: string | null
  }): Promise<VerificationSession> {
    return startVerificationSession(this.client, input)
  }

  async getVerificationSession(verificationSessionId: string, userId: string): Promise<VerificationSession | null> {
    return getVerificationSession(this.client, verificationSessionId, userId)
  }

  async completeVerificationSession(input: {
    verificationSessionId: string
    userId: string
    attestationId?: string | null
    proofHash?: string | null
  }): Promise<VerificationSession | null> {
    return completeVerificationSession(this.client, input)
  }

  async startNamespaceVerificationSession(input: {
    userId: string
    family: "hns"
    rootLabel: string
  }): Promise<NamespaceVerificationSession> {
    return startNamespaceVerificationSession(this.client, input)
  }

  async getNamespaceVerificationSession(
    namespaceVerificationSessionId: string,
    userId: string,
  ): Promise<NamespaceVerificationSession | null> {
    return getNamespaceVerificationSession(this.client, namespaceVerificationSessionId, userId)
  }

  async completeNamespaceVerificationSession(input: {
    namespaceVerificationSessionId: string
    userId: string
    restartChallenge?: boolean | null
  }): Promise<NamespaceVerificationSession | null> {
    return completeNamespaceVerificationSession(this.client, input)
  }

  async getNamespaceVerification(namespaceVerificationId: string, userId: string): Promise<NamespaceVerification | null> {
    return getNamespaceVerification(this.client, namespaceVerificationId, userId)
  }
}

const globalScope = globalThis as typeof globalThis & {
  __pirateControlPlaneVerificationRepository?: ControlPlaneVerificationRepository
  __pirateControlPlaneVerificationRepositoryKey?: string
}

export function getControlPlaneVerificationRepository(env: Env): ControlPlaneVerificationRepository {
  const url = requireControlPlaneDbUrl(env)
  const authToken = String(env.TURSO_CONTROL_PLANE_AUTH_TOKEN || "").trim()
  const cacheKey = `${url}|${authToken}`

  if (
    globalScope.__pirateControlPlaneVerificationRepository
    && globalScope.__pirateControlPlaneVerificationRepositoryKey === cacheKey
  ) {
    return globalScope.__pirateControlPlaneVerificationRepository
  }

  const repository = new ControlPlaneVerificationRepository(
    createClient({
      url,
      authToken: authToken || undefined,
    }),
  )
  globalScope.__pirateControlPlaneVerificationRepository = repository
  globalScope.__pirateControlPlaneVerificationRepositoryKey = cacheKey
  return repository
}
