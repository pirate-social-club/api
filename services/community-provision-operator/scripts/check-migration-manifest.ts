import { createHash } from "node:crypto";
import { existsSync, readdirSync, readFileSync } from "node:fs";
import { resolve } from "node:path";
import { COMMUNITY_MIGRATIONS } from "../src/generated/community-migrations";

const CORE_REPO_ROOT = process.env.PIRATE_CORE_REPO
  ? resolve(process.env.PIRATE_CORE_REPO)
  : resolve(import.meta.dir, "../../../../core");
const MIGRATIONS_DIR = resolve(CORE_REPO_ROOT, "db/community-template/migrations");

function checksumSql(sql: string): string {
  return createHash("sha256").update(sql).digest("hex");
}

if (!existsSync(MIGRATIONS_DIR)) {
  console.error(`Community migration directory not found: ${MIGRATIONS_DIR}`);
  process.exit(1);
}

const expected = readdirSync(MIGRATIONS_DIR)
  .filter((name) => name.endsWith(".sql"))
  .sort()
  .map((name) => {
    const sql = readFileSync(resolve(MIGRATIONS_DIR, name), "utf8");
    return { name, checksum: checksumSql(sql) };
  });

const actual = COMMUNITY_MIGRATIONS.map((migration) => ({
  name: migration.name,
  checksum: migration.checksum,
}));

const failures: string[] = [];
const expectedByName = new Map(expected.map((entry) => [entry.name, entry.checksum]));
const actualByName = new Map(actual.map((entry) => [entry.name, entry.checksum]));

for (const entry of expected) {
  const actualChecksum = actualByName.get(entry.name);
  if (!actualChecksum) {
    failures.push(`missing from generated manifest: ${entry.name}`);
    continue;
  }
  if (actualChecksum !== entry.checksum) {
    failures.push(`checksum mismatch for ${entry.name}`);
  }
}

for (const entry of actual) {
  if (!expectedByName.has(entry.name)) {
    failures.push(`unexpected generated migration: ${entry.name}`);
  }
}

if (actual.map((entry) => entry.name).join("\n") !== expected.map((entry) => entry.name).join("\n")) {
  failures.push("generated manifest order differs from sorted migration files");
}

if (failures.length > 0) {
  console.error("community migration manifest is stale");
  for (const failure of failures) {
    console.error(`- ${failure}`);
  }
  console.error("Run: bun run generate:migrations");
  process.exit(1);
}

console.log(`community migration manifest is fresh (${expected.length} migrations)`);
