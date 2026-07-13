import { execFileSync } from "node:child_process"
import { existsSync, mkdirSync, readdirSync, readFileSync, writeFileSync } from "node:fs"
import { dirname, resolve } from "node:path"
import { fileURLToPath } from "node:url"
import YAML from "yaml"

const scriptDir = dirname(fileURLToPath(import.meta.url))
const repoRoot = resolve(scriptDir, "..", "..", "..", "..")
const coreRepoRoot = resolveCoreRepoRoot()
const fullYamlPath = resolve(coreRepoRoot, "specs", "api", "openapi.yaml")
const implementedYamlPath = resolve(coreRepoRoot, "specs", "api", "openapi-implemented.yaml")
const sourceComponentsDir = resolve(coreRepoRoot, "specs", "api", "src", "components")
const outDir = resolve(scriptDir, "..", "src", "generated")
const outPath = resolve(outDir, "openapi-spec.ts")

type OpenApiRecord = Record<string, any>

function gitOutput(repo: string, args: string[]): string {
  try {
    return execFileSync("git", ["-C", repo, ...args], { encoding: "utf8", stdio: ["ignore", "pipe", "pipe"] }).trim()
  } catch {
    throw new Error(`Could not verify auto-resolved core repo at ${repo}. Set PIRATE_CORE_REPO explicitly.`)
  }
}

function assertSafeAutoResolvedCore(repo: string): void {
  if (gitOutput(repo, ["status", "--porcelain"])) {
    throw new Error(`Refusing to generate from dirty auto-resolved core repo at ${repo}. Set PIRATE_CORE_REPO explicitly to acknowledge the source.`)
  }
  gitOutput(repo, ["rev-parse", "--verify", "origin/main"])
  const behind = Number(gitOutput(repo, ["rev-list", "--count", "HEAD..origin/main"]))
  if (!Number.isSafeInteger(behind) || behind > 0) {
    throw new Error(`Refusing to generate from stale auto-resolved core repo at ${repo} (${behind} commit(s) behind origin/main). Set PIRATE_CORE_REPO explicitly.`)
  }
}

function resolveCoreRepoRoot(): string {
  const explicit = process.env.PIRATE_CORE_REPO?.trim()
  if (explicit) {
    if (existsSync(resolve(explicit, "specs/api/openapi.yaml"))) return explicit
    throw new Error(`PIRATE_CORE_REPO does not contain specs/api/openapi.yaml: ${explicit}`)
  }

  const candidates = [resolve(repoRoot, "core"), resolve(repoRoot, "../core")]
  for (const candidate of new Set(candidates)) {
    if (!existsSync(resolve(candidate, "specs/api/openapi.yaml"))) continue
    assertSafeAutoResolvedCore(candidate)
    return candidate
  }

  throw new Error("Could not locate Pirate core repo. Set PIRATE_CORE_REPO.")
}

function readYaml(path: string): OpenApiRecord {
  return YAML.parse(readFileSync(path, "utf-8")) ?? {}
}

function mergeComponentSource(componentName: string): OpenApiRecord {
  const componentPath = resolve(sourceComponentsDir, `${componentName}.yaml`)
  return readYaml(componentPath)
}

function mergeSchemaSources(): OpenApiRecord {
  const schemasDir = resolve(sourceComponentsDir, "schemas")
  return Object.fromEntries(
    readdirSync(schemasDir)
      .filter((fileName) => fileName.endsWith(".yaml"))
      .flatMap((fileName) => Object.entries(readYaml(resolve(schemasDir, fileName)))),
  )
}

function operationId(method: string, path: string): string {
  const pathId = path
    .replace(/^\//, "")
    .replace(/\{([^}]+)\}/g, "by_$1")
    .replace(/[^a-zA-Z0-9]+/g, "_")
    .replace(/^_+|_+$/g, "")
  return `${method}_${pathId || "root"}`
}

function addReviewMetadata(spec: OpenApiRecord): void {
  const methods = new Set(["get", "put", "post", "delete", "options", "head", "patch", "trace"])
  for (const [path, pathItem] of Object.entries(spec.paths ?? {})) {
    if (!pathItem || typeof pathItem !== "object") {
      continue
    }
    const pathParams = Array.from(path.matchAll(/\{([^}]+)\}/g), (match) => match[1])
    for (const [method, operation] of Object.entries(pathItem as OpenApiRecord)) {
      if (!methods.has(method) || !operation || typeof operation !== "object") {
        continue
      }
      const op = operation as OpenApiRecord
      op.operationId ??= operationId(method, path)
      if (pathParams.length === 0) {
        continue
      }
      const parameters = Array.isArray(op.parameters) ? op.parameters : []
      for (const pathParam of pathParams) {
        if (parameters.some((parameter) => parameterName(spec, parameter) === pathParam)) {
          continue
        }
        parameters.unshift({
          name: pathParam,
          in: "path",
          required: true,
          schema: { type: "string" },
        })
      }
      op.parameters = parameters
    }
  }
}

