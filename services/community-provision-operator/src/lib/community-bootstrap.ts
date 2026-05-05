import { createClient } from "@libsql/client";
import { COMMUNITY_MIGRATIONS } from "../generated/community-migrations";

type CommunityBootstrapSql = {
  execute<T>(sql: string, params?: Array<string | number | null>): Promise<T[]>;
  batch<T>(statements: Array<{ sql: string; args?: Array<string | number | null> }>): Promise<T[][]>;
  transaction<T>(fn: (tx: CommunityBootstrapSql) => Promise<T>): Promise<T>;
  close(): Promise<void>;
};

export type BootstrapCommunityDatabaseInput = {
  databaseUrl: string;
  databaseAuthToken?: string | null;
  communityId: string;
  userId: string;
  displayName: string;
  namespaceVerificationId: string | null;
  description?: string | null;
  avatarRef?: string | null;
  bannerRef?: string | null;
  membershipMode: "open" | "request" | "gated";
  defaultAgeGatePolicy: "none" | "18_plus";
  gatePolicy?: Record<string, unknown> | null;
  membershipUniqueHumanProvider?: "self" | "very" | null;
  postingUniqueHumanProvider?: "self" | "very" | null;
  handlePolicyTemplate: "standard" | "premium" | "membership_gated" | "custom";
  handlePricingModel?: string | null;
  namespaceLabel?: string | null;
  initialSettings?: Record<string, unknown> | null;
  now?: Date;
};

export type CommunityTemplateMigrationChecksum = {
  migrationName: string;
  checksum: string;
};

function createRemoteBootstrapSql(input: {
  databaseUrl: string;
  databaseAuthToken: string;
}): CommunityBootstrapSql {
  const client = createClient({
    url: input.databaseUrl,
    authToken: input.databaseAuthToken,
  });

  function isRetryableRemoteBootstrapError(error: unknown): boolean {
    const message = (error instanceof Error ? error.message : String(error)).toUpperCase();
    return message.includes("HTTP STATUS 401")
      || message.includes("TOKEN_INVALID")
      || message.includes("UNAUTHORIZED")
      || message.includes("AUTHENTICATION")
      || message.includes("AUTH");
  }

  async function retryRemoteBootstrap<T>(operation: () => Promise<T>): Promise<T> {
    const delaysMs = [200, 500, 1000, 1500];

    for (let attempt = 0; attempt <= delaysMs.length; attempt += 1) {
      try {
        return await operation();
      } catch (error) {
        if (!isRetryableRemoteBootstrapError(error) || attempt === delaysMs.length) {
          throw error;
        }
        await new Promise((resolve) => setTimeout(resolve, delaysMs[attempt]));
      }
    }

    throw new Error("remote bootstrap retry loop exhausted");
  }

  const impl: CommunityBootstrapSql = {
    async execute<T>(statement: string, params?: Array<string | number | null>): Promise<T[]> {
      const result = await retryRemoteBootstrap(() => client.execute({
        sql: statement,
        args: params ?? [],
      }));
      return result.rows as T[];
    },
    async batch<T>(statements: Array<{ sql: string; args?: Array<string | number | null> }>): Promise<T[][]> {
      const results = await retryRemoteBootstrap(() => client.batch(
        statements.map((stmt) => ({
          sql: stmt.sql,
          args: stmt.args ?? [],
        })),
        "write",
      ));
      return results.map((result) => result.rows as T[]);
    },
    async transaction<T>(fn: (tx: CommunityBootstrapSql) => Promise<T>): Promise<T> {
      return retryRemoteBootstrap(async () => {
        const tx = await client.transaction("write");
        const wrapped: CommunityBootstrapSql = {
          async execute<U>(statement: string, params?: Array<string | number | null>): Promise<U[]> {
            const result = await tx.execute({
              sql: statement,
              args: params ?? [],
            });
            return result.rows as U[];
          },
          async batch<U>(statements: Array<{ sql: string; args?: Array<string | number | null> }>): Promise<U[][]> {
            const results: U[][] = [];
            for (const stmt of statements) {
              const result = await tx.execute({
                sql: stmt.sql,
                args: stmt.args ?? [],
              });
              results.push(result.rows as U[]);
            }
            return results;
          },
          transaction() {
            throw new Error("nested_remote_bootstrap_transactions_not_supported");
          },
          async close() {},
        };

        try {
          const result = await fn(wrapped);
          await tx.commit();
          return result;
        } catch (error) {
          await tx.rollback();
          throw error;
        }
      });
    },
    async close() {
      client.close();
    },
  };
  return impl;
}

