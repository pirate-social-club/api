import type { Client } from "../sql-client"
import { executeFirst } from "../db-helpers"
import type {
  NamespaceVerificationRow,
  NamespaceVerificationSessionRow,
  UserAttestationRow,
  VerificationSessionRow,
} from "../auth/auth-db-rows"
import {
  toNamespaceVerificationRow,
  toNamespaceVerificationSessionRow,
  toUserAttestationRow,
  toVerificationSessionRow,
} from "../auth/auth-db-rows"
export {
  boolToDb,
  deriveAcceptedHnsSnapshot,
  deriveHnsInspectionSnapshot,
  deriveSpacesAcceptedSnapshot,
  getHnsChallengeTtlHours,
  isHnsVerifierConfigured,
  isProductionEnv,
  isSpacesVerifierConfigured,
  makeNamespaceAssertionStatements,
  makeNamespaceCapabilityStatements,
  parseStoredSpacesChallenge,
  serializeSetupNameservers,
} from "./namespace-verification-policy"
export type {
  HnsSessionAssertionSnapshot,
  SpacesAcceptedSnapshot,
} from "./namespace-verification-policy"

export async function getVerificationSessionRowForUser(
  client: Client,
  verificationSessionId: string,
  userId: string,
): Promise<VerificationSessionRow | null> {
  const row = await executeFirst(client, {
    sql: `
      SELECT verification_session_id, user_id, provider, requested_capabilities_json, verification_requirements_json,
             status, upstream_session_ref, result_ref, failure_code,
             wallet_attachment_id, verification_intent, policy_id,
             completed_at, expires_at, created_at, updated_at
      FROM verification_sessions
      WHERE verification_session_id = ?1
        AND user_id = ?2
      LIMIT 1
    `,
    args: [verificationSessionId, userId],
  })

  return row ? toVerificationSessionRow(row) : null
}

export async function getVerificationSessionRow(
  client: Client,
  verificationSessionId: string,
): Promise<VerificationSessionRow | null> {
  const row = await executeFirst(client, {
    sql: `
      SELECT verification_session_id, user_id, provider, requested_capabilities_json, verification_requirements_json,
             status, upstream_session_ref, result_ref, failure_code,
             wallet_attachment_id, verification_intent, policy_id,
             completed_at, expires_at, created_at, updated_at
      FROM verification_sessions
      WHERE verification_session_id = ?1
      LIMIT 1
    `,
    args: [verificationSessionId],
  })

  return row ? toVerificationSessionRow(row) : null
}

export async function getAttestationsBySourceSessionId(
  client: Client,
  verificationSessionId: string,
  userId: string,
): Promise<UserAttestationRow[]> {
  const result = await client.execute({
    sql: `
      SELECT user_attestation_id, capability_key, status, verified_at, expires_at
      FROM user_attestations
      WHERE source_verification_session_id = ?1
        AND user_id = ?2
      ORDER BY created_at ASC
    `,
    args: [verificationSessionId, userId],
  })

  return result.rows.map((row) => toUserAttestationRow(row))
}

export async function getNamespaceVerificationSessionRowForUser(
  client: Client,
  namespaceVerificationSessionId: string,
  userId: string,
): Promise<NamespaceVerificationSessionRow | null> {
  const row = await executeFirst(client, {
    sql: `
      SELECT
        nvs.namespace_verification_session_id,
        nvs.namespace_verification_id,
        nvs.user_id,
        nvs.family,
        nvs.submitted_root_label,
        nvs.normalized_root_label,
        nvs.status,
        nvs.challenge_kind,
        nvs.challenge_payload_json,
        nvs.challenge_host,
        nvs.challenge_txt_value,
        nvs.setup_nameservers_json,
        nvs.challenge_expires_at,
        nvs.root_exists,
        nvs.root_control_verified,
        nvs.expiry_horizon_sufficient,
        nvs.routing_enabled,
        nvs.pirate_dns_authority_verified,
        (
          SELECT assertion_value
          FROM namespace_verification_assertions AS nva
          WHERE nva.namespace_verification_session_id = nvs.namespace_verification_session_id
            AND nva.namespace_verification_id IS NULL
            AND nva.assertion_name = 'root_key_proof_verified'
            AND nva.status = 'accepted'
          ORDER BY nva.updated_at DESC
          LIMIT 1
        ) AS root_key_proof_verified,
        (
          SELECT assertion_value
          FROM namespace_verification_assertions AS nva
          WHERE nva.namespace_verification_session_id = nvs.namespace_verification_session_id
            AND nva.namespace_verification_id IS NULL
            AND nva.assertion_name = 'fabric_publish_verified'
            AND nva.status = 'accepted'
          ORDER BY nva.updated_at DESC
          LIMIT 1
        ) AS fabric_publish_verified,
        (
          SELECT assertion_value
          FROM namespace_verification_assertions AS nva
          WHERE nva.namespace_verification_session_id = nvs.namespace_verification_session_id
            AND nva.namespace_verification_id IS NULL
            AND nva.assertion_name = 'anchor_fresh_enough'
            AND nva.status = 'accepted'
          ORDER BY nva.updated_at DESC
          LIMIT 1
        ) AS anchor_fresh_enough,
        (
          SELECT assertion_value
          FROM namespace_verification_assertions AS nva
          WHERE nva.namespace_verification_session_id = nvs.namespace_verification_session_id
            AND nva.namespace_verification_id IS NULL
            AND nva.assertion_name = 'owner_signed_updates_verified'
            AND nva.status = 'accepted'
          ORDER BY nva.updated_at DESC
          LIMIT 1
        ) AS owner_signed_updates_verified,
        nvs.club_attach_allowed,
        nvs.pirate_web_routing_allowed,
        nvs.pirate_subdomain_issuance_allowed,
        (
          SELECT capability_value
          FROM namespace_verification_capabilities AS nvc
          WHERE nvc.namespace_verification_session_id = nvs.namespace_verification_session_id
            AND nvc.namespace_verification_id IS NULL
            AND nvc.capability_name = 'owner_signed_record_updates_allowed'
            AND nvc.status = 'accepted'
          ORDER BY nvc.updated_at DESC
          LIMIT 1
        ) AS owner_signed_record_updates_allowed,
        (
          SELECT capability_value
          FROM namespace_verification_capabilities AS nvc
          WHERE nvc.namespace_verification_session_id = nvs.namespace_verification_session_id
            AND nvc.namespace_verification_id IS NULL
            AND nvc.capability_name = 'pirate_subspace_issuance_allowed'
            AND nvc.status = 'accepted'
          ORDER BY nvc.updated_at DESC
          LIMIT 1
        ) AS pirate_subspace_issuance_allowed,
        nvs.control_class,
        nvs.operation_class,
        nvs.observation_provider,
        nvs.evidence_bundle_ref,
        nvs.failure_reason,
        nvs.accepted_at,
        nvs.anchor_height,
        nvs.anchor_block_hash,
        nvs.anchor_root_hash,
        nvs.proof_root_hash,
        nvs.expires_at,
        nvs.created_at,
        nvs.updated_at
      FROM namespace_verification_sessions AS nvs
      WHERE nvs.namespace_verification_session_id = ?1
        AND nvs.user_id = ?2
      LIMIT 1
    `,
    args: [namespaceVerificationSessionId, userId],
  })

  return row ? toNamespaceVerificationSessionRow(row) : null
}

