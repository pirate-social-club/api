import { migrateCommunityDatabase } from "../src/lib/community-bootstrap";
import { openControlPlaneDatabase } from "../src/lib/control-plane-db";
import { decryptCommunityDbCredential } from "../src/lib/credential-crypto";
import { requireText } from "../src/lib/helpers";

type Args = {
  apply: boolean;
  communityId: string | null;
  limit: number | null;
};

type TargetRow = {
  community_id: string;
  community_database_binding_id: string;
  database_url: string;
  encrypted_token: string;
  encryption_key_version: number;
};

function parseArgs(argv: string[]): Args {
  const args: Args = { apply: false, communityId: null, limit: null };
  for (let index = 0; index < argv.length; index += 1) {
    const arg = argv[index];
    if (arg === "--apply") {
      args.apply = true;
      continue;
    }
    if (arg === "--community-id") {
      const value = argv[index + 1]?.trim();
      if (!value) throw new Error("--community-id requires a value");
      args.communityId = value;
      index += 1;
      continue;
    }
    if (arg === "--limit") {
      const value = Number(argv[index + 1]);
      if (!Number.isInteger(value) || value <= 0) {
        throw new Error("--limit requires a positive integer");
      }
      args.limit = value;
      index += 1;
      continue;
    }
    if (arg === "--help" || arg === "-h") {
      console.log(`Usage: bun run backfill:migrations -- [--apply] [--community-id ID] [--limit N]

Dry-runs by default. With --apply, decrypts each active remote community DB credential and applies pending
community-template migrations using this operator build's generated manifest.`);
      process.exit(0);
    }
    throw new Error(`Unknown argument: ${arg}`);
  }
  return args;
}

async function listTargets(input: {
  controlPlaneDatabaseUrl: string;
  controlPlaneAuthToken: string | null;
  communityId: string | null;
  limit: number | null;
}): Promise<TargetRow[]> {
  const db = openControlPlaneDatabase({
    url: input.controlPlaneDatabaseUrl,
    authToken: input.controlPlaneAuthToken,
  });
  try {
    const rows = input.communityId
      ? await db.sql<TargetRow[]>`
          SELECT c.community_id, cdb.community_database_binding_id, cdb.database_url,
                 cdc.encrypted_token, cdc.encryption_key_version
          FROM communities AS c
          INNER JOIN community_database_bindings AS cdb
            ON cdb.community_database_binding_id = c.primary_database_binding_id
          INNER JOIN community_db_credentials AS cdc
            ON cdc.community_database_binding_id = cdb.community_database_binding_id
          WHERE c.status = 'active'
            AND c.provisioning_state = 'active'
            AND cdb.binding_role = 'primary'
            AND cdb.status = 'active'
            AND cdb.database_url LIKE 'libsql://%'
            AND cdc.status = 'active'
            AND c.community_id = ${input.communityId}
          ORDER BY c.created_at ASC, c.community_id ASC
        `
      : await db.sql<TargetRow[]>`
          SELECT c.community_id, cdb.community_database_binding_id, cdb.database_url,
                 cdc.encrypted_token, cdc.encryption_key_version
          FROM communities AS c
          INNER JOIN community_database_bindings AS cdb
            ON cdb.community_database_binding_id = c.primary_database_binding_id
          INNER JOIN community_db_credentials AS cdc
            ON cdc.community_database_binding_id = cdb.community_database_binding_id
          WHERE c.status = 'active'
            AND c.provisioning_state = 'active'
            AND cdb.binding_role = 'primary'
            AND cdb.status = 'active'
            AND cdb.database_url LIKE 'libsql://%'
            AND cdc.status = 'active'
          ORDER BY c.created_at ASC, c.community_id ASC
        `;
    return input.limit ? rows.slice(0, input.limit) : rows;
  } finally {
    await db.close();
  }
}

async function main(): Promise<void> {
  const args = parseArgs(process.argv.slice(2));
  const controlPlaneDatabaseUrl = requireText(process.env.CONTROL_PLANE_DATABASE_URL, "CONTROL_PLANE_DATABASE_URL");
  const controlPlaneAuthToken = process.env.TURSO_CONTROL_PLANE_AUTH_TOKEN?.trim() || null;
  const wrapKey = requireText(process.env.TURSO_COMMUNITY_DB_WRAP_KEY, "TURSO_COMMUNITY_DB_WRAP_KEY");

  const targets = await listTargets({
    controlPlaneDatabaseUrl,
    controlPlaneAuthToken,
    communityId: args.communityId,
    limit: args.limit,
  });
  let failed = 0;
  let appliedTotal = 0;

  for (const target of targets) {
    const row = {
      community_id: target.community_id,
      binding_id: target.community_database_binding_id,
      database_url: target.database_url,
      status: args.apply ? "migrated" : "dry_run",
      applied: null as number | null,
      skipped: null as number | null,
      error: null as string | null,
    };
    if (args.apply) {
      try {
        const databaseAuthToken = await decryptCommunityDbCredential({
          encryptedToken: target.encrypted_token,
          encryptionKeyVersion: Number(target.encryption_key_version),
          wrapKey,
        });
        const result = await migrateCommunityDatabase({
          databaseUrl: target.database_url,
          databaseAuthToken,
        });
        row.applied = result.applied;
        row.skipped = result.skipped;
        appliedTotal += result.applied;
      } catch (error) {
        row.status = "failed";
        row.error = error instanceof Error ? error.message : String(error);
        failed += 1;
      }
    }
    console.log(JSON.stringify(row));
  }

  console.error(JSON.stringify({
    mode: args.apply ? "apply" : "dry_run",
    checked: targets.length,
    failed,
    applied: appliedTotal,
  }));
  if (failed > 0) process.exit(1);
}

main().catch((error) => {
  console.error(error instanceof Error ? error.message : String(error));
  process.exit(1);
});
