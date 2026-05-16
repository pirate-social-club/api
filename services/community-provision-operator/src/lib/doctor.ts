import { createClient } from "@libsql/client";
import { openControlPlaneDatabase } from "./control-plane-db";
import { decryptCommunityDbCredential } from "./credential-crypto";
import { listExpectedCommunityMigrationChecksums } from "./community-bootstrap";
import { buildCommunityDatabaseName, buildRegionPoolGroupName, requireText } from "./helpers";
import {
  getActivePrimaryBindingsByCommunityId,
  getActiveCredentialCount,
  getActiveCredentialRow,
  getActiveNamespaceCollisionCommunityIds,
} from "./queries";
import type {
  DoctorInput,
  DoctorResult,
  DoctorFinding,
  CommunityRow,
} from "./types";

const COMPATIBLE_COMMUNITY_MIGRATION_CHECKSUMS: Record<string, Set<string>> = {
  "1080_post_comment_locks.sql": new Set([
    "cc64b1844768fc2cd585bd76daab9e75a32c596ddbdfbe8d7ac060d38cc5d23f",
  ]),
};

async function inspectCommunityDatabaseSchema(input: {
  databaseUrl: string;
  databaseAuthToken: string;
  expectedMigrations: Array<{ migrationName: string; checksum: string }>;
}): Promise<{
  missingMigrationNames: string[];
  mismatchedMigrationNames: string[];
  unexpectedMigrationNames: string[];
}> {
  const client = createClient({
    url: input.databaseUrl,
    authToken: input.databaseAuthToken,
  });

  try {
    const result = await client.execute(`
      SELECT migration_name, checksum
      FROM schema_migrations
      ORDER BY migration_name ASC
    `);

    const actualByName = new Map<string, string>();
    for (const row of result.rows as Array<{ migration_name?: unknown; checksum?: unknown }>) {
      const migrationName = String(row.migration_name ?? "").trim();
      const checksum = String(row.checksum ?? "").trim();
      if (migrationName) {
        actualByName.set(migrationName, checksum);
      }
    }

    const missingMigrationNames: string[] = [];
    const mismatchedMigrationNames: string[] = [];
    const expectedNames = new Set<string>();

    for (const expected of input.expectedMigrations) {
      expectedNames.add(expected.migrationName);
      const actualChecksum = actualByName.get(expected.migrationName);
      if (!actualChecksum) {
        missingMigrationNames.push(expected.migrationName);
        continue;
      }
      if (
        actualChecksum !== expected.checksum
        && !COMPATIBLE_COMMUNITY_MIGRATION_CHECKSUMS[expected.migrationName]?.has(actualChecksum)
      ) {
        mismatchedMigrationNames.push(expected.migrationName);
      }
    }

    const unexpectedMigrationNames: string[] = [];
    for (const migrationName of actualByName.keys()) {
      if (!expectedNames.has(migrationName)) {
        unexpectedMigrationNames.push(migrationName);
      }
    }

    const commentsSchema = await client.execute(`
      SELECT sql
      FROM sqlite_schema
      WHERE type = 'table'
        AND name = 'comments'
      LIMIT 1
    `);
    const commentsCreateSql = String(commentsSchema.rows[0]?.sql ?? "");
    if (
      commentsCreateSql
      && !/authorship_mode[\s\S]*'guest'/.test(commentsCreateSql)
      && !mismatchedMigrationNames.includes("1036_comment_agent_authorship.sql")
    ) {
      mismatchedMigrationNames.push("1036_comment_agent_authorship.sql");
    }

    return {
      missingMigrationNames,
      mismatchedMigrationNames,
      unexpectedMigrationNames,
    };
  } finally {
    client.close();
  }
}

