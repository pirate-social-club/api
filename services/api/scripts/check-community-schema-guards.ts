import { execFileSync } from "node:child_process"
import { existsSync, readdirSync, readFileSync } from "node:fs"
import { basename, dirname, join, resolve } from "node:path"
import { fileURLToPath } from "node:url"
import { REQUIRED_COMMUNITY_DB_MIGRATION } from "../src/lib/community-db-schema-requirement"

type IntroducedColumn = {
  migrationName: string
  migrationPath: string
  table: string
  column: string
}

const API_QUERIED_COMMUNITY_TABLES = new Set([
  "assets",
  "comments",
  "communities",
  "community_memberships",
  "live_rooms",
  "posts",
  "post_purchases",
  "purchases",
])

const scriptDir = dirname(fileURLToPath(import.meta.url))
const apiRoot = resolve(scriptDir, "..")
const repoRoot = resolve(apiRoot, "../..")

function git(args: string[]): string {
  try {
    return execFileSync("git", ["-C", repoRoot, ...args], { encoding: "utf8", stdio: ["ignore", "pipe", "ignore"] }).trim()
  } catch {
    return ""
  }
}

function changedFiles(): string[] {
  const changed = new Set<string>()
  const candidates = [
    ["diff", "--name-only", "--diff-filter=ACMR", "HEAD"],
    ["diff", "--name-only", "--cached", "--diff-filter=ACMR"],
    ["diff", "--name-only", "--diff-filter=ACMR", "origin/main...HEAD"],
  ]
  for (const args of candidates) {
    for (const file of git(args).split("\n")) {
      const trimmed = file.trim()
      if (trimmed) {
        changed.add(trimmed)
      }
    }
  }
  return [...changed].sort()
}

function changedGeneratedMigrationNames(): string[] {
  const diff = git(["diff", "--unified=0", "--", "services/community-provision-operator/src/generated/community-migrations.ts"])
  const names = new Set<string>()
  for (const line of diff.split("\n")) {
    if (!line.startsWith("+") || line.startsWith("+++")) {
      continue
    }
    const match = line.match(/name:\s*"([^"]+\.sql)"/)
    if (match?.[1]) {
      names.add(match[1])
    }
  }
  return [...names].sort()
}

function compareMigrationNames(left: string, right: string): number {
  return left.localeCompare(right)
}

function migrationPathFromChangedFile(file: string): string | null {
  if (!file.endsWith(".sql") || !file.includes("db/community-template/migrations/")) {
    return null
  }
  return file
}

