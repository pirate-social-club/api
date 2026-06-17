import { openControlPlaneDatabase } from "../src/lib/control-plane-db";
import { nowIso, requireText } from "../src/lib/helpers";

/**
 * PR2: flip a community's routing row from backend='turso' to backend='d1' after
 * its data has been copied + parity-verified into the shard's D1. Satisfies the
 * 0117 CHECK (d1 requires shard_worker_id/binding_name/region NOT NULL and
 * turso_database_binding_id NULL). Only flips a row currently on 'turso' (so a
 * re-run is a no-op, and it never clobbers an already-migrated row).
 *
 * Usage (dry-run unless --apply):
 *   infisical run --env staging --path /services/api -- bun run scripts/flip-community-to-d1.ts \
 *     --community-id <C> --shard-worker-id community-d1-shard-staging --binding-name DB_CMTY_PILOT --region enam [--apply]
 */

type Args = {
  communityId: string;
  shardWorkerId: string;
  bindingName: string;
  region: string;
  apply: boolean;
};

function parseArgs(argv: string[]): Args {
  const a: Args = { communityId: "", shardWorkerId: "", bindingName: "", region: "", apply: false };
  for (let i = 0; i < argv.length; i += 1) {
    const v = argv[i + 1]?.trim();
    switch (argv[i]) {
      case "--community-id": a.communityId = v ?? ""; i += 1; break;
      case "--shard-worker-id": a.shardWorkerId = v ?? ""; i += 1; break;
      case "--binding-name": a.bindingName = v ?? ""; i += 1; break;
      case "--region": a.region = v ?? ""; i += 1; break;
      case "--apply": a.apply = true; break;
      default: throw new Error(`Unknown argument: ${argv[i]}`);
    }
  }
  for (const [k, val] of Object.entries({ communityId: a.communityId, shardWorkerId: a.shardWorkerId, bindingName: a.bindingName, region: a.region })) {
    if (!val) throw new Error(`--${k.replace(/[A-Z]/g, (m) => "-" + m.toLowerCase())} is required`);
  }
  return a;
}

async function main(): Promise<void> {
  const args = parseArgs(process.argv.slice(2));
  const url = requireText(process.env.CONTROL_PLANE_DATABASE_URL, "CONTROL_PLANE_DATABASE_URL");
  const authToken = process.env.TURSO_CONTROL_PLANE_AUTH_TOKEN?.trim() || null;
  const db = openControlPlaneDatabase({ url, authToken });
  try {
    const before = await db.sql<{ backend: string; binding_name: string | null }[]>`
      SELECT backend, binding_name FROM community_database_routing WHERE community_id = ${args.communityId} LIMIT 1
    `;
    if (!before.length) throw new Error(`No routing row for ${args.communityId} (run backfill:routing first)`);
    console.error(JSON.stringify({ before: before[0] }));

    if (!args.apply) {
      console.error(JSON.stringify({ mode: "dry_run", would_flip_to: { backend: "d1", shardWorkerId: args.shardWorkerId, bindingName: args.bindingName, region: args.region } }));
      return;
    }

    const now = nowIso();
    const updated = await db.sql<{ community_id: string }[]>`
      UPDATE community_database_routing
      SET backend = 'd1',
          provisioning_state = 'ready',
          shard_worker_id = ${args.shardWorkerId},
          binding_name = ${args.bindingName},
          region = ${args.region},
          turso_database_binding_id = NULL,
          migrated_at = ${now},
          updated_at = ${now}
      WHERE community_id = ${args.communityId} AND backend = 'turso'
      RETURNING community_id
    `;
    console.error(JSON.stringify({ mode: "apply", flipped: updated.length === 1, community_id: args.communityId }));
    if (updated.length !== 1) throw new Error(`Expected to flip 1 row (turso→d1), flipped ${updated.length} — row may already be d1`);
  } finally {
    await db.close();
  }
}

main().catch((error) => {
  console.error(error instanceof Error ? error.message : String(error));
  process.exit(1);
});
