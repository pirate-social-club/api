import { readdirSync, statSync } from "node:fs";
import { join, relative } from "node:path";
import { spawn } from "node:child_process";

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
const bunTestTimeoutMs = Number(
  process.env.ROUTE_TEST_BUN_TIMEOUT_MS ?? "30000",
);
const processTimeoutMs = Number(
  process.env.ROUTE_TEST_PROCESS_TIMEOUT_MS ?? "120000",
);
const processKillGraceMs = Number(
  process.env.ROUTE_TEST_PROCESS_KILL_GRACE_MS ?? "10000",
);

const testFiles =
  explicitTestFiles.length > 0
    ? explicitTestFiles
    : [
        ...findTestFiles("tests/routes"),
        "tests/community-membership-reconciliation.test.ts",
      ]
        .map((path) => relative(process.cwd(), path))
        .sort();

async function runTestFile(testFile: string): Promise<number> {
  return new Promise((resolve) => {
    const child = spawn("bun", [
      "test",
      "--max-concurrency=1",
      "--timeout",
      String(bunTestTimeoutMs),
      testFile,
    ], {
      stdio: "inherit",
    });

    let timedOut = false;
    let killTimer: NodeJS.Timeout | undefined;
    const timeoutTimer = setTimeout(() => {
      timedOut = true;
      console.error(
        `[route-tests] ${testFile} exceeded process timeout ${processTimeoutMs}ms`,
      );
      child.kill("SIGTERM");
      killTimer = setTimeout(() => {
        child.kill("SIGKILL");
      }, processKillGraceMs);
    }, processTimeoutMs);

    child.once("error", (error) => {
      clearTimeout(timeoutTimer);
      if (killTimer) {
        clearTimeout(killTimer);
      }

      console.error(
        `[route-tests] ${testFile} failed to run: ${error.message}`,
      );
      resolve(1);
    });

    child.once("exit", (code, signal) => {
      clearTimeout(timeoutTimer);
      if (killTimer) {
        clearTimeout(killTimer);
      }

      if (timedOut) {
        resolve(124);
        return;
      }

      if (signal) {
        console.error(
          `[route-tests] ${testFile} exited after signal ${signal}`,
        );
        resolve(1);
        return;
      }

      resolve(code ?? 1);
    });
  });
}

for (const [index, testFile] of testFiles.entries()) {
  console.log(
    `[route-tests] ${index + 1}/${testFiles.length} ${testFile}`,
  );

  if (dryRun) {
    continue;
  }

  const status = await runTestFile(testFile);

  if (status !== 0) {
    process.exit(status);
  }
}
