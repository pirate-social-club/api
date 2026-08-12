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

// Schema/connection verbs — never allowed on the runtime WRITE path (managed by
// migrations, not runtime writes). Kept as defense-in-depth alongside the
// positive allowlist below.
const FORBIDDEN_WRITE_VERB =
  /\b(CREATE|ALTER|DROP|ATTACH|DETACH|VACUUM|ANALYZE|REINDEX|TRUNCATE|GRANT|REVOKE|PRAGMA)\b/i

const DML_VERB = /\b(INSERT|UPDATE|DELETE|REPLACE)\b/i

/**
 * Guard for the runtime write path (shard `batchWrite`): a POSITIVE ALLOWLIST.
 * Allows only leading-DML (`INSERT`/`UPDATE`/`DELETE`/`REPLACE`) and write CTEs
 * (`WITH ... <DML>`); rejects everything else — `SELECT` (reads use execute/batch),
 * `BEGIN`/`COMMIT`, `EXPLAIN`, unknown verbs — plus DDL/PRAGMA and statement
 * batching. Same fail-closed lexical posture as the read guard (not a SQL
 * authorizer; a guardrail for our own query builders).
 */
export function isWriteAllowedStatement(sql: string): boolean {
  const stripped = stripLeadingNoise(sql)
  if (hasStatementBatch(stripped)) return false
  if (FORBIDDEN_WRITE_VERB.test(stripped)) return false
  if (/^(INSERT|UPDATE|DELETE|REPLACE)\b/i.test(stripped)) return true
  // A CTE is a write only if it wraps a DML verb (WITH x AS (...) INSERT ...).
  if (/^WITH\b/i.test(stripped)) return DML_VERB.test(stripped)
  return false
}

// Destructive DDL — never allowed on the bootstrap path. CREATE TABLE IF NOT
// EXISTS is allowed (it's the schema bootstrap); everything else (DROP/ALTER/
// ATTACH/DETACH/VACUUM/ANALYZE/REINDEX/TRUNCATE/GRANT/REVOKE/PRAGMA) is not.
// This runs over the WHOLE statement text, trigger bodies included.
const FORBIDDEN_BOOTSTRAP_VERB =
  /\b(DROP|ALTER|ATTACH|DETACH|VACUUM|ANALYZE|REINDEX|TRUNCATE|GRANT|REVOKE|PRAGMA)\b/i

const DML_OR_DDL_VERB = /\b(INSERT|UPDATE|DELETE|REPLACE|CREATE)\b/i

/**
 * A single `CREATE TRIGGER ... BEGIN ... END` statement. SQLite trigger bodies
 * hold their own `;`-terminated statements, so the flat batching rule rejects
 * every real trigger — including the integrity triggers in the generated
 * community schema snapshot (migration 1147), whose rejection took down
 * d1_native provisioning in production. Internal semicolons are tolerated only
 * inside this exact shape: a CREATE TRIGGER whose text closes with END (one
 * trailing `;` is fine). A second statement smuggled after END means either
 * the text no longer ends with END, or an `END;` terminator appears mid-text —
 * both fail below; and FORBIDDEN_BOOTSTRAP_VERB still runs over the whole
 * text, so a trigger body cannot smuggle DROP/ALTER/PRAGMA either. What
 * remains (INSERT/UPDATE/DELETE/CREATE inside the body) is already allowed on
 * this path.
 *
 * Known fail-closed false positive, consistent with this module's lexical
 * posture: a body whose own statements end with the `END` keyword (e.g. a
 * `CASE ... END;` expression) trips the mid-text `END;` check and is rejected.
 */
function isSingleCreateTrigger(stripped: string): boolean {
  if (!/^CREATE\s+TRIGGER\b/i.test(stripped)) return false
  if (!/\bBEGIN\b/i.test(stripped)) return false
  const body = stripped.replace(/;\s*$/, "")
  if (!/\bEND\s*$/i.test(body)) return false
  // Exactly one trigger: an `END;` terminator anywhere earlier means a second
  // statement follows the first trigger's body.
  return !/\bEND\s*;/i.test(body)
}

/**
 * Guard for the bootstrap path (shard `communityD1LoadSnapshot`, step 3 of the
 * D1-native workstream). A POSITIVE ALLOWLIST, slightly wider than
 * `isWriteAllowedStatement` — it permits `CREATE TABLE IF NOT EXISTS` (DDL)
 * because the bootstrap path applies the community schema to a fresh D1
 * binding, plus single `CREATE TRIGGER ... BEGIN ... END` statements whose
 * body semicolons are confined to the trigger (see isSingleCreateTrigger). It
 * still rejects destructive DDL (DROP/ALTER/...), PRAGMA, SELECT (reads use
 * `execute`/`batch`), and statement batching. Same fail-closed lexical
 * posture: a guardrail for our own schema-bootstrap builder, not a SQL
 * authorizer for untrusted input.
 */
export function isBootstrapAllowedStatement(sql: string): boolean {
  const stripped = stripLeadingNoise(sql)
  // Forbidden verbs first, over the whole text: they apply inside trigger
  // bodies too, which is what makes tolerating trigger-body semicolons safe.
  if (FORBIDDEN_BOOTSTRAP_VERB.test(stripped)) return false
  if (hasStatementBatch(stripped) && !isSingleCreateTrigger(stripped)) return false
  if (/^(INSERT|UPDATE|DELETE|REPLACE|CREATE)\b/i.test(stripped)) return true
  // A CTE is bootstrap only if it wraps a DML or DDL verb.
  if (/^WITH\b/i.test(stripped)) return DML_OR_DDL_VERB.test(stripped)
  return false
}
