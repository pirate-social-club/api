import { appendFile } from "node:fs/promises";
import * as BunRuntime from "bun";

const DEFAULT_BATCH_SIZE = 100;
const NPM_BULK_ADVISORY_URL = "https://registry.npmjs.org/-/npm/v1/security/advisories/bulk";
const SEVERITY_RANK = { critical: 4, high: 3, moderate: 2, low: 1, info: 0 } as const;

type AuditMode = "release" | "scheduled";

type BaselineException = {
  advisory: string;
  expires: string;
  reason: string;
};

type AuditBaseline = {
  exceptions?: BaselineException[];
};

type AuditFinding = {
  ghsa: string;
  package: string;
  severity: string;
  title: string;
  url: string;
};

type ParsedArgs = {
  baseline: string;
  batchSize: number;
  lockfile: string;
  mode: AuditMode;
};

type Lockfile = {
  packages?: Record<string, unknown>;
};

type NpmBulkAdvisory = {
  severity?: unknown;
  title?: unknown;
  url?: unknown;
};

function parseArgs(argv: string[]): ParsedArgs {
  const args: Partial<ParsedArgs> = {
    batchSize: DEFAULT_BATCH_SIZE,
    mode: "scheduled",
  };

  for (let index = 0; index < argv.length; index += 1) {
    const argument = argv[index];
    if (argument === "--baseline") args.baseline = argv[++index];
    else if (argument === "--batch-size") args.batchSize = Number(argv[++index]);
    else if (argument === "--lockfile") args.lockfile = argv[++index];
    else if (argument === "--mode") args.mode = argv[++index] as AuditMode;
    else throw new Error(`unknown argument: ${argument}`);
  }

  if (!args.baseline) throw new Error("--baseline is required");
  if (!args.lockfile) throw new Error("--lockfile is required");
  if (args.mode !== "release" && args.mode !== "scheduled") {
    throw new Error(`--mode must be release or scheduled, got ${args.mode}`);
  }
  if (!Number.isSafeInteger(args.batchSize) || (args.batchSize ?? 0) < 1 || (args.batchSize ?? 0) > 250) {
    throw new Error("--batch-size must be an integer between 1 and 250");
  }

  return args as ParsedArgs;
}

function requireJsoncParser(): (input: string) => unknown {
  const parser = BunRuntime.JSONC?.parse;
  if (typeof parser !== "function") {
    throw new Error(
      `Bun ${BunRuntime.version} does not expose Bun.JSONC.parse; the dependency audit cannot safely parse bun.lock`,
    );
  }
  return parser;
}

function parsePublishedPackageSpecifier(specifier: string): { name: string; version: string } | null {
  if (
    specifier.includes("@file:")
    || specifier.includes("@git+")
    || specifier.includes("@github:")
    || specifier.includes("@workspace:")
  ) {
    return null;
  }

  const separator = specifier.lastIndexOf("@");
  if (separator <= 0 || separator === specifier.length - 1) {
    throw new Error(`unsupported registry package specifier in bun.lock: ${specifier}`);
  }

  const name = specifier.slice(0, separator);
  const version = specifier.slice(separator + 1);
  if (
    !name
    || !version
    || version.includes(":")
    || version.includes("/")
    || /\s/u.test(name)
    || /\s/u.test(version)
  ) {
    throw new Error(`unsupported registry package specifier in bun.lock: ${specifier}`);
  }

  return { name, version };
}

export function extractRegistryPackages(lockfile: Lockfile): Map<string, string[]> {
  if (!lockfile.packages || typeof lockfile.packages !== "object" || Array.isArray(lockfile.packages)) {
    throw new Error("bun.lock must contain a packages object");
  }

  const versionsByPackage = new Map<string, Set<string>>();
  for (const [lockKey, rawEntry] of Object.entries(lockfile.packages)) {
    if (!Array.isArray(rawEntry) || typeof rawEntry[0] !== "string") {
      throw new Error(`bun.lock package ${lockKey} must be a tuple whose first value is a package specifier`);
    }

    const published = parsePublishedPackageSpecifier(rawEntry[0]);
    if (!published) continue;

    // Registry entries carry an integrity hash. Requiring it prevents an
    // unrecognized non-registry source from being audited as a fictional npm
    // package merely because its specifier happens to contain an `@`.
    const integrity = rawEntry[3];
    if (typeof integrity !== "string" || !/^sha(?:1|256|384|512)-/u.test(integrity)) {
      throw new Error(`registry package ${lockKey} (${rawEntry[0]}) has no recognized integrity hash`);
    }

    const versions = versionsByPackage.get(published.name) ?? new Set<string>();
    versions.add(published.version);
    versionsByPackage.set(published.name, versions);
  }

  return new Map(
    [...versionsByPackage.entries()]
      .sort(([left], [right]) => left.localeCompare(right))
      .map(([name, versions]) => [name, [...versions].sort((left, right) => left.localeCompare(right))]),
  );
}

