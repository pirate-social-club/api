import { readdirSync, statSync } from "node:fs";
import { join, relative } from "node:path";
import { spawnSync } from "node:child_process";

function findTestFiles(root: string): string[] {
  const files: string[] = [];

  for (const entry of readdirSync(root)) {
    const path = join(root, entry);
    const stat = statSync(path);

    if (stat.isDirectory()) {
      files.push(...findTestFiles(path));
      continue;
    }

    if (entry.endsWith(".test.ts")) {
      files.push(path);
    }
  }

  return files;
}

const args = process.argv.slice(2);
const dryRun = args.includes("--dry-run");
const explicitTestFiles = args.filter((arg) => arg !== "--dry-run");

const testFiles =
  explicitTestFiles.length > 0
    ? explicitTestFiles
    : [
        ...findTestFiles("tests/routes"),
        "tests/community-membership-reconciliation.test.ts",
      ]
        .map((path) => relative(process.cwd(), path))
        .sort();

for (const [index, testFile] of testFiles.entries()) {
  console.log(
    `[route-tests] ${index + 1}/${testFiles.length} ${testFile}`,
  );

  if (dryRun) {
    continue;
  }

  const result = spawnSync("bun", [
    "test",
    "--max-concurrency=1",
    "--timeout",
    "30000",
    testFile,
  ], {
    stdio: "inherit",
  });

  if (result.status !== 0) {
    process.exit(result.status ?? 1);
  }
}
