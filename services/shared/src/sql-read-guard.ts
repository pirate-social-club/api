/**
 * Read-only SQL guardrail, shared by the API's D1 read client and the community
 * D1 shard Worker so the exact same allowlist runs on both sides (no drift).
 *
 * Strict ALLOWLIST, not a write blacklist: only SELECT, read-only CTEs
 * (`WITH ... SELECT`), and specifically approved introspection pragmas pass.
 * Everything else — including assignment pragmas like `PRAGMA user_version = 1` —
 * is rejected.
 *
 * SCOPE: a GUARDRAIL for our own trusted query builders, NOT a SQL authorizer for
 * untrusted input. Lexical, not a parser; it does not understand string literals
 * or dialect quirks. Two known limits, both fail-closed: statement batching is
 * rejected wholesale (a `;` inside a string literal trips it too), and the CTE
 * check rejects any data-/schema-mutating verb anywhere (a read CTE naming a
 * column `update` is rejected). Both err toward rejecting a legal read, never
 * admitting a write.
 */

const WRITE_OR_DDL_VERB =
  /\b(INSERT|UPDATE|DELETE|REPLACE|CREATE|ALTER|DROP|ATTACH|DETACH|VACUUM|ANALYZE|REINDEX|TRUNCATE|GRANT|REVOKE|PRAGMA)\b/i

const APPROVED_READ_PRAGMAS = new Set([
  "table_info",
  "table_xinfo",
  "table_list",
  "index_list",
  "index_info",
  "index_xinfo",
  "foreign_key_list",
  "database_list",
])

function stripLeadingNoise(sql: string): string {
  let current = sql
  let previous: string
  do {
    previous = current
    current = current.replace(/^\s+/, "")
    current = current.replace(/^--[^\n]*\n?/, "")
    current = current.replace(/^\/\*[\s\S]*?\*\//, "")
  } while (current !== previous)
  return current
}

/**
 * Reject statement batching. A single trailing `;` is fine; anything after it
 * (a second statement like `SELECT 1; DROP TABLE t`) is not.
 */
function hasStatementBatch(sql: string): boolean {
  return sql.replace(/;\s*$/, "").includes(";")
}

export function isReadOnlyStatement(sql: string): boolean {
  const stripped = stripLeadingNoise(sql)

  // Defense in depth: no statement batching, regardless of the leading verb.
  if (hasStatementBatch(stripped)) {
    return false
  }

  if (/^SELECT\b/i.test(stripped)) {
    return true
  }

  // A CTE is read-only only if it wraps neither a write nor any DDL.
  if (/^WITH\b/i.test(stripped)) {
    return !WRITE_OR_DDL_VERB.test(stripped)
  }

  const pragma = stripped.match(/^PRAGMA\s+([A-Za-z_]+)/i)
  if (pragma) {
    // The assignment form (`PRAGMA name = value`) writes state — never allowed.
    if (/^PRAGMA\s+[A-Za-z_]+\s*=/i.test(stripped)) {
      return false
    }
    return APPROVED_READ_PRAGMAS.has(pragma[1].toLowerCase())
  }

  return false
}

/** The leading verb of a statement, for violation error messages. */
export function readOnlyVerb(sql: string): string {
  return stripLeadingNoise(sql).split(/\s|\(/, 1)[0]?.toUpperCase() || "statement"
}

// Verbs that change schema or the connection — never allowed on the runtime
// WRITE path (the shard `batchWrite`). DML (INSERT/UPDATE/DELETE/REPLACE) and
// SELECT are fine; schema is managed by migrations, not runtime writes.
const FORBIDDEN_WRITE_VERB =
  /\b(CREATE|ALTER|DROP|ATTACH|DETACH|VACUUM|ANALYZE|REINDEX|TRUNCATE|GRANT|REVOKE|PRAGMA)\b/i

/**
 * Guard for the runtime write path: allow DML + SELECT, reject DDL/PRAGMA/
 * connection verbs and statement batching. Same fail-closed lexical posture as
 * the read guard (a column literally named `create` in a write trips it — safe
 * direction). NOT a SQL authorizer; a guardrail for our own query builders.
 */
export function isWriteAllowedStatement(sql: string): boolean {
  const stripped = stripLeadingNoise(sql)
  if (hasStatementBatch(stripped)) return false
  return !FORBIDDEN_WRITE_VERB.test(stripped)
}
