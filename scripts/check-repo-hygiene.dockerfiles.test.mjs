import { describe, expect, test } from "bun:test";
import fs from "node:fs";
import path from "node:path";
import { fileURLToPath } from "node:url";

import {
  checkRuntimeImageDockerfileContent,
  checkRuntimeImageShutdownEntrypoint,
} from "./check-repo-hygiene.mjs";

const FILE = "Dockerfile.fixture";
const repoRoot = path.resolve(path.dirname(fileURLToPath(import.meta.url)), "..");

function failuresFor(source) {
  return checkRuntimeImageDockerfileContent(FILE, source);
}

describe("runtime image Dockerfile guard: accepted forms", () => {
  test.each([
    ["plain frozen install", "RUN bun install --frozen-lockfile --production"],
    ["chained frozen install", "RUN cd /app/services/shared && bun install --frozen-lockfile --production"],
    ["option-prefixed frozen install", "RUN bun --cwd /app/services/shared install --frozen-lockfile --production"],
    ["frozen flag on a continuation line", "RUN bun install \\\n  --frozen-lockfile --production"],
    ["comment mentioning lockfile deletion", "# RUN rm bun.lock"],
    ["comment mentioning bun install", "# bun install"],
    ["non-install bun commands", "RUN bun run scripts/serve.ts\nRUN bunx wrangler deploy"],
    ["rm of an unrelated file", "RUN rm -rf /var/lib/apt/lists/*"],
  ])("%s produces no failures", (_label, source) => {
    expect(failuresFor(source)).toEqual([]);
  });
});

describe("runtime image Dockerfile guard: rejected forms", () => {
  test.each([
    ["rm bun.lock", "RUN rm bun.lock", "deletes bun.lock"],
    ["rm -f bun.lock", "RUN rm -f bun.lock", "deletes bun.lock"],
    ["unfrozen install", "RUN bun install --production", "without --frozen-lockfile"],
    ["bun i shorthand", "RUN bun i --production", "without --frozen-lockfile"],
    ["option-prefixed unfrozen install", "RUN bun --cwd /x install", "without --frozen-lockfile"],
    ["chained unfrozen install", "RUN cd /x && bun install", "without --frozen-lockfile"],
    ["unfrozen install across continuation", "RUN bun install \\\n  --production", "without --frozen-lockfile"],
    ["frozen install followed by lock deletion", "RUN bun install --frozen-lockfile && rm bun.lock", "deletes bun.lock"],
  ])("%s is flagged", (_label, source, reason) => {
    const failures = failuresFor(source);
    expect(failures).toHaveLength(1);
    expect(failures[0]).toStartWith(`${FILE}:`);
    expect(failures[0]).toContain(reason);
  });

  test("the original regression shape is flagged on both counts", () => {
    const failures = failuresFor("RUN rm bun.lock\nRUN bun install --production");
    expect(failures).toHaveLength(2);
  });

  test("current production Dockerfiles pass", () => {
    for (const file of ["services/api/Dockerfile.song-preview", "services/api/Dockerfile.zkpassport-verifier"]) {
      const source = fs.readFileSync(path.join(repoRoot, file), "utf8");
      expect(checkRuntimeImageDockerfileContent(file, source)).toEqual([]);
    }
  });
});

describe("runtime image Dockerfile guard: graceful shutdown", () => {
  test("accepts tini as the image entrypoint", () => {
    expect(checkRuntimeImageShutdownEntrypoint(
      FILE,
      'ENTRYPOINT ["/usr/bin/tini", "--"]\nCMD ["bun", "run", "service.ts"]',
    )).toEqual([]);
  });

  test("rejects a runtime process as PID 1", () => {
    expect(checkRuntimeImageShutdownEntrypoint(
      FILE,
      'CMD ["bun", "run", "service.ts"]',
    )).toEqual([`${FILE}: missing tini shutdown ENTRYPOINT`]);
  });

  test("current production Dockerfiles use tini", () => {
    for (const file of ["services/api/Dockerfile.song-preview", "services/api/Dockerfile.zkpassport-verifier"]) {
      const source = fs.readFileSync(path.join(repoRoot, file), "utf8");
      expect(checkRuntimeImageShutdownEntrypoint(file, source)).toEqual([]);
    }
  });
});
