import { readdirSync, readFileSync } from "node:fs";

import { resolveCoreRepoPath } from "../../../shared/core-repo-paths";

export async function applyCanonicalBookingMigrations(db: { unsafe(sql: string): Promise<unknown> }): Promise<void> {
  const dir = resolveCoreRepoPath("db/bookings/migrations");
  const files = readdirSync(dir)
    .filter((file) => /^b\d{4}_.+\.sql$/u.test(file))
    .sort();
  for (const file of files) {
    await db.unsafe(readFileSync(`${dir}/${file}`, "utf8"));
  }
}
