import { openControlPlaneDatabase } from "../src/lib/control-plane-db";
import { nowIso, requireText } from "../src/lib/helpers";

/**
 * Phase-0 backfill: seed a `backend='turso'` row in `community_database_routing`
 * for every live community, so the read router can be consulted without 404-ing
 * communities that predate the routing directory (migration 0117).
 *
 * Idempotent: `ON CONFLICT (community_id) DO NOTHING`, so re-running never
 * mutates an existing row — including one the provisioning path (PR2+) already
 * flipped to `d1`. Dry-runs by default; pass `--apply` to write.
 */

type Args = {
  apply: boolean;
  communityId: string | null;
  limit: number | null;
};

type TargetRow = {
  community_id: string;
  community_database_binding_id: string;
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
      console.log(`Usage: bun run backfill:routing -- [--apply] [--community-id ID] [--limit N]

Dry-runs by default. With --apply, seeds a backend='turso' routing row for every active
community that has a primary active Turso binding. Idempotent (ON CONFLICT DO NOTHING).`);
      process.exit(0);
    }
    throw new Error(`Unknown argument: ${arg}`);
  }
  return args;
}

async function main(): Promise<void> {
  const args = parseArgs(process.argv.slice(2));
  const controlPlaneDatabaseUrl = requireText(process.env.CONTROL_PLANE_DATABASE_URL, "CONTROL_PLANE_DATABASE_URL");
  const controlPlaneAuthToken = process.env.TURSO_CONTROL_PLANE_AUTH_TOKEN?.trim() || null;

  const db = openControlPlaneDatabase({ url: controlPlaneDatabaseUrl, authToken: controlPlaneAuthToken });
  let seeded = 0;
  let skipped = 0;
  let failed = 0;
  let checked = 0;

  try {
    const targets = args.communityId
      ? await db.sql<TargetRow[]>`
          SELECT c.community_id, cdb.community_database_binding_id
          FROM communities AS c
          INNER JOIN community_database_bindings AS cdb
            ON cdb.community_database_binding_id = c.primary_database_binding_id
          WHERE c.status = 'active'
            AND c.provisioning_state = 'active'
            AND cdb.binding_role = 'primary'
            AND cdb.status = 'active'
            AND cdb.database_url LIKE 'libsql://%'
            AND c.community_id = ${args.communityId}
          ORDER BY c.created_at ASC, c.community_id ASC
        `
      : await db.sql<TargetRow[]>`
          SELECT c.community_id, cdb.community_database_binding_id
          FROM communities AS c
          INNER JOIN community_database_bindings AS cdb
            ON cdb.community_database_binding_id = c.primary_database_binding_id
          WHERE c.status = 'active'
            AND c.provisioning_state = 'active'
            AND cdb.binding_role = 'primary'
            AND cdb.status = 'active'
            AND cdb.database_url LIKE 'libsql://%'
          ORDER BY c.created_at ASC, c.community_id ASC
        `;

    const scoped = args.limit ? targets.slice(0, args.limit) : targets;

    for (const target of scoped) {
      checked += 1;
      const log = {
        community_id: target.community_id,
        binding_id: target.community_database_binding_id,
        status: args.apply ? "pending" : "dry_run",
        error: null as string | null,
      };
      if (args.apply) {
        try {
          const now = nowIso();
          const inserted = await db.sql<{ community_id: string }[]>`
            INSERT INTO community_database_routing
              (community_id, backend, provisioning_state, turso_database_binding_id, created_at, updated_at)
            VALUES (${target.community_id}, 'turso', 'ready', ${target.community_database_binding_id}, ${now}, ${now})
            ON CONFLICT (community_id) DO NOTHING
            RETURNING community_id
          `;
          if (inserted.length > 0) {
            log.status = "seeded";
            seeded += 1;
          } else {
            log.status = "skipped";
            skipped += 1;
          }
        } catch (error) {
          log.status = "failed";
          log.error = error instanceof Error ? error.message : String(error);
          failed += 1;
        }
      }
      console.log(JSON.stringify(log));
    }
  } finally {
    await db.close();
  }

  console.error(JSON.stringify({
    mode: args.apply ? "apply" : "dry_run",
    checked,
    seeded,
    skipped,
    failed,
  }));
  if (failed > 0) process.exit(1);
}

main().catch((error) => {
  console.error(error instanceof Error ? error.message : String(error));
  process.exit(1);
});