function parameterName(spec: OpenApiRecord, parameter: OpenApiRecord): string | null {
  if (parameter.in === "path" && typeof parameter.name === "string") {
    return parameter.name
  }
  if (typeof parameter.$ref !== "string") {
    return null
  }
  const resolved = resolveRef(spec, parameter.$ref)
  if (!resolved || typeof resolved !== "object") {
    return null
  }
  const resolvedParameter = resolved as OpenApiRecord
  return resolvedParameter.in === "path" && typeof resolvedParameter.name === "string"
    ? resolvedParameter.name
    : null
}

function implementedPath(pathItem: OpenApiRecord): OpenApiRecord {
  const copy = JSON.parse(JSON.stringify(pathItem))
  for (const operation of Object.values(copy)) {
    if (operation && typeof operation === "object" && "x-implemented" in operation) {
      operation["x-implemented"] = true
    }
  }
  return copy
}

function runtimeOnlyPaths(fullSpec: OpenApiRecord): OpenApiRecord {
  return {
    "/public-communities": {
      get: {
        tags: ["Communities"],
        "x-implemented": true,
        security: [],
        summary: "Search public communities",
        parameters: [
          { name: "query", in: "query", required: true, schema: { type: "string", minLength: 2 } },
          { name: "limit", in: "query", required: false, schema: { type: "integer", minimum: 1, maximum: 25, default: 10 } },
        ],
        responses: {
          "200": {
            description: "Public community search results",
            content: {
              "application/json": {
                schema: {
                  type: "object",
                  required: ["query", "communities", "has_more"],
                  properties: {
                    query: { type: "string", nullable: true },
                    communities: {
                      type: "array",
                      items: {
                        type: "object",
                        required: ["community", "display_name"],
                        properties: {
                          community: { type: "string" },
                          display_name: { type: "string" },
                          route_slug: { type: "string", nullable: true },
                        },
                      },
                    },
                    has_more: { type: "boolean" },
                  },
                },
              },
            },
          },
          "400": { $ref: "#/components/responses/BadRequest" },
          "429": { $ref: "#/components/responses/RateLimited" },
        },
      },
    },
    "/public-communities/{community_id}": implementedPath(fullSpec.paths["/public-communities/{community_id}"]),
    "/public-communities/{community_id}/capabilities": {
      get: {
        tags: ["Communities"],
        "x-implemented": true,
        security: [],
        summary: "Get public community action capabilities",
        description: "Returns a machine-readable action matrix describing public read access, guest comment eligibility, delegated-agent write eligibility, user-token-only actions, and proof-of-work requirements.",
        parameters: [
          { name: "community_id", in: "path", required: true, schema: { type: "string" } },
        ],
        responses: {
          "200": {
            description: "Community action capabilities",
            content: {
              "application/json": {
                schema: {
                  type: "object",
                  required: ["community", "display_name", "read", "write", "raw_policy"],
                  additionalProperties: true,
                },
              },
            },
          },
          "404": { $ref: "#/components/responses/NotFound" },
          "429": { $ref: "#/components/responses/RateLimited" },
        },
      },
    },
    "/public-communities/{community_id}/posts": implementedPath(fullSpec.paths["/public-communities/{community_id}/posts"]),
    "/public-posts/{post_id}": implementedPath(fullSpec.paths["/public-posts/{post_id}"]),
    "/public-posts/{post_id}/top-comments": implementedPath(fullSpec.paths["/public-posts/{post_id}/top-comments"]),
    "/public-comments/{comment_id}/replies": {
      get: {
        tags: ["Comments"],
        "x-implemented": true,
        security: [],
        summary: "List public replies for a comment",
        parameters: [
          { name: "comment_id", in: "path", required: true, schema: { type: "string" } },
          { $ref: "#/components/parameters/Cursor" },
          { $ref: "#/components/parameters/Limit" },
        ],
        responses: {
          "200": {
            description: "Public comment replies",
            content: {
              "application/json": {
                schema: { $ref: "#/components/schemas/CommentListResponse" },
              },
            },
          },
          "404": { $ref: "#/components/responses/NotFound" },
          "429": { $ref: "#/components/responses/RateLimited" },
        },
      },
    },
  }
}

function resolveRef(spec: OpenApiRecord, ref: string): unknown {
  if (!ref.startsWith("#/")) {
    return undefined
  }
  return ref
    .slice(2)
    .split("/")
    .map((part) => part.replace(/~1/g, "/").replace(/~0/g, "~"))
    .reduce<unknown>((current, part) => {
      if (!current || typeof current !== "object") {
        return undefined
      }
      return (current as OpenApiRecord)[part]
    }, spec)
}

