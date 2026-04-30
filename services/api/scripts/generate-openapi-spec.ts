import { mkdirSync, readdirSync, readFileSync, writeFileSync } from "node:fs"
import { dirname, resolve } from "node:path"
import { fileURLToPath } from "node:url"
import YAML from "yaml"

const scriptDir = dirname(fileURLToPath(import.meta.url))
const repoRoot = resolve(scriptDir, "..", "..", "..", "..")
const fullYamlPath = resolve(repoRoot, "core", "specs", "api", "openapi.yaml")
const implementedYamlPath = resolve(repoRoot, "core", "specs", "api", "openapi-implemented.yaml")
const sourceComponentsDir = resolve(repoRoot, "core", "specs", "api", "src", "components")
const outDir = resolve(scriptDir, "..", "src", "generated")
const outPath = resolve(outDir, "openapi-spec.ts")

type OpenApiRecord = Record<string, any>

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
        if (parameters.some((parameter) => parameter?.in === "path" && parameter?.name === pathParam)) {
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
                  required: ["query", "communities"],
                  properties: {
                    query: { type: "string", nullable: true },
                    communities: {
                      type: "array",
                      items: {
                        type: "object",
                        required: ["community_id", "display_name"],
                        properties: {
                          community_id: { type: "string" },
                          display_name: { type: "string" },
                          route_slug: { type: "string", nullable: true },
                        },
                      },
                    },
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
    "/public-communities/{community_id}/posts": implementedPath(fullSpec.paths["/public-communities/{community_id}/posts"]),
    "/public-posts/{post_id}": implementedPath(fullSpec.paths["/public-posts/{post_id}"]),
    "/public-posts/{post_id}/top-comments": implementedPath(fullSpec.paths["/public-posts/{post_id}/top-comments"]),
    "/public-comments/posts/{post_id}/comments": {
      get: {
        tags: ["Comments"],
        "x-implemented": true,
        security: [],
        summary: "List public comments for a post",
        parameters: [
          { name: "post_id", in: "path", required: true, schema: { type: "string" } },
          { $ref: "#/components/parameters/Cursor" },
          { $ref: "#/components/parameters/Limit" },
        ],
        responses: {
          "200": {
            description: "Public comments",
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

function publicServiceSpec(spec: OpenApiRecord): OpenApiRecord {
  const paths = Object.fromEntries(
    Object.entries(spec.paths ?? {})
      .filter(([path]) => path.startsWith("/public-")),
  )
  const slimSpec: OpenApiRecord = {
    openapi: spec.openapi,
    info: {
      title: "Pirate public structured read API",
      version: spec.info?.version ?? "0.1.0",
      description: "Public structured read API for Pirate communities, posts, comments, profiles, and agents.",
    },
    servers: spec.servers,
    tags: (spec.tags ?? []).filter((tag: OpenApiRecord) =>
      ["Agents", "Comments", "Communities", "Posts", "Profiles"].includes(String(tag.name)),
    ),
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
    setRef(slimSpec, ref, copy)
    collectRefs(copy, pendingRefs)
  }
  return slimSpec
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
const spec = publicServiceSpec(completeSpec)
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
