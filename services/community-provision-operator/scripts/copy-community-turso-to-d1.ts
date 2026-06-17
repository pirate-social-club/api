import { createClient } from "@libsql/client";
import { openControlPlaneDatabase } from "../src/lib/control-plane-db";
import { decryptCommunityDbCredential } from "../src/lib/credential-crypto";
import { requireText } from "../src/lib/helpers";

/**
 * PR2 pilot data-copy: dump one community's Turso DB (schema + data) to a single
 * SQL file that `wrangler d1 execute --file` loads into its D1 shard binding, and
 * emit per-table row counts for parity verification.
 *
 * Read-only against Turso. Does NOT touch the control plane beyond reading the
 * community's primary binding + credential. Idempotent dump (CREATE IF NOT
 * EXISTS + delete-before-insert per table) so re-running converges.
 *
 * Usage:
 *   infisical run --env staging --path /services/api -- \
 *     bun run scripts/copy-community-turso-to-d1.ts --community-id <C> --out /tmp/pilot-dump.sql
 */

type Args = { communityId: string; out: string };

function parseArgs(argv: string[]): Args {
  let communityId = "";
  let out = "/tmp/pilot-dump.sql";
  for (let i = 0; i < argv.length; i += 1) {
    if (argv[i] === "--community-id") {
      communityId = argv[i + 1]?.trim() ?? "";
      i += 1;
    } else if (argv[i] === "--out") {
      out = argv[i + 1]?.trim() ?? out;
      i += 1;
    } else if (argv[i] === "--help" || argv[i] === "-h") {
      console.log("Usage: --community-id <C> [--out <file.sql>]");
      process.exit(0);
    } else {
      throw new Error(`Unknown argument: ${argv[i]}`);
    }
  }
  if (!communityId) throw new Error("--community-id is required");
  return { communityId, out };
}

function sqlLiteral(value: unknown): string {
  if (value === null || value === undefined) return "NULL";
  if (typeof value === "number") return Number.isFinite(value) ? String(value) : "NULL";
  if (typeof value === "bigint") return value.toString();
  if (typeof value === "boolean") return value ? "1" : "0";
  if (value instanceof ArrayBuffer || ArrayBuffer.isView(value)) {
    // Respect a view's byteOffset/byteLength — a subarray's underlying buffer
    // may be larger; serializing the whole buffer would corrupt the blob.
    const bytes =
      value instanceof ArrayBuffer
        ? new Uint8Array(value)
        : new Uint8Array(
            (value as ArrayBufferView).buffer,
            (value as ArrayBufferView).byteOffset,
            (value as ArrayBufferView).byteLength,
          );
    let hex = "";
    for (const b of bytes) hex += b.toString(16).padStart(2, "0");
    return `X'${hex}'`;
  }
  return `'${String(value).replace(/'/g, "''")}'`;
}

async function main(): Promise<void> {
  const args = parseArgs(process.argv.slice(2));
  const controlPlaneDatabaseUrl = requireText(process.env.CONTROL_PLANE_DATABASE_URL, "CONTROL_PLANE_DATABASE_URL");
  const controlPlaneAuthToken = process.env.TURSO_CONTROL_PLANE_AUTH_TOKEN?.trim() || null;
  const wrapKey = requireText(process.env.TURSO_COMMUNITY_DB_WRAP_KEY, "TURSO_COMMUNITY_DB_WRAP_KEY");

  const cp = openControlPlaneDatabase({ url: controlPlaneDatabaseUrl, authToken: controlPlaneAuthToken });
  let databaseUrl: string;
  let encryptedToken: string;
  let encryptionKeyVersion: number;
  try {
    const rows = await cp.sql<{ database_url: string; encrypted_token: string; encryption_key_version: number }[]>`
      SELECT cdb.database_url, cdc.encrypted_token, cdc.encryption_key_version
      FROM communities AS c
      INNER JOIN community_database_bindings AS cdb
        ON cdb.community_database_binding_id = c.primary_database_binding_id
      INNER JOIN community_db_credentials AS cdc
        ON cdc.community_database_binding_id = cdb.community_database_binding_id
      WHERE c.community_id = ${args.communityId}
        AND cdb.binding_role = 'primary' AND cdb.status = 'active' AND cdc.status = 'active'
      LIMIT 1
    `;
    if (!rows.length) throw new Error(`No active primary Turso binding for ${args.communityId}`);
    databaseUrl = rows[0].database_url;
    encryptedToken = rows[0].encrypted_token;
    encryptionKeyVersion = Number(rows[0].encryption_key_version);
  } finally {
    await cp.close();
  }

  const authToken = await decryptCommunityDbCredential({ encryptedToken, encryptionKeyVersion, wrapKey });
  const turso = createClient({ url: databaseUrl, authToken });

  const tables = await turso.execute(
    `SELECT name, sql FROM sqlite_master WHERE type='table' AND name NOT LIKE 'sqlite_%' AND sql IS NOT NULL ORDER BY name`,
  );
  const indexes = await turso.execute(
    `SELECT sql FROM sqlite_master WHERE type='index' AND name NOT LIKE 'sqlite_%' AND sql IS NOT NULL`,
  );

  const parts: string[] = ["PRAGMA foreign_keys=OFF;"];
  const counts: Record<string, number> = {};

  // Schema (idempotent) + data (delete-then-insert so re-runs converge).
  for (const t of tables.rows) {
    const name = String((t as Record<string, unknown>).name);
    const createSql = String((t as Record<string, unknown>).sql).replace(/^CREATE TABLE/i, "CREATE TABLE IF NOT EXISTS");
    parts.push(`${createSql};`);
    parts.push(`DELETE FROM "${name}";`);
    const data = await turso.execute(`SELECT * FROM "${name}"`);
    counts[name] = data.rows.length;
    if (data.rows.length > 0) {
      const cols = data.columns;
      const colList = cols.map((c) => `"${c}"`).join(", ");
      for (const row of data.rows) {
        const vals = cols.map((c) => sqlLiteral((row as Record<string, unknown>)[c])).join(", ");
        parts.push(`INSERT INTO "${name}" (${colList}) VALUES (${vals});`);
      }
    }
  }
  for (const idx of indexes.rows) {
    const idxSql = String((idx as Record<string, unknown>).sql).replace(/^CREATE INDEX/i, "CREATE INDEX IF NOT EXISTS").replace(/^CREATE UNIQUE INDEX/i, "CREATE UNIQUE INDEX IF NOT EXISTS");
    parts.push(`${idxSql};`);
  }
  parts.push("PRAGMA foreign_keys=ON;");

  await Bun.write(args.out, parts.join("\n") + "\n");
  console.error(JSON.stringify({ community_id: args.communityId, out: args.out, tables: Object.keys(counts).length, counts }));
}

main().catch((error) => {
  console.error(error instanceof Error ? error.message : String(error));
  process.exit(1);
});
