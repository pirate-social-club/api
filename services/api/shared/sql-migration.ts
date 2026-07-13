export function splitSqlStatements(sql: string): string[] {
  const statements: string[] = []
  let current = ""
  let inSingleQuote = false
  let inLineComment = false
  let inBlockComment = false
  let inTrigger = false
  let dollarQuoteTag: string | null = null

  for (let index = 0; index < sql.length; index += 1) {
    const char = sql[index]
    const next = sql[index + 1]
    current += char

    // Inside a `--` line comment: consume to end of line. A ';' or apostrophe here must NOT
    // split the statement or toggle quote state — Postgres ignores comment content, and the
    // SQLite test mirror must match (e.g. migration 0122's "(superuser); the ..." comment).
    if (inLineComment) {
      if (char === "\n") inLineComment = false
      continue
    }
    // Inside a `/* */` block comment: consume to the closing delimiter.
    if (inBlockComment) {
      if (char === "/" && sql[index - 1] === "*") inBlockComment = false
      continue
    }
    // A comment starts only outside string / dollar-quote context (a '--' inside a literal is data).
    if (!inSingleQuote && !dollarQuoteTag) {
      if (char === "-" && next === "-") { inLineComment = true; current += next; index += 1; continue }
      if (char === "/" && next === "*") { inBlockComment = true; current += next; index += 1; continue }
    }

    if (!inSingleQuote && char === "$") {
      const remainder = sql.slice(index)
      const dollarMatch = remainder.match(/^\$([A-Za-z_][A-Za-z0-9_]*)?\$/)
      if (dollarMatch) {
        const matchedTag = dollarMatch[0]
        if (dollarQuoteTag === null) {
          dollarQuoteTag = matchedTag
        } else if (dollarQuoteTag === matchedTag) {
          dollarQuoteTag = null
        }
        if (matchedTag.length > 1) {
          current += matchedTag.slice(1)
          index += matchedTag.length - 1
          continue
        }
      }
    }

    if (!inSingleQuote && !inTrigger && current.trimStart().toUpperCase().startsWith("CREATE TRIGGER")) {
      inTrigger = true
    }

    if (char === "'" && sql[index - 1] !== "\\") {
      if (inSingleQuote && next === "'") {
        current += next
        index += 1
        continue
      }
      inSingleQuote = !inSingleQuote
      continue
    }

    if (dollarQuoteTag) {
      continue
    }

    if (inTrigger && !inSingleQuote && current.trimEnd().toUpperCase().endsWith("END;")) {
      const statement = current.trim()
      if (statement) {
        statements.push(statement)
      }
      current = ""
      inTrigger = false
      continue
    }

    if (char === ";" && !inSingleQuote && !inTrigger) {
      const statement = current.trim()
      if (statement) {
        statements.push(statement)
      }
      current = ""
    }
  }

  const trailing = current.trim()
  if (trailing && !isSqlCommentOnly(trailing)) {
    statements.push(trailing)
  }

  return statements
}

function isSqlCommentOnly(statement: string): boolean {
  return statement
    .split("\n")
    .every((line) => {
      const trimmed = line.trim()
      return trimmed === "" || trimmed.startsWith("--")
    })
}

const SQLITE_NAMESPACE_VERIFICATIONS_SPACES_ROOT_LABEL_ASCII_TRIGGERS = [
  `
    CREATE TRIGGER IF NOT EXISTS namespace_verifications_spaces_root_label_ascii_insert
    BEFORE INSERT ON namespace_verifications
    FOR EACH ROW
    WHEN NEW.family = 'spaces'
      AND (
        NEW.normalized_root_label = ''
        OR NEW.normalized_root_label GLOB '*[^a-z0-9-]*'
      )
    BEGIN
      SELECT RAISE(ABORT, 'spaces normalized_root_label must be canonical IDNA ASCII');
    END;
  `,
  `
    CREATE TRIGGER IF NOT EXISTS namespace_verifications_spaces_root_label_ascii_update
    BEFORE UPDATE OF family, normalized_root_label ON namespace_verifications
    FOR EACH ROW
    WHEN NEW.family = 'spaces'
      AND (
        NEW.normalized_root_label = ''
        OR NEW.normalized_root_label GLOB '*[^a-z0-9-]*'
      )
    BEGIN
      SELECT RAISE(ABORT, 'spaces normalized_root_label must be canonical IDNA ASCII');
    END;
  `,
]