function readChangedMigration(file: string): { path: string; sql: string } | null {
  const candidates = [
    resolve(repoRoot, file),
    resolve(repoRoot, "core", file.replace(/^core\//, "")),
    resolve(repoRoot, "..", file),
  ]
  for (const candidate of candidates) {
    if (existsSync(candidate)) {
      return { path: candidate, sql: readFileSync(candidate, "utf8") }
    }
  }
  return null
}

function readMigrationByName(migrationName: string): { path: string; sql: string } | null {
  const candidates = [
    resolve(repoRoot, "services/api/test-fixtures/db/community-template/migrations", migrationName),
    resolve(repoRoot, "core/db/community-template/migrations", migrationName),
    resolve(repoRoot, "../core/db/community-template/migrations", migrationName),
  ]
  for (const candidate of candidates) {
    if (existsSync(candidate)) {
      return { path: candidate, sql: readFileSync(candidate, "utf8") }
    }
  }
  return null
}

function stripIdentifier(value: string): string {
  return value.replace(/^[`"[]/, "").replace(/[`"\]]$/, "")
}

function extractAlterTableColumns(sql: string, migrationName: string, migrationPath: string): IntroducedColumn[] {
  const columns: IntroducedColumn[] = []
  const pattern = /ALTER\s+TABLE\s+(?:IF\s+EXISTS\s+)?([`"\[]?[A-Za-z_][A-Za-z0-9_]*[`"\]]?)\s+ADD\s+COLUMN\s+(?:IF\s+NOT\s+EXISTS\s+)?([`"\[]?[A-Za-z_][A-Za-z0-9_]*[`"\]]?)/gi
  for (const match of sql.matchAll(pattern)) {
    const table = stripIdentifier(match[1] ?? "")
    const column = stripIdentifier(match[2] ?? "")
    if (table && column) {
      columns.push({ migrationName, migrationPath, table, column })
    }
  }
  return columns
}

function splitCreateTableBody(body: string): string[] {
  const parts: string[] = []
  let current = ""
  let depth = 0
  let inSingleQuote = false
  for (let index = 0; index < body.length; index += 1) {
    const char = body[index]
    const next = body[index + 1]
    current += char
    if (char === "'" && body[index - 1] !== "\\") {
      if (inSingleQuote && next === "'") {
        current += next
        index += 1
        continue
      }
      inSingleQuote = !inSingleQuote
      continue
    }
    if (inSingleQuote) {
      continue
    }
    if (char === "(") {
      depth += 1
      continue
    }
    if (char === ")") {
      depth = Math.max(0, depth - 1)
      continue
    }
    if (char === "," && depth === 0) {
      parts.push(current.slice(0, -1).trim())
      current = ""
    }
  }
  const trailing = current.trim()
  if (trailing) {
    parts.push(trailing)
  }
  return parts
}

function extractCreateTableColumns(sql: string, migrationName: string, migrationPath: string): IntroducedColumn[] {
  const columns: IntroducedColumn[] = []
  const pattern = /CREATE\s+TABLE\s+(?:IF\s+NOT\s+EXISTS\s+)?([`"\[]?[A-Za-z_][A-Za-z0-9_]*[`"\]]?)\s*\(/gi
  for (const match of sql.matchAll(pattern)) {
    const rawTable = stripIdentifier(match[1] ?? "")
    const bodyStart = match.index + match[0].length
    let depth = 1
    let bodyEnd = bodyStart
    for (; bodyEnd < sql.length; bodyEnd += 1) {
      const char = sql[bodyEnd]
      if (char === "(") {
        depth += 1
      } else if (char === ")") {
        depth -= 1
        if (depth === 0) {
          break
        }
      }
    }
    if (!rawTable || depth !== 0) {
      continue
    }
    const isRebuild = rawTable.endsWith("_next")
    const table = isRebuild ? rawTable.slice(0, -"_next".length) : rawTable
    if (!isRebuild && !API_QUERIED_COMMUNITY_TABLES.has(table)) {
      continue
    }
    const body = sql.slice(bodyStart, bodyEnd)
    for (const definition of splitCreateTableBody(body)) {
      const firstToken = definition.trim().split(/\s+/)[0] ?? ""
      const keyword = stripIdentifier(firstToken).toUpperCase()
      if (!keyword || ["CHECK", "CONSTRAINT", "FOREIGN", "PRIMARY", "UNIQUE"].includes(keyword)) {
        continue
      }
      columns.push({
        migrationName,
        migrationPath,
        table,
        column: stripIdentifier(firstToken),
      })
    }
  }
  return columns
}

function introducedColumnsFromChangedMigrations(files: string[]): IntroducedColumn[] {
  const columns: IntroducedColumn[] = []
  for (const file of files) {
    const migrationFile = migrationPathFromChangedFile(file)
    if (!migrationFile) {
      continue
    }
    const migrationName = basename(migrationFile)
    if (compareMigrationNames(migrationName, REQUIRED_COMMUNITY_DB_MIGRATION) < 0) {
      continue
    }
    const migration = readChangedMigration(migrationFile)
    if (!migration) {
      continue
    }
    columns.push(
      ...extractAlterTableColumns(migration.sql, migrationName, migration.path),
      ...extractCreateTableColumns(migration.sql, migrationName, migration.path),
    )
  }
  for (const migrationName of changedGeneratedMigrationNames()) {
    if (compareMigrationNames(migrationName, REQUIRED_COMMUNITY_DB_MIGRATION) < 0) {
      continue
    }
    const migration = readMigrationByName(migrationName)
    if (!migration) {
      continue
    }
    columns.push(
      ...extractAlterTableColumns(migration.sql, migrationName, migration.path),
      ...extractCreateTableColumns(migration.sql, migrationName, migration.path),
    )
  }
  const deduped = new Map<string, IntroducedColumn>()
  for (const column of columns) {
    deduped.set(`${column.migrationName}:${column.table}.${column.column}`, column)
  }
  return [...deduped.values()]
}

function listTsFiles(root: string): string[] {
  const files: string[] = []
  for (const entry of readdirSync(root, { withFileTypes: true })) {
    const fullPath = join(root, entry.name)
    if (entry.isDirectory()) {
      files.push(...listTsFiles(fullPath))
    } else if (entry.isFile() && entry.name.endsWith(".ts")) {
      files.push(fullPath)
    }
  }
  return files
}

function apiReferencesForColumn(column: IntroducedColumn): string[] {
  const matches: string[] = []
  for (const file of listTsFiles(join(apiRoot, "src"))) {
    const text = readFileSync(file, "utf8")
    if (text.includes(column.column)) {
      matches.push(file)
    }
  }
  return matches
}

function changedFileText(files: string[]): string {
  return files
    .map((file) => resolve(repoRoot, file))
    .filter((file) => existsSync(file) && file.endsWith(".ts"))
    .map((file) => readFileSync(file, "utf8"))
    .join("\n")
}

function hasSchemaGuardEvidence(files: string[], columns: IntroducedColumn[]): boolean {
  const text = changedFileText(files)
  if (/\bPRAGMA\s+table_info\b/i.test(text) || /\bresolve[A-Za-z0-9_]*Schema\b/.test(text)) {
    return true
  }
  if (/\bPostProjectionSchema\b/.test(text) || /\bmissing_column\b/.test(text)) {
    return true
  }
  return columns.some((column) => {
    const escapedColumn = column.column.replace(/[.*+?^${}()|[\]\\]/g, "\\$&")
    const withoutColumn = new RegExp(`without[^\\n]{0,120}${escapedColumn}|${escapedColumn}[^\\n]{0,120}without`, "i")
    const preMigration = new RegExp(`pre[-_ ]?migration|N-1|n-1|throughMigration|${escapedColumn}[^\\n]{0,120}missing`, "i")
    return withoutColumn.test(text) || preMigration.test(text)
  })
}

function relative(file: string): string {
  return file.startsWith(repoRoot) ? file.slice(repoRoot.length + 1) : file
}

function main(): void {
  const files = changedFiles()
  const introducedColumns = introducedColumnsFromChangedMigrations(files)
  if (introducedColumns.length === 0) {
    console.log("community schema guard check passed: no changed community migration columns")
    return
  }

  const references = new Map<string, string[]>()
  for (const column of introducedColumns) {
    const matches = apiReferencesForColumn(column)
    if (matches.length > 0) {
      references.set(`${column.table}.${column.column}`, matches)
    }
  }
  if (references.size === 0 || hasSchemaGuardEvidence(files, introducedColumns)) {
    console.log("community schema guard check passed")
    return
  }

  console.error("community schema guard check failed")
  console.error("")
  console.error("Migration introduced:")
  for (const column of introducedColumns) {
    console.error(`  ${column.table}.${column.column} in ${column.migrationName}`)
  }
  console.error("")
  console.error("API references:")
  for (const [column, matches] of references.entries()) {
    console.error(`  ${column}`)
    for (const match of matches) {
      console.error(`    ${relative(match)}`)
    }
  }
  console.error("")
  console.error("Missing:")
  console.error("  schema-aware guard")
  console.error("  N-1 compatibility test")
  process.exit(1)
}

main()
