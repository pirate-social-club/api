import fs from "node:fs";
import path from "node:path";
import { fileURLToPath } from "node:url";

const __filename = fileURLToPath(import.meta.url);
const repoRoot = path.resolve(path.dirname(__filename), "..");

const scannedExtensions = new Set([".json", ".md", ".ts", ".tsx", ".yml", ".yaml"]);
const ignoredDirs = new Set([".git", "node_modules", ".wrangler", "dist", "coverage"]);
const staleMarkers = [
  "pirate-v2",
  "/home/t42/Documents/pirate-v2",
  "pirate-api/services",
  "pirate-web/",
  "pirate-contracts/",
  "docs/ci",
  "docs/plans",
  "LEGACY-DO-NOT-USE",
  "Status: draft",
  "to be written",
  "hns-public-profile-routing",
  "coming soon",
  "terminal client",
];
const staleRegexMarkers = [
  { label: "TUI", pattern: /\bTUI\b/u },
  { label: "tui", pattern: /\btui\b/u },
];

function relative(filePath) {
  return path.relative(repoRoot, filePath);
}

function walk(dir) {
  const entries = fs.readdirSync(dir, { withFileTypes: true });
  const files = [];
  for (const entry of entries) {
    const fullPath = path.join(dir, entry.name);
    if (entry.isDirectory()) {
      if (!ignoredDirs.has(entry.name)) files.push(...walk(fullPath));
      continue;
    }
    if (scannedExtensions.has(path.extname(entry.name))) files.push(fullPath);
  }
  return files;
}

function checkStaleMarkers() {
  const failures = [];
  const self = path.normalize(__filename);
  for (const file of walk(repoRoot)) {
    if (path.normalize(file) === self) continue;
    const lines = fs.readFileSync(file, "utf8").split("\n");
    lines.forEach((line, index) => {
      for (const marker of staleMarkers) {
        if (line.includes(marker)) failures.push(`${relative(file)}:${index + 1}: ${marker}`);
      }
      for (const marker of staleRegexMarkers) {
        if (marker.pattern.test(line)) failures.push(`${relative(file)}:${index + 1}: ${marker.label}`);
      }
    });
  }
  return { label: "stale-markers", failures };
}

function checkRouteCoverageMap() {
  const failures = [];
  const indexPath = path.join(repoRoot, "services/api/src/index.ts");
  const coveragePath = path.join(repoRoot, "ROUTE_COVERAGE.md");
  const indexSource = fs.readFileSync(indexPath, "utf8");
  const coverageSource = fs.readFileSync(coveragePath, "utf8");
  const imports = new Map();

  for (const match of indexSource.matchAll(/^import (\w+) from "\.\/(routes\/[^"]+)"/gmu)) {
    imports.set(match[1], `src/${match[2]}.ts`);
  }

  for (const match of indexSource.matchAll(/app\.route\("([^"]+)",\s*(\w+)\)/gmu)) {
    const [, mountPath, identifier] = match;
    const routeFile = imports.get(identifier);
    if (!routeFile) {
      failures.push(`services/api/src/index.ts: missing import map for ${identifier}`);
      continue;
    }
    if (!fs.existsSync(path.join(repoRoot, "services/api", routeFile))) {
      failures.push(`${routeFile}: route file does not exist`);
    }
    if (!coverageSource.includes(routeFile)) {
      failures.push(`ROUTE_COVERAGE.md: missing ${routeFile}`);
    }
    if (mountPath !== "/" && !coverageSource.includes(`\`${mountPath}`)) {
      failures.push(`ROUTE_COVERAGE.md: missing mount ${mountPath}`);
    }
  }

  if (!coverageSource.includes("/health") || !coverageSource.includes("tests/routes/health-routes.test.ts")) {
    failures.push("ROUTE_COVERAGE.md: missing /health coverage entry");
  }

  return { label: "route-coverage-map", failures };
}