export async function getNamespaceVerificationRowForUser(
  client: Client,
  namespaceVerificationId: string,
  userId: string,
): Promise<NamespaceVerificationRow | null> {
  const row = await executeFirst(client, {
    sql: `
      SELECT
        nv.namespace_verification_id,
        nv.user_id,
        nv.family,
        nv.normalized_root_label,
        nv.status,
        nv.root_exists,
        nv.root_control_verified,
        nv.expiry_horizon_sufficient,
        nv.routing_enabled,
        nv.pirate_dns_authority_verified,
        (
          SELECT assertion_value
          FROM namespace_verification_assertions AS nva
          WHERE nva.namespace_verification_id = nv.namespace_verification_id
            AND nva.assertion_name = 'root_key_proof_verified'
            AND nva.status = 'accepted'
          ORDER BY nva.updated_at DESC
          LIMIT 1
        ) AS root_key_proof_verified,
        (
          SELECT assertion_value
          FROM namespace_verification_assertions AS nva
          WHERE nva.namespace_verification_id = nv.namespace_verification_id
            AND nva.assertion_name = 'fabric_publish_verified'
            AND nva.status = 'accepted'
          ORDER BY nva.updated_at DESC
          LIMIT 1
        ) AS fabric_publish_verified,
        (
          SELECT assertion_value
          FROM namespace_verification_assertions AS nva
          WHERE nva.namespace_verification_id = nv.namespace_verification_id
            AND nva.assertion_name = 'anchor_fresh_enough'
            AND nva.status = 'accepted'
          ORDER BY nva.updated_at DESC
          LIMIT 1
        ) AS anchor_fresh_enough,
        (
          SELECT assertion_value
          FROM namespace_verification_assertions AS nva
          WHERE nva.namespace_verification_id = nv.namespace_verification_id
            AND nva.assertion_name = 'owner_signed_updates_verified'
            AND nva.status = 'accepted'
          ORDER BY nva.updated_at DESC
          LIMIT 1
        ) AS owner_signed_updates_verified,
        nv.club_attach_allowed,
        nv.pirate_web_routing_allowed,
        nv.pirate_subdomain_issuance_allowed,
        (
          SELECT capability_value
          FROM namespace_verification_capabilities AS nvc
          WHERE nvc.namespace_verification_id = nv.namespace_verification_id
            AND nvc.capability_name = 'owner_signed_record_updates_allowed'
            AND nvc.status = 'accepted'
          ORDER BY nvc.updated_at DESC
          LIMIT 1
        ) AS owner_signed_record_updates_allowed,
        (
          SELECT capability_value
          FROM namespace_verification_capabilities AS nvc
          WHERE nvc.namespace_verification_id = nv.namespace_verification_id
            AND nvc.capability_name = 'pirate_subspace_issuance_allowed'
            AND nvc.status = 'accepted'
          ORDER BY nvc.updated_at DESC
          LIMIT 1
        ) AS pirate_subspace_issuance_allowed,
        nv.control_class,
        nv.operation_class,
        nv.observation_provider,
        nv.evidence_bundle_ref,
        nv.accepted_at,
        nv.anchor_height,
        nv.anchor_block_hash,
        nv.anchor_root_hash,
        nv.proof_root_hash,
        nv.expires_at,
        nv.created_at,
        nv.updated_at
      FROM namespace_verifications AS nv
      WHERE nv.namespace_verification_id = ?1
        AND nv.user_id = ?2
      LIMIT 1
    `,
    args: [namespaceVerificationId, userId],
  })

  return row ? toNamespaceVerificationRow(row) : null
}