function communityBootstrapSql(input: { databaseUrl: string; databaseAuthToken?: string | null }): CommunityBootstrapSql {
  if (!input.databaseAuthToken) {
    throw new Error("missing_remote_community_db_auth_token");
  }

  return createRemoteBootstrapSql({
    databaseUrl: input.databaseUrl,
    databaseAuthToken: input.databaseAuthToken,
  });
}

async function ensureSchemaMigrationsTable(sql: CommunityBootstrapSql): Promise<void> {
  await sql.execute(`
    CREATE TABLE IF NOT EXISTS schema_migrations (
      migration_name TEXT PRIMARY KEY,
      migration_label TEXT NOT NULL,
      checksum TEXT NOT NULL,
      applied_at TEXT NOT NULL DEFAULT CURRENT_TIMESTAMP
    )
  `);
}

function splitSqlStatements(source: string): string[] {
  const statements: string[] = [];
  let current = "";
  let inSingleQuote = false;
  let inLineComment = false;

  for (let index = 0; index < source.length; index += 1) {
    const char = source[index];
    const next = source[index + 1] ?? "";

    if (inLineComment) {
      current += char;
      if (char === "\n") {
        inLineComment = false;
      }
      continue;
    }

    if (!inSingleQuote && char === "-" && next === "-") {
      inLineComment = true;
      current += char;
      continue;
    }

    if (char === "'") {
      current += char;
      if (inSingleQuote && next === "'") {
        current += next;
        index += 1;
        continue;
      }
      inSingleQuote = !inSingleQuote;
      continue;
    }

    if (!inSingleQuote && char === ";") {
      const statement = current.trim();
      if (statement) {
        statements.push(statement);
      }
      current = "";
      continue;
    }

    current += char;
  }

  const trailing = current.trim();
  if (trailing) {
    statements.push(trailing);
  }

  return statements;
}

export function listExpectedCommunityMigrationChecksums(): CommunityTemplateMigrationChecksum[] {
  return COMMUNITY_MIGRATIONS.map((migration) => ({
    migrationName: migration.name,
    checksum: migration.checksum,
  }));
}

async function readSchemaMigrationChecksums(sql: CommunityBootstrapSql): Promise<Map<string, string>> {
  await ensureSchemaMigrationsTable(sql);

  const rows = await sql.execute<{ migration_name: string; checksum: string }>(
    "SELECT migration_name, checksum FROM schema_migrations ORDER BY migration_name ASC",
  );
  return new Map(
    rows
      .map((row) => [String(row.migration_name ?? "").trim(), String(row.checksum ?? "").trim()] as const)
      .filter(([migrationName]) => migrationName.length > 0),
  );
}

async function applyCommunityMigrations(sql: CommunityBootstrapSql): Promise<{ applied: number; skipped: number }> {
  const existingByName = await readSchemaMigrationChecksums(sql);

  const pending: Array<{ sql: string; args?: Array<string | number | null> }> = [];
  let applied = 0;
  let skipped = 0;

  for (const migration of COMMUNITY_MIGRATIONS) {
    const existingChecksum = existingByName.get(migration.name) ?? null;

    if (existingChecksum) {
      if (existingChecksum !== migration.checksum) {
        throw new Error(`schema_migration_checksum_mismatch:${migration.name}`);
      }
      skipped += 1;
      continue;
    }

    pending.push(
      ...splitSqlStatements(migration.sql).map((statement) => ({ sql: statement })),
      {
        sql: `INSERT INTO schema_migrations (
           migration_name,
           migration_label,
           checksum
         ) VALUES (?, ?, ?)`,
        args: [migration.name, "community-template", migration.checksum],
      },
    );
    applied += 1;
  }

  if (pending.length > 0) {
    await sql.batch(pending);
  }

  return { applied, skipped };
}