// Regression guard for the production runtime images: every bun install in a
// RUN instruction must consume the committed lockfile, and the lockfile must
// never be deleted. Scope is deliberately narrow: complete RUN instructions
// are reconstructed (continuation lines joined, comments ignored) and shell
// segments split on &&/||/;/|, so `bun install`, `bun i` and option prefixes
// like `bun --cwd <dir> install` are all recognized. Environment-prefixed
// invocations such as `CI=true bun install` are out of scope.
export function checkRuntimeImageDockerfileContent(file, source) {
  const failures = [];
  const instructions = [];
  let continuation = "";

  source.split("\n").forEach((rawLine, index) => {
    if (!continuation && rawLine.trimStart().startsWith("#")) return;
    if (rawLine.endsWith("\\")) {
      continuation += `${rawLine.slice(0, -1)} `;
      return;
    }
    const line = continuation + rawLine;
    continuation = "";
    instructions.push({ line, lineNumber: index + 1 });
  });
  if (continuation) instructions.push({ line: continuation, lineNumber: source.split("\n").length });

  for (const { line, lineNumber } of instructions) {
    if (!/^\s*RUN\s/u.test(line)) continue;
    const segments = line.replace(/^\s*RUN\s+/u, "").split(/&&|\|\||[;|]/u);
    for (const segment of segments) {
      const tokens = segment.trim().split(/\s+/u).filter(Boolean);
      if (tokens.includes("rm") && tokens.some((token) => token.includes("bun.lock"))) {
        failures.push(`${file}:${lineNumber}: deletes bun.lock`);
      }
      if (tokens[0] === "bun" && (tokens.includes("install") || tokens.includes("i"))) {
        if (!tokens.includes("--frozen-lockfile")) {
          failures.push(`${file}:${lineNumber}: bun install without --frozen-lockfile`);
        }
      }
    }
  }

  return failures;
}

export function checkRuntimeImageShutdownEntrypoint(file, source) {
  const tiniEntrypoint = /^\s*ENTRYPOINT\s+\["\/usr\/bin\/tini",\s*"--"\]\s*$/mu;
  return tiniEntrypoint.test(source)
    ? []
    : [`${file}: missing tini shutdown ENTRYPOINT`];
}

export function checkScannerImageSupplyChain(file, source) {
  const failures = [];
  const fromLines = source.split("\n").filter((line) => /^\s*FROM\s+/u.test(line));
  if (fromLines.length < 2 || fromLines.some((line) => !line.includes("@sha256:"))) {
    failures.push(`${file}: every base image must use an immutable sha256 digest`);
  }
  if (!/^\s*ARG CLAMAV_DEFINITION_DIGEST=[a-f0-9]{64}\s*$/mu.test(source)) {
    failures.push(`${file}: missing pinned ClamAV definition digest`);
  }
  if (!/^\s*USER clamav\s*$/mu.test(source)) {
    failures.push(`${file}: scanner must run as the clamav user`);
  }
  if (/\bfreshclam\b/u.test(source.replace(/^\s*#.*$/gmu, ""))) {
    failures.push(`${file}: runtime definition updates are forbidden`);
  }
  return failures;
}

export function checkScannerContainerIsolation(file, source) {
  const failures = [];
  if (!/^\s*enableInternet\s*=\s*false\s*$/mu.test(source)) {
    failures.push(`${file}: scanner container internet access must be disabled`);
  }
  if (!/^\s*sleepAfter\s*=\s*"30s"\s*$/mu.test(source)) {
    failures.push(`${file}: scanner container must retain the 30-second idle timeout`);
  }
  return failures;
}

function checkRuntimeImageDockerfiles() {
  const dockerfiles = [
    "services/api/Dockerfile.content-malware-scanner",
    "services/api/Dockerfile.song-preview",
    "services/api/Dockerfile.zkpassport-verifier",
  ];
  const failures = dockerfiles.flatMap((file) => {
    const source = fs.readFileSync(path.join(repoRoot, file), "utf8");
    return [
      ...checkRuntimeImageDockerfileContent(file, source),
      ...checkRuntimeImageShutdownEntrypoint(file, source),
      ...(file.endsWith("Dockerfile.content-malware-scanner")
        ? checkScannerImageSupplyChain(file, source)
        : []),
    ];
  });
  const scannerWorker = "services/content-malware-scanner-container/src/index.ts";
  failures.push(...checkScannerContainerIsolation(
    scannerWorker,
    fs.readFileSync(path.join(repoRoot, scannerWorker), "utf8"),
  ));

  return { label: "runtime-image-dockerfiles", failures };
}

const isMain = process.argv[1] != null && path.resolve(process.argv[1]) === __filename;

if (isMain) {
  const checks = [checkStaleMarkers(), checkRouteCoverageMap(), checkRuntimeImageDockerfiles()];
  const failures = checks.filter((check) => check.failures.length > 0);

  if (failures.length === 0) {
    console.log("repo hygiene passed");
    for (const check of checks) console.log(`- ${check.label}`);
    process.exit(0);
  }

  console.error("repo hygiene failed");
  for (const check of failures) {
    console.error(`- ${check.label}`);
    for (const failure of check.failures) console.error(`  ${failure}`);
  }
  process.exit(1);
}
