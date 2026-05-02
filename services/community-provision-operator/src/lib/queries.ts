import type { ControlPlaneQueryable } from "./types";
import { parseRotationNumber } from "./helpers";
import type { BindingRow, NamespaceVerificationRow } from "./types";

export async function requireNamespaceVerification(
  db: ControlPlaneQueryable,
  input: {
    namespaceVerificationId: string;
    creatorUserId: string;
  },
): Promise<NamespaceVerificationRow> {
  const rows = await db.sql<NamespaceVerificationRow[]>`
    SELECT
      namespace_verification_id,
      user_id,
      status,
      club_attach_allowed,
      normalized_root_label
    FROM namespace_verifications
    WHERE namespace_verification_id = ${input.namespaceVerificationId}
  `;
  const row = rows[0] ?? null;

  if (!row) {
    throw new Error(`namespace verification not found: ${input.namespaceVerificationId}`);
  }
  if (row.user_id !== input.creatorUserId) {
    throw new Error("namespace verification does not belong to the provided creator user");
  }
  if (row.status !== "verified" || Number(row.club_attach_allowed) !== 1) {
    throw new Error("namespace verification is not attachable");
  }
  return row;
}

export async function getPrimaryBindingByCommunityId(
  db: ControlPlaneQueryable,
  communityId: string,
): Promise<BindingRow | null> {
  const rows = await db.sql<BindingRow[]>`
    SELECT
      community_database_binding_id,
      community_id,
      organization_slug,
      group_name,
      database_name,
      database_url,
      location,
      status
    FROM community_database_bindings
    WHERE community_id = ${communityId}
      AND binding_role = 'primary'
    ORDER BY CASE status WHEN 'active' THEN 0 ELSE 1 END, created_at DESC
    LIMIT 1
  `;
  return rows[0] ?? null;
}

export async function getActivePrimaryBindingsByCommunityId(
  db: ControlPlaneQueryable,
  communityId: string,
): Promise<BindingRow[]> {
  return db.sql<BindingRow[]>`
    SELECT
      community_database_binding_id,
      community_id,
      organization_slug,
      group_name,
      database_name,
      database_url,
      location,
      status
    FROM community_database_bindings
    WHERE community_id = ${communityId}
      AND binding_role = 'primary'
      AND status = 'active'
    ORDER BY created_at DESC
  `;
}

export async function getNextRotationNumber(
  db: ControlPlaneQueryable,
  input: { communityId: string },
): Promise<number> {
  const rows = await db.sql<{ token_name: string }[]>`
    SELECT cdc.token_name
    FROM community_db_credentials AS cdc
    INNER JOIN community_database_bindings AS cdb
      ON cdb.community_database_binding_id = cdc.community_database_binding_id
    WHERE cdb.community_id = ${input.communityId}
  `;

  let maxVersion = 0;
  for (const row of rows) {
    maxVersion = Math.max(maxVersion, parseRotationNumber(input.communityId, String(row.token_name ?? "")));
  }
  return maxVersion + 1;
}

export async function writeActiveCommunityCredential(
  tx: ControlPlaneQueryable,
  input: {
    communityDatabaseBindingId: string;
    communityDbCredentialId: string;
    tokenName: string;
    encryptedToken: string;
    encryptionKeyVersion: number;
    timestamp: string;
  },
): Promise<void> {
  await tx.sql`
    UPDATE community_db_credentials
    SET status = 'superseded',
        invalidated_at = ${input.timestamp},
        updated_at = ${input.timestamp}
    WHERE community_database_binding_id = ${input.communityDatabaseBindingId}
      AND status = 'active'
  `;

  await tx.sql`
    INSERT INTO community_db_credentials (
      community_db_credential_id,
      community_database_binding_id,
      credential_kind,
      token_name,
      encrypted_token,
      encryption_key_version,
      token_scope,
      status,
      issued_at,
      invalidated_at,
      expires_at,
      created_at,
      updated_at
    ) VALUES (
      ${input.communityDbCredentialId},
      ${input.communityDatabaseBindingId},
      'database_token',
      ${input.tokenName},
      ${input.encryptedToken},
      ${input.encryptionKeyVersion},
      'database',
      'active',
      ${input.timestamp},
      NULL,
      NULL,
      ${input.timestamp},
      ${input.timestamp}
    )
  `;
}

export async function getActiveCredentialCount(
  db: ControlPlaneQueryable,
  communityDatabaseBindingId: string,
): Promise<number> {
  const rows = await db.sql<{ count: number }[]>`
    SELECT COUNT(*) AS count
    FROM community_db_credentials
    WHERE community_database_binding_id = ${communityDatabaseBindingId}
      AND status = 'active'
  `;
  return Number(rows[0]?.count ?? 0);
}

export async function getActiveCredentialRow(
  db: ControlPlaneQueryable,
  communityDatabaseBindingId: string,
): Promise<{
  community_db_credential_id: string;
  encrypted_token: string;
  encryption_key_version: number;
  token_name: string;
} | null> {
  const rows = await db.sql<{
    community_db_credential_id: string;
    encrypted_token: string;
    encryption_key_version: number;
    token_name: string;
  }[]>`
    SELECT
      community_db_credential_id,
      encrypted_token,
      encryption_key_version,
      token_name
    FROM community_db_credentials
    WHERE community_database_binding_id = ${communityDatabaseBindingId}
      AND status = 'active'
    ORDER BY issued_at DESC, created_at DESC
    LIMIT 1
  `;
  return rows[0] ?? null;
}

export async function getActiveNamespaceCollisionCommunityIds(
  db: ControlPlaneQueryable,
  input: { communityId: string; routeSlug: string },
): Promise<string[]> {
  const rows = await db.sql<{ community_id: string }[]>`
    SELECT c.community_id
    FROM communities AS c
    INNER JOIN namespace_verifications AS nv
      ON nv.namespace_verification_id = c.namespace_verification_id
    WHERE c.community_id <> ${input.communityId}
      AND c.status = 'active'
      AND c.provisioning_state = 'active'
      AND nv.normalized_root_label = ${input.routeSlug}
    ORDER BY c.created_at DESC, c.community_id DESC
  `;
  return rows.map((row) => row.community_id);
}