function ghsaFromUrl(url: string): string {
  const ghsa = url.split("/").pop() ?? "";
  if (!/^GHSA-[23456789cfghjmpqrvwx]{4}-[23456789cfghjmpqrvwx]{4}-[23456789cfghjmpqrvwx]{4}$/iu.test(ghsa)) {
    throw new Error(`advisory URL does not end in a GHSA identifier: ${url}`);
  }
  return ghsa.toUpperCase();
}

function normalizeAdvisory(packageName: string, advisory: NpmBulkAdvisory): AuditFinding {
  if (!advisory || typeof advisory !== "object" || Array.isArray(advisory)) {
    throw new Error(`npm advisory for ${packageName} must be an object`);
  }
  if (typeof advisory.url !== "string") {
    throw new Error(`npm advisory for ${packageName} has no URL`);
  }
  if (typeof advisory.severity !== "string" || !(advisory.severity.toLowerCase() in SEVERITY_RANK)) {
    throw new Error(`npm advisory for ${packageName} has an unsupported severity`);
  }
  if (typeof advisory.title !== "string") {
    throw new Error(`npm advisory for ${packageName} has no title`);
  }

  return {
    ghsa: ghsaFromUrl(advisory.url),
    package: packageName,
    severity: advisory.severity.toLowerCase(),
    title: advisory.title,
    url: advisory.url,
  };
}

export async function queryBulkAdvisories(
  packages: Map<string, string[]>,
  options: {
    batchSize?: number;
    fetchImpl?: typeof fetch;
  } = {},
): Promise<AuditFinding[]> {
  const batchSize = options.batchSize ?? DEFAULT_BATCH_SIZE;
  const fetchImpl = options.fetchImpl ?? fetch;
  const entries = [...packages.entries()];
  const findings: AuditFinding[] = [];

  for (let offset = 0; offset < entries.length; offset += batchSize) {
    const batch = entries.slice(offset, offset + batchSize);
    const requestedNames = new Set(batch.map(([name]) => name));
    const response = await fetchImpl(NPM_BULK_ADVISORY_URL, {
      body: JSON.stringify(Object.fromEntries(batch)),
      headers: {
        accept: "application/json",
        "content-type": "application/json",
      },
      method: "POST",
    });

    if (!response.ok) {
      const body = await response.text();
      throw new Error(
        `npm bulk advisory batch ${offset / batchSize + 1} returned HTTP ${response.status}: ${body.slice(0, 300)}`,
      );
    }

    let payload: unknown;
    try {
      payload = await response.json();
    } catch (error) {
      throw new Error(`npm bulk advisory batch ${offset / batchSize + 1} returned invalid JSON: ${String(error)}`);
    }
    if (!payload || typeof payload !== "object" || Array.isArray(payload)) {
      throw new Error(`npm bulk advisory batch ${offset / batchSize + 1} returned a non-object payload`);
    }

    for (const [packageName, rawAdvisories] of Object.entries(payload)) {
      if (!requestedNames.has(packageName)) {
        throw new Error(`npm bulk advisory response included unrequested package ${packageName}`);
      }
      if (!Array.isArray(rawAdvisories)) {
        throw new Error(`npm bulk advisory response for ${packageName} must be an array`);
      }
      for (const advisory of rawAdvisories) {
        findings.push(normalizeAdvisory(packageName, advisory as NpmBulkAdvisory));
      }
    }
  }

  const deduped = new Map<string, AuditFinding>();
  for (const finding of findings) {
    deduped.set(`${finding.package}|${finding.ghsa}`, finding);
  }
  return [...deduped.values()].sort((left, right) =>
    `${left.package}|${left.ghsa}`.localeCompare(`${right.package}|${right.ghsa}`),
  );
}