function setRef(spec: OpenApiRecord, ref: string, value: unknown): void {
  const parts = ref
    .slice(2)
    .split("/")
    .map((part) => part.replace(/~1/g, "/").replace(/~0/g, "~"))
  let current = spec
  for (const part of parts.slice(0, -1)) {
    current[part] ??= {}
    current = current[part]
  }
  current[parts[parts.length - 1]] = value
}

function collectRefs(value: unknown, refs: Set<string>): void {
  if (!value || typeof value !== "object") {
    return
  }
  if (typeof (value as OpenApiRecord).$ref === "string") {
    refs.add((value as OpenApiRecord).$ref)
  }
  for (const child of Object.values(value)) {
    collectRefs(child, refs)
  }
}

function normalizeLocalSchemaRefs(value: unknown): void {
  if (!value || typeof value !== "object") {
    return
  }
  const record = value as OpenApiRecord
  if (typeof record.$ref === "string") {
    const match = record.$ref.match(/^(?:\.\/[^#]+|(?:\.\.\/)*components\/schemas\/[^#]+)#\/([^/]+)$/u)
    if (match) {
      record.$ref = `#/components/schemas/${match[1].replace(/~/gu, "~0").replace(/\//gu, "~1")}`
    }
  }
  for (const child of Object.values(record)) {
    normalizeLocalSchemaRefs(child)
  }
}

function stripReviewNoise(value: unknown): void {
  if (!value || typeof value !== "object") {
    return
  }
  const record = value as OpenApiRecord
  delete record.description
  delete record.example
  delete record.examples
  delete record.externalDocs
  delete record["x-codeSamples"]
  for (const child of Object.values(record)) {
    stripReviewNoise(child)
  }
}

function operationOnlyPathItem(pathItem: OpenApiRecord): OpenApiRecord {
  const methods = new Set(["get", "put", "post", "delete", "options", "head", "patch", "trace", "parameters"])
  return Object.fromEntries(
    Object.entries(pathItem).filter(([key]) => methods.has(key)),
  )
}

function reviewServiceSpec(spec: OpenApiRecord): OpenApiRecord {
  const paths = Object.fromEntries(
    Object.entries(spec.paths ?? {}).map(([path, pathItem]) => [
      path,
      operationOnlyPathItem(JSON.parse(JSON.stringify(pathItem))),
    ]),
  )
  stripReviewNoise(paths)
  const reviewSpec: OpenApiRecord = {
    openapi: spec.openapi,
    info: {
      title: "Pirate API",
      version: spec.info?.version ?? "0.1.0",
    },
    servers: spec.servers,
    tags: spec.tags,
    paths,
    components: {
      securitySchemes: spec.components?.securitySchemes,
      parameters: {},
      responses: {},
      schemas: {},
    },
  }

  const pendingRefs = new Set<string>()
  const copiedRefs = new Set<string>()
  collectRefs(paths, pendingRefs)
  for (const ref of pendingRefs) {
    if (copiedRefs.has(ref)) {
      continue
    }
    copiedRefs.add(ref)
    const value = resolveRef(spec, ref)
    if (value === undefined) {
      continue
    }
    const copy = JSON.parse(JSON.stringify(value))
    stripReviewNoise(copy)
    setRef(reviewSpec, ref, copy)
    collectRefs(copy, pendingRefs)
  }
  return reviewSpec
}

const fullYamlText = readFileSync(fullYamlPath, "utf-8")
const implementedYamlText = readFileSync(implementedYamlPath, "utf-8")
const fullSpec = YAML.parse(fullYamlText)
const implementedSpec = YAML.parse(implementedYamlText)
const completeSpec = {
  ...fullSpec,
  components: {
    ...(fullSpec.components ?? {}),
    parameters: {
      ...(fullSpec.components?.parameters ?? {}),
      ...mergeComponentSource("parameters"),
    },
    responses: {
      ...(fullSpec.components?.responses ?? {}),
      ...mergeComponentSource("responses"),
    },
    schemas: {
      ...(fullSpec.components?.schemas ?? {}),
      ...mergeSchemaSources(),
    },
  },
  paths: {
    ...implementedSpec.paths,
    ...runtimeOnlyPaths(fullSpec),
  },
}
addReviewMetadata(completeSpec)
normalizeLocalSchemaRefs(completeSpec)
const spec = reviewServiceSpec(completeSpec)
addReviewMetadata(spec)

mkdirSync(outDir, { recursive: true })

writeFileSync(
  outPath,
  `// GENERATED FILE. Run \`bun run scripts/generate-openapi-spec.ts\` to regenerate.
// Source: core/specs/api/openapi.yaml paths filtered through core/specs/api/openapi-implemented.yaml

const spec = ${JSON.stringify(spec, null, 2)} as const

export default spec
`,
  "utf-8",
)

console.log(`Generated ${outPath} (${implementedYamlText.length} bytes implemented source)`)