// SQLite cannot ALTER a CHECK constraint, and simply dropping the ADD CONSTRAINT
// (as every other constraint statement is) would leave the baseline's inline
// CHECK rejecting assertion names introduced by later migrations. Rebuild the
// table so the SQLite mirror enforces exactly the enum Postgres does. Keep this
// list in sync with the newest migration that redefines the constraint.
const SQLITE_NAMESPACE_VERIFICATION_ASSERTIONS_NAME_CHECK_REBUILD = [
  `
    CREATE TABLE namespace_verification_assertions_sqlite_rebuild (
      assertion_record_id TEXT PRIMARY KEY,
      namespace_verification_session_id TEXT NOT NULL,
      namespace_verification_id TEXT,
      family TEXT NOT NULL CHECK (family IN ('hns', 'spaces')),
      assertion_name TEXT NOT NULL CHECK (
        assertion_name IN (
          'root_exists',
          'root_control_verified',
          'expiry_horizon_sufficient',
          'routing_enabled',
          'pirate_dns_authority_verified',
          'authority_health_verified',
          'root_key_proof_verified',
          'fabric_publish_verified',
          'anchor_fresh_enough',
          'owner_signed_updates_verified'
        )
      ),
      assertion_value INTEGER CHECK (assertion_value IS NULL OR assertion_value IN (0, 1)),
      source_evidence_bundle_id TEXT,
      status TEXT NOT NULL CHECK (status IN ('accepted', 'stale', 'disputed', 'superseded')),
      first_accepted_at TIMESTAMPTZ,
      last_revalidated_at TIMESTAMPTZ,
      created_at TIMESTAMPTZ NOT NULL,
      updated_at TIMESTAMPTZ NOT NULL,
      FOREIGN KEY (namespace_verification_session_id) REFERENCES namespace_verification_sessions(namespace_verification_session_id),
      FOREIGN KEY (namespace_verification_id) REFERENCES namespace_verifications(namespace_verification_id),
      FOREIGN KEY (source_evidence_bundle_id) REFERENCES namespace_verification_evidence_bundles(evidence_bundle_id)
    );
  `,
  `
    INSERT INTO namespace_verification_assertions_sqlite_rebuild
    SELECT
      assertion_record_id,
      namespace_verification_session_id,
      namespace_verification_id,
      family,
      assertion_name,
      assertion_value,
      source_evidence_bundle_id,
      status,
      first_accepted_at,
      last_revalidated_at,
      created_at,
      updated_at
    FROM namespace_verification_assertions;
  `,
  `DROP TABLE namespace_verification_assertions;`,
  `ALTER TABLE namespace_verification_assertions_sqlite_rebuild RENAME TO namespace_verification_assertions;`,
  `
    CREATE INDEX IF NOT EXISTS idx_namespace_verification_assertions_session
      ON namespace_verification_assertions(namespace_verification_session_id, assertion_name);
  `,
  `
    CREATE INDEX IF NOT EXISTS idx_namespace_verification_assertions_verification
      ON namespace_verification_assertions(namespace_verification_id, assertion_name, status);
  `,
]

// Drop leading blank / `--` comment lines so statement-type detection sees the real SQL. The
// splitter glues a file's leading comment block onto its first statement; without this, a
// skippable Postgres-only statement (e.g. `ALTER TABLE ... OWNER TO`) preceded by comments would
// fail the prefix checks and leak through to SQLite.
function stripLeadingComments(statement: string): string {
  const lines = statement.split("\n")
  let i = 0
  while (i < lines.length) {
    const trimmed = lines[i].trim()
    if (trimmed === "" || trimmed.startsWith("--")) i += 1
    else break
  }
  return lines.slice(i).join("\n")
}