function loadExceptions(baseline: AuditBaseline, now: Date): Map<string, BaselineException & { expired: boolean }> {
  const exceptions = new Map<string, BaselineException & { expired: boolean }>();
  for (const entry of baseline.exceptions ?? []) {
    if (!entry.advisory || !entry.reason || !entry.expires) {
      throw new Error("every baseline exception needs advisory, reason, and expires");
    }
    const expiresAt = new Date(entry.expires);
    if (Number.isNaN(expiresAt.getTime())) {
      throw new Error(`baseline exception ${entry.advisory} has an invalid expiry: ${entry.expires}`);
    }
    exceptions.set(entry.advisory.toUpperCase(), {
      ...entry,
      expired: expiresAt.getTime() < now.getTime(),
    });
  }
  return exceptions;
}

export function evaluateFindings(
  findings: AuditFinding[],
  baseline: AuditBaseline,
  mode: AuditMode,
  now = new Date(),
): {
  accepted: Array<AuditFinding & { exception: BaselineException & { expired: boolean } }>;
  blocking: AuditFinding[];
  expired: Array<BaselineException & { expired: boolean }>;
} {
  const exceptions = loadExceptions(baseline, now);
  const threshold = mode === "release" ? SEVERITY_RANK.critical : SEVERITY_RANK.high;
  const accepted = [];
  const blocking = [];

  for (const finding of findings) {
    if ((SEVERITY_RANK[finding.severity as keyof typeof SEVERITY_RANK] ?? 0) < threshold) continue;
    const exception = exceptions.get(finding.ghsa);
    if (exception && (mode === "release" || !exception.expired)) accepted.push({ ...finding, exception });
    else blocking.push(finding);
  }

  const expired = mode === "scheduled"
    ? [...exceptions.values()].filter((entry) => entry.expired)
    : [];
  return { accepted, blocking, expired };
}

async function main(): Promise<void> {
  const args = parseArgs(process.argv.slice(2));
  const parseJsonc = requireJsoncParser();
  const lockfile = parseJsonc(await BunRuntime.file(args.lockfile).text()) as Lockfile;
  const baseline = JSON.parse(await BunRuntime.file(args.baseline).text()) as AuditBaseline;
  const packages = extractRegistryPackages(lockfile);
  if (packages.size === 0) throw new Error("bun.lock contained no registry packages to audit");

  const findings = await queryBulkAdvisories(packages, { batchSize: args.batchSize });
  const result = evaluateFindings(findings, baseline, args.mode);
  const lines = [
    `mode=${args.mode} threshold=${args.mode === "release" ? "critical" : "high"}`,
    `scanned ${packages.size} registry package name(s); ${findings.length} advisory instance(s) total`,
  ];
  for (const finding of result.blocking) {
    lines.push(`BLOCKING  [${finding.severity}] ${finding.package} ${finding.ghsa} — ${finding.title}`);
  }
  for (const finding of result.accepted) {
    lines.push(
      `accepted  [${finding.severity}] ${finding.package} ${finding.ghsa} — ${finding.exception.reason} (expires ${finding.exception.expires}${finding.exception.expired ? " EXPIRED" : ""})`,
    );
  }
  for (const entry of result.expired) {
    lines.push(`EXPIRED   ${entry.advisory} — exception lapsed ${entry.expires}: ${entry.reason}`);
  }
  if (result.blocking.length === 0 && result.expired.length === 0) lines.push("no action required");

  const report = lines.join("\n");
  console.log(report);
  if (process.env.GITHUB_STEP_SUMMARY) {
    await appendFile(
      process.env.GITHUB_STEP_SUMMARY,
      `## API dependency audit (${args.mode})\n\n\`\`\`\n${report}\n\`\`\`\n`,
    );
  }
  if (result.blocking.length > 0 || result.expired.length > 0) process.exit(1);
}

if (import.meta.main) {
  await main();
}
