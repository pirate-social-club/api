import { openControlPlaneDatabase } from "../src/lib/control-plane-db";
import { nowIso, requireText } from "../src/lib/helpers";

/**
 * PR2 ROLLBACK: flip a community's routing row back from backend='d1' to 'turso'.
 *
 * The forward flip nulled turso_database_binding_id (0117 d1 CHECK requires it).
 * Rollback restores it from `communities.primary_database_binding_id` (untouched
 * by the routing flip — the community's primary Turso binding still exists), and
 * clears the d1 columns. Safe because non-preview reads + ALL writes still go to
 * Turso via openCommunityDb, so reverting the (preview) read path to Turso is
 * always consistent — and is the correct state to sit in until the PR3 write path
 * keeps D1 in sync (a flipped community's D1 is a point-in-time copy that goes
 * stale on any write).
 *
 * Only flips a row currently on 'd1' (re-run = no-op). Dry-run unless --apply.
 *
 * Usage:
 *   infisical run --env staging --path /services/api -- \
 *     bun run scripts/flip-community-to-turso.ts --community-id <C> [--apply]
 */

type Args = { communityId: string; apply: boolean };

function parseArgs(argv: string[]): Args {
  const a: Args = { communityId: "", apply: false };
  for (let i = 0; i < argv.length; i += 1) {
    if (argv[i] === "--community-id") {
      a.communityId = argv[i + 1]?.trim() ?? "";
      i += 1;
    } else if (argv[i] === "--apply") {
      a.apply = true;
    } else {
      throw new Error(`Unknown argument: ${argv[i]}`);
    }
  }
  if (!a.communityId) throw new Error("--community-id is required");
  return a;
}

async function main(): Promise<void> {
  const args = parseArgs(process.argv.slice(2));
  const url = requireText(process.env.CONTROL_PLANE_DATABASE_URL, "CONTROL_PLANE_DATABASE_URL");
  const authToken = process.env.TURSO_CONTROL_PLANE_AUTH_TOKEN?.trim() || null;
  const db = openControlPlaneDatabase({ url, authToken });
  try {
    const rows = await db.sql<{ backend: string; primary_database_binding_id: string | null }[]>`
      SELECT r.backend, c.primary_database_binding_id
      FROM community_database_routing r
      INNER JOIN communities c ON c.community_id = r.community_id
      WHERE r.community_id = ${args.communityId}
      LIMIT 1
    `;
    if (!rows.length) throw new Error(`No routing row (or community) for ${args.communityId}`);
    const { backend, primary_database_binding_id: bindingId } = rows[0];
    console.error(JSON.stringify({ before: { backend }, restore_turso_binding_id: bindingId }));

    if (backend !== "d1") {
      console.error(JSON.stringify({ mode: args.apply ? "apply" : "dry_run", noop: true, reason: `already backend='${backend}'` }));
      return;
    }
    if (!bindingId) {
      throw new Error(`communities.primary_database_binding_id is NULL for ${args.communityId} — cannot restore Turso binding`);
    }
    if (!args.apply) {
      console.error(JSON.stringify({ mode: "dry_run", would_restore_to: { backend: "turso", turso_database_binding_id: bindingId } }));
      return;
    }

    const now = nowIso();
    const updated = await db.sql<{ community_id: string }[]>`
      UPDATE community_database_routing
      SET backend = 'turso',
          provisioning_state = 'ready',
          turso_database_binding_id = ${bindingId},
          shard_worker_id = NULL,
          binding_name = NULL,
          region = NULL,
          migrated_at = NULL,
          updated_at = ${now}
      WHERE community_id = ${args.communityId} AND backend = 'd1'
      RETURNING community_id
    `;
    console.error(JSON.stringify({ mode: "apply", rolled_back: updated.length === 1, community_id: args.communityId }));
    if (updated.length !== 1) throw new Error(`Expected to roll back 1 row, got ${updated.length}`);
  } finally {
    await db.close();
  }
}

main().catch((error) => {
  console.error(error instanceof Error ? error.message : String(error));
  process.exit(1);
});