async function upsertUniqueHumanGatePolicy(
  tx: CommunityBootstrapSql,
  input: {
    communityId: string;
    provider?: "self" | "very" | null;
    scope: "membership" | "posting";
    timestamp: string;
  },
): Promise<void> {
  if (!input.provider) {
    await tx.execute(
      `DELETE FROM community_gate_policies
       WHERE community_id = ?
         AND scope = ?`,
      [input.communityId, input.scope],
    );
    return;
  }

  const expressionJson = JSON.stringify({
    version: 1,
    expression: {
      op: "gate",
      gate: {
        type: "unique_human",
        provider: input.provider,
      },
    },
  });

  await tx.execute(
    `INSERT INTO community_gate_policies (
       community_id,
       scope,
       version,
       expression_json,
       created_at,
       updated_at
     ) VALUES (?, ?, 1, ?, ?, ?)
     ON CONFLICT(community_id, scope) DO UPDATE SET
       version = excluded.version,
       expression_json = excluded.expression_json,
       updated_at = excluded.updated_at`,
    [
      input.communityId,
      input.scope,
      expressionJson,
      input.timestamp,
      input.timestamp,
    ],
  );
}

async function upsertMembershipGatePolicy(
  tx: CommunityBootstrapSql,
  input: {
    communityId: string;
    gatePolicy?: Record<string, unknown> | null;
    timestamp: string;
  },
): Promise<void> {
  if (!input.gatePolicy) {
    await tx.execute(
      `DELETE FROM community_gate_policies
       WHERE community_id = ?
         AND scope = 'membership'`,
      [input.communityId],
    );
    return;
  }

  await tx.execute(
    `INSERT INTO community_gate_policies (
       community_id,
       scope,
       version,
       expression_json,
       created_at,
       updated_at
     ) VALUES (?, 'membership', 1, ?, ?, ?)
     ON CONFLICT(community_id, scope) DO UPDATE SET
       version = excluded.version,
       expression_json = excluded.expression_json,
       updated_at = excluded.updated_at`,
    [
      input.communityId,
      JSON.stringify(input.gatePolicy),
      input.timestamp,
      input.timestamp,
    ],
  );
}

export type MigrateCommunityDatabaseInput = {
  databaseUrl: string;
  databaseAuthToken: string;
};

export async function migrateCommunityDatabase(
  input: MigrateCommunityDatabaseInput,
): Promise<{ applied: number; skipped: number }> {
  const sql = communityBootstrapSql({
    databaseUrl: input.databaseUrl,
    databaseAuthToken: input.databaseAuthToken,
  });

  try {
    return await applyCommunityMigrations(sql);
  } finally {
    await sql.close();
  }
}