export function toSqliteCompatibleStatements(statement: string): string[] {
  const normalized = stripLeadingComments(statement).trim().replace(/\s+/g, " ").toUpperCase()

  if (isSqlCommentOnly(statement)) {
    return []
  }

  if (normalized.startsWith("DO ")) {
    return []
  }

  // PostgreSQL trigger functions and EXECUTE FUNCTION triggers have no SQLite
  // equivalent. Local mirrors exercise application behavior; the real-PostgreSQL
  // reward suite applies the canonical migration and verifies these guards.
  if (normalized.startsWith("CREATE FUNCTION ")) {
    return []
  }
  if (normalized.startsWith("CREATE TRIGGER ") && normalized.includes(" EXECUTE FUNCTION ")) {
    return []
  }

  if (normalized.startsWith("GRANT ")) {
    return []
  }

  if (normalized.startsWith("REVOKE ")) {
    return []
  }

  // Postgres-only ownership reassignment (roles do not exist in SQLite). Same category as GRANT:
  // irrelevant to the SQLite test mirror, so skip it (e.g. migration 0122's ALTER TABLE ... OWNER TO).
  if (normalized.startsWith("ALTER TABLE") && normalized.includes(" OWNER TO ")) {
    return []
  }

  // SQLite cannot change an existing column's nullability with ALTER COLUMN.
  // The local mirror preserves the data migration that surrounds these
  // PostgreSQL constraints, but cannot enforce the final SET/DROP NOT NULL.
  if (
    normalized.startsWith("ALTER TABLE")
    && normalized.includes(" ALTER COLUMN ")
    && (normalized.includes(" SET NOT NULL") || normalized.includes(" DROP NOT NULL"))
  ) {
    return []
  }

  if (normalized.startsWith("ALTER TABLE") && normalized.includes(" DROP CONSTRAINT ")) {
    return []
  }

  if (normalized.startsWith("ALTER TABLE") && normalized.includes(" ADD CONSTRAINT ")) {
    if (
      normalized.includes("NAMESPACE_VERIFICATIONS_SPACES_ROOT_LABEL_ASCII_CHECK")
      && normalized.includes("ALTER TABLE NAMESPACE_VERIFICATIONS")
    ) {
      return SQLITE_NAMESPACE_VERIFICATIONS_SPACES_ROOT_LABEL_ASCII_TRIGGERS
    }
    if (normalized.includes("NAMESPACE_VERIFICATION_ASSERTIONS_ASSERTION_NAME_CHECK")) {
      return SQLITE_NAMESPACE_VERIFICATION_ASSERTIONS_NAME_CHECK_REBUILD
    }
    return []
  }

  let sqliteCompat = statement
  if (normalized.startsWith("CREATE TABLE IF NOT EXISTS COMMUNITY_ASSISTANT_CREDENTIALS")) {
    sqliteCompat = sqliteCompat.replace(
      /provider\s+IN\s+\('openrouter'\)/i,
      "provider IN ('openrouter', 'elevenlabs')",
    )
  }
  if (normalized.startsWith("ALTER TABLE VERIFICATION_SESSIONS") && normalized.includes(" ADD COLUMN ") && normalized.includes("PROVIDER_MODE")) {
    sqliteCompat = sqliteCompat.replace(
      /provider_mode\s+IN\s+\('qr_deeplink',\s*'widget',\s*'native_sdk'\)/i,
      "provider_mode IN ('qr_deeplink', 'widget', 'native_sdk', 'web_sdk')",
    )
  }
  if (normalized.startsWith("CREATE TABLE IDENTITY_NULLIFIERS")) {
    sqliteCompat = sqliteCompat
      .replace(/provider\s+IN\s+\('self',\s*'very'\)/i, "provider IN ('self', 'very', 'zkpassport')")
      .replace(
        /mechanism\s+IN\s+\('zk-nullifier',\s*'palm-nullifier'\)/i,
        "mechanism IN ('zk-nullifier', 'palm-nullifier', 'zkpassport-unique-identifier')",
      )
  }
  if (normalized.startsWith("CREATE TABLE REWARD_EVENTS")) {
    // SQLite cannot replace table CHECK constraints through ALTER TABLE. The
    // canonical 0134 migration expands these enums for campaign credits, so
    // build the local test mirror with the final accepted values up front.
    sqliteCompat = sqliteCompat
      .replace(
        /reward_kind\s+IN\s+\(\s*'study_streak_day',\s*'study_streak_milestone_7',\s*'study_streak_milestone_30'\s*\)/i,
        "reward_kind IN ('study_streak_day', 'study_streak_milestone_7', 'study_streak_milestone_30', 'campaign_practice_day', 'campaign_milestone_7', 'campaign_milestone_30')",
      )
      .replace(
        /source\s+IN\s+\(\s*'song_engagement_reconciler'\s*\)/i,
        "source IN ('song_engagement_reconciler', 'reward_campaign_reconciler')",
      )
  }
  if (normalized.startsWith("CREATE TABLE COMMUNITY_DATABASE_ROUTING")) {
    // Migration 0124 drops the Turso `backend` column, but it does so inside a
    // Postgres DO block that this SQLite mirror skips — so the column survives here.
    // The API no longer writes it, so make it nullable (and drop the value CHECK) so
    // backend-less inserts succeed. chk_d1_fields still passes: a NULL backend makes
    // the whole predicate NULL, which SQLite treats as a satisfied CHECK.
    // Migration 0125 drops community_database_bindings. SQLite cannot drop the FK
    // embedded in this original CREATE TABLE, so remove that Turso-only reference
    // from the local mirror up front.
    sqliteCompat = sqliteCompat.replace(
      /backend\s+TEXT\s+NOT\s+NULL\s+CHECK\s*\(\s*backend\s+IN\s*\('turso',\s*'d1'\)\s*\)/i,
      "backend TEXT",
    )
    sqliteCompat = sqliteCompat.replace(
      /,\s*FOREIGN KEY\s*\(turso_database_binding_id\)\s+REFERENCES\s+community_database_bindings\s*\(community_database_binding_id\)/i,
      "",
    )
  }
  sqliteCompat = sqliteCompat.replace(/\bJSONB\b/gi, "TEXT")
  sqliteCompat = sqliteCompat.replace(/\bTIMESTAMPTZ\b/gi, "TEXT")
  sqliteCompat = sqliteCompat.replace(/\bTIMESTAMP\b/gi, "TEXT")
  sqliteCompat = sqliteCompat.replace(/\bNOW\(\)/gi, "CURRENT_TIMESTAMP")
  sqliteCompat = sqliteCompat.replace(/\bADD COLUMN IF NOT EXISTS\b/gi, "ADD COLUMN")
  sqliteCompat = sqliteCompat.replace(/::(?:jsonb|text)\b/gi, "")

  return [sqliteCompat]
}

export function toSqliteCompatibleStatement(statement: string): string | null {
  return toSqliteCompatibleStatements(statement)[0] ?? null
}
