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

const checks = [checkStaleMarkers(), checkRouteCoverageMap()];
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