function isExpectedDatabaseUrl(
  binding: { organization_slug: string; group_name: string; database_name: string; database_url: string },
): boolean {
  const raw = String(binding.database_url ?? "").trim();
  if (!raw.startsWith("libsql://")) {
    return false;
  }

  try {
    const url = new URL(raw);
    const hostname = url.hostname.trim().toLowerCase();
    const expectedDatabase = binding.database_name.trim().toLowerCase().replace(/_/g, "-");
    const expectedOrganization = binding.organization_slug.trim().toLowerCase().replace(/_/g, "-");
    if (!hostname) {
      return false;
    }
    if (!hostname.endsWith(".turso.io")) {
      return false;
    }
    if (!hostname.startsWith(`${expectedDatabase}-`) && !hostname.startsWith(`${expectedDatabase}.`)) {
      return false;
    }
    if (!hostname.includes(`-${expectedOrganization}.`) && !hostname.includes(`.${expectedOrganization}.`)) {
      return false;
    }
    return true;
  } catch {
    return false;
  }
}

export async function doctorControlPlane(
  input: DoctorInput,
): Promise<DoctorResult> {
  const controlPlaneDatabaseUrl = requireText(input.controlPlaneDatabaseUrl, "controlPlaneDatabaseUrl");
  const controlPlaneAuthToken = input.controlPlaneAuthToken?.trim() || null;
  const communityId = input.communityId?.trim() || null;
  const tursoCommunityDbWrapKey = input.tursoCommunityDbWrapKey?.trim() || null;
  const inspectFn = input.inspectCommunityDatabaseSchemaFn ?? inspectCommunityDatabaseSchema;
  const db = openControlPlaneDatabase({
    url: controlPlaneDatabaseUrl,
    authToken: controlPlaneAuthToken,
  });

  try {
    const findings: DoctorFinding[] = [];
    let checkedCommunityCount = 0;
    let checkedBindingCount = 0;
    let checkedCredentialCount = 0;
    const expectedMigrations = listExpectedCommunityMigrationChecksums();

    let communities: CommunityRow[];
    if (communityId) {
      communities = await db.sql<CommunityRow[]>`
        SELECT community_id, creator_user_id, primary_database_binding_id, provisioning_state, status, transfer_state, route_slug
        FROM communities
        WHERE community_id = ${communityId}
      `;
      if (communities.length === 0) {
        throw new Error(`community not found: ${communityId}`);
      }
    } else {
      communities = await db.sql<CommunityRow[]>`
        SELECT community_id, creator_user_id, primary_database_binding_id, provisioning_state, status, transfer_state, route_slug
        FROM communities
        WHERE status = 'active'
          AND provisioning_state = 'active'
        ORDER BY community_id ASC
      `;
    }

    for (const community of communities) {
      checkedCommunityCount += 1;

      if (community.status !== "active" || community.provisioning_state !== "active") {
        findings.push({
          severity: "error",
          code: "community_not_active",
          communityId: community.community_id,
          communityDatabaseBindingId: community.primary_database_binding_id,
          message: `community is not fully active (status=${community.status ?? "unknown"}, provisioning_state=${community.provisioning_state})`,
        });
        continue;
      }

      if ((community.transfer_state ?? "none") !== "none") {
        findings.push({
          severity: "error",
          code: "community_transfer_state_invalid",
          communityId: community.community_id,
          communityDatabaseBindingId: community.primary_database_binding_id,
          message: `community transfer_state must equal none; found ${community.transfer_state ?? "unknown"}`,
        });
      }

      const routeSlug = String(community.route_slug ?? "").trim().toLowerCase();
      if (routeSlug) {
        const collisions = await getActiveNamespaceCollisionCommunityIds(db, {
          communityId: community.community_id,
          routeSlug,
        });
        if (collisions.length > 0) {
          findings.push({
            severity: "error",
            code: "route_slug_namespace_collision",
            communityId: community.community_id,
            communityDatabaseBindingId: community.primary_database_binding_id,
            message: `community route_slug "${routeSlug}" conflicts with active namespace label on ${collisions.join(", ")}`,
          });
        }
      }

      const activeBindings = await getActivePrimaryBindingsByCommunityId(db, community.community_id);
      if (activeBindings.length !== 1) {
        findings.push({
          severity: "error",
          code: "community_missing_active_primary_binding",
          communityId: community.community_id,
          communityDatabaseBindingId: community.primary_database_binding_id,
          message: `community must have exactly one active primary binding; found ${activeBindings.length}`,
        });
        continue;
      }

      const binding = activeBindings[0];
      checkedBindingCount += 1;

      if (community.primary_database_binding_id !== binding.community_database_binding_id) {
        findings.push({
          severity: "error",
          code: "community_primary_binding_mismatch",
          communityId: community.community_id,
          communityDatabaseBindingId: binding.community_database_binding_id,
          message: "community.primary_database_binding_id does not match the active primary binding",
        });
      }

      const expectedGroupName = binding.location ? buildRegionPoolGroupName(binding.location) : null;
      if (binding.group_name !== expectedGroupName) {
        findings.push({
          severity: "error",
          code: "binding_group_name_mismatch",
          communityId: community.community_id,
          communityDatabaseBindingId: binding.community_database_binding_id,
          message: expectedGroupName
            ? `binding group_name must equal ${expectedGroupName}`
            : "binding location is required to validate region-pool group_name",
        });
      }

      const expectedDatabaseName = buildCommunityDatabaseName(community.community_id);
      if (binding.database_name !== expectedDatabaseName) {
        findings.push({
          severity: "error",
          code: "binding_database_name_mismatch",
          communityId: community.community_id,
          communityDatabaseBindingId: binding.community_database_binding_id,
          message: `binding database_name must equal ${expectedDatabaseName}`,
        });
      }

      if (!isExpectedDatabaseUrl(binding)) {
        findings.push({
          severity: "error",
          code: "binding_database_url_invalid",
          communityId: community.community_id,
          communityDatabaseBindingId: binding.community_database_binding_id,
          message: "binding database_url is not a valid expected libsql URL for this group/database",
        });
      }

      const activeCredentialCount = await getActiveCredentialCount(db, binding.community_database_binding_id);
      if (activeCredentialCount !== 1) {
        findings.push({
          severity: "error",
          code: "binding_missing_active_credential",
          communityId: community.community_id,
          communityDatabaseBindingId: binding.community_database_binding_id,
          message: `binding must have exactly one active encrypted credential; found ${activeCredentialCount}`,
        });
      } else {
        checkedCredentialCount += 1;

        try {
          const credential = await getActiveCredentialRow(db, binding.community_database_binding_id);
          if (!credential) {
            throw new Error("active_credential_row_not_found");
          }
          if (!tursoCommunityDbWrapKey) {
            throw new Error("missing_turso_community_db_wrap_key");
          }

          const databaseAuthToken = await decryptCommunityDbCredential({
            encryptedToken: credential.encrypted_token,
            encryptionKeyVersion: credential.encryption_key_version,
            wrapKey: tursoCommunityDbWrapKey,
          });

          const schemaInspection = await inspectFn({
            databaseUrl: binding.database_url,
            databaseAuthToken,
            expectedMigrations,
          });

          if (
            schemaInspection.missingMigrationNames.length > 0
            || schemaInspection.mismatchedMigrationNames.length > 0
            || schemaInspection.unexpectedMigrationNames.length > 0
          ) {
            findings.push({
              severity: "error",
              code: "binding_schema_migrations_mismatch",
              communityId: community.community_id,
              communityDatabaseBindingId: binding.community_database_binding_id,
              message: `binding schema_migrations drift detected (missing=${schemaInspection.missingMigrationNames.length}, mismatched=${schemaInspection.mismatchedMigrationNames.length}, unexpected=${schemaInspection.unexpectedMigrationNames.length})`,
            });
          }
        } catch (error) {
          const message = error instanceof Error ? error.message : String(error);
          findings.push({
            severity: "error",
            code: "binding_schema_migrations_unreadable",
            communityId: community.community_id,
            communityDatabaseBindingId: binding.community_database_binding_id,
            message: `binding schema_migrations could not be verified: ${message}`,
          });
        }
      }
    }

    return {
      checkedCommunityCount,
      checkedBindingCount,
      checkedCredentialCount,
      findingCount: findings.length,
      findings,
    };
  } finally {
    await db.close();
  }
}