export async function bootstrapCommunityDatabase(
  input: BootstrapCommunityDatabaseInput,
): Promise<{
  databaseUrl: string;
  communityId: string;
  namespaceId: string | null;
}> {
  const sql = communityBootstrapSql({
    databaseUrl: input.databaseUrl,
    databaseAuthToken: input.databaseAuthToken,
  });
  const timestamp = (input.now ?? new Date()).toISOString();
  const namespaceLabel = input.namespaceLabel?.trim() || null;
  const namespaceId = input.namespaceVerificationId ? `ns_${input.communityId}` : null;
  const namespaceHandlePolicyId = input.namespaceVerificationId ? `nhp_${input.communityId}` : null;
  const membershipId = `mbr_${input.communityId}_${input.userId}`;
  const roleAssignmentId = `role_${input.communityId}_${input.userId}_owner`;
  const initialSettingsJson = input.initialSettings && Object.keys(input.initialSettings).length > 0
    ? JSON.stringify(input.initialSettings)
    : null;

  try {
    await applyCommunityMigrations(sql);

    await sql.transaction(async (tx) => {
      await tx.execute(
        `INSERT INTO communities (
           community_id,
           display_name,
           description,
           avatar_ref,
           banner_ref,
           status,
           artist_identity_id,
           artist_governance_state,
           membership_mode,
           default_age_gate_policy,
           allow_anonymous_identity,
           anonymous_identity_scope,
           donation_partner_id,
           donation_policy_mode,
           donation_partner_status,
           governance_mode,
           settings_json,
           created_by_user_id,
           created_at,
           updated_at
         ) VALUES (?, ?, ?, ?, ?, 'active', NULL, 'fan_run', ?, ?, 0, NULL, NULL, 'none', 'unconfigured', 'centralized', ?, ?, ?, ?)
         ON CONFLICT(community_id) DO UPDATE SET
           display_name = excluded.display_name,
           description = excluded.description,
           avatar_ref = excluded.avatar_ref,
           banner_ref = excluded.banner_ref,
           status = excluded.status,
           membership_mode = excluded.membership_mode,
           default_age_gate_policy = excluded.default_age_gate_policy,
           donation_policy_mode = excluded.donation_policy_mode,
           donation_partner_status = excluded.donation_partner_status,
           updated_at = excluded.updated_at`,
        [
          input.communityId,
          input.displayName,
          input.description ?? null,
          input.avatarRef ?? null,
          input.bannerRef ?? null,
          input.membershipMode,
          input.defaultAgeGatePolicy,
          initialSettingsJson,
          input.userId,
          timestamp,
          timestamp,
        ],
      );

      await tx.execute(
        `INSERT INTO community_memberships (
           membership_id,
           community_id,
           user_id,
           status,
           joined_at,
           left_at,
           banned_at,
           created_at,
           updated_at
         ) VALUES (?, ?, ?, 'member', ?, NULL, NULL, ?, ?)
         ON CONFLICT(membership_id) DO UPDATE SET
           status = excluded.status,
           joined_at = excluded.joined_at,
           left_at = excluded.left_at,
           banned_at = excluded.banned_at,
           updated_at = excluded.updated_at`,
        [
          membershipId,
          input.communityId,
          input.userId,
          timestamp,
          timestamp,
          timestamp,
        ],
      );

      await tx.execute(
        `INSERT INTO community_roles (
           role_assignment_id,
           community_id,
           user_id,
           role,
           status,
           granted_by_user_id,
           granted_at,
           revoked_at,
           created_at,
           updated_at
         ) VALUES (?, ?, ?, 'owner', 'active', ?, ?, NULL, ?, ?)
         ON CONFLICT(role_assignment_id) DO UPDATE SET
           status = excluded.status,
           granted_at = excluded.granted_at,
           revoked_at = excluded.revoked_at,
           updated_at = excluded.updated_at`,
        [
          roleAssignmentId,
          input.communityId,
          input.userId,
          input.userId,
          timestamp,
          timestamp,
          timestamp,
        ],
      );

      if (input.namespaceVerificationId && namespaceId && namespaceHandlePolicyId && namespaceLabel) {
        await tx.execute(
          `INSERT INTO namespace_bindings (
             namespace_id,
             community_id,
             namespace_verification_id,
             display_label,
             normalized_label,
             resolver_label,
             route_family,
             status,
             created_at,
             updated_at
           ) VALUES (?, ?, ?, ?, ?, NULL, NULL, 'active', ?, ?)
           ON CONFLICT(namespace_id) DO UPDATE SET
             namespace_verification_id = excluded.namespace_verification_id,
             display_label = excluded.display_label,
             normalized_label = excluded.normalized_label,
             status = excluded.status,
             updated_at = excluded.updated_at`,
          [
            namespaceId,
            input.communityId,
            input.namespaceVerificationId,
            namespaceLabel,
            namespaceLabel,
            timestamp,
            timestamp,
          ],
        );

        await tx.execute(
          `INSERT INTO namespace_handle_policies (
             namespace_handle_policy_id,
             community_id,
             namespace_id,
             policy_template,
             pricing_model,
             membership_required_for_claim,
             settings_json,
             created_at,
             updated_at
           ) VALUES (?, ?, ?, ?, ?, 1, NULL, ?, ?)
           ON CONFLICT(namespace_handle_policy_id) DO UPDATE SET
             policy_template = excluded.policy_template,
             pricing_model = excluded.pricing_model,
             membership_required_for_claim = excluded.membership_required_for_claim,
             updated_at = excluded.updated_at`,
          [
            namespaceHandlePolicyId,
            input.communityId,
            namespaceId,
            input.handlePolicyTemplate,
            input.handlePricingModel ?? null,
            timestamp,
            timestamp,
          ],
        );
      }

      if (input.gatePolicy) {
        await upsertMembershipGatePolicy(tx, {
          communityId: input.communityId,
          gatePolicy: input.gatePolicy,
          timestamp,
        });
      } else {
        await upsertUniqueHumanGatePolicy(tx, {
          communityId: input.communityId,
          provider: input.membershipUniqueHumanProvider,
          scope: "membership",
          timestamp,
        });
      }

      await upsertUniqueHumanGatePolicy(tx, {
        communityId: input.communityId,
        provider: input.postingUniqueHumanProvider,
        scope: "posting",
        timestamp,
      });
    });

    return {
      databaseUrl: input.databaseUrl,
      communityId: input.communityId,
      namespaceId,
    };
  } finally {
    await sql.close();
  }
}
