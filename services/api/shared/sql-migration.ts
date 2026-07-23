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

// Migration 0153 adds seven columns plus table-level CHECK/FK constraints in
// one PostgreSQL ALTER TABLE. SQLite supports neither comma-separated ADD
// COLUMN clauses nor ADD CONSTRAINT, so rebuild the table while preserving all
// 0152 invariants. The fixture itself remains byte-identical to Core; this is
// the dialect boundary used by every control-plane fixture.
const SQLITE_HNS_ROOT_DELEGATION_STATE_REDUNDANCY_REBUILD = [
  `
    CREATE TABLE hns_root_delegation_state_sqlite_rebuild (
      normalized_root_label TEXT PRIMARY KEY,
      rollover_state TEXT NOT NULL CHECK (
        rollover_state IN (
          'none',
          'required',
          'new_key_prepublished',
          'new_ds_pending',
          'overlap',
          'old_ds_removal_pending'
        )
      ),
      expected_keyset_id TEXT,
      expected_ds_derived_at TIMESTAMPTZ,
      pending_keyset_id TEXT,
      pending_evidence_kind TEXT CHECK (
        pending_evidence_kind IS NULL OR pending_evidence_kind IN (
          'wallet_transaction_id',
          'mempool_observation',
          'user_acknowledgement'
        )
      ),
      pending_evidence_ref TEXT,
      pending_evidence_at TIMESTAMPTZ,
      last_parent_observation_id TEXT,
      last_parent_observation_outcome TEXT CHECK (
        last_parent_observation_outcome IS NULL
        OR last_parent_observation_outcome = 'succeeded'
      ),
      last_parent_observation_attempt_at TIMESTAMPTZ,
      state_changed_at TIMESTAMPTZ NOT NULL,
      created_at TIMESTAMPTZ NOT NULL,
      updated_at TIMESTAMPTZ NOT NULL,
      authority_redundancy_ok INTEGER CHECK (
        authority_redundancy_ok IS NULL OR authority_redundancy_ok IN (0, 1)
      ),
      last_redundancy_observation_id TEXT,
      last_redundancy_observation_outcome TEXT CHECK (
        last_redundancy_observation_outcome IS NULL
        OR last_redundancy_observation_outcome = 'succeeded'
      ),
      last_redundancy_observation_at TIMESTAMPTZ,
      last_redundancy_observation_attempt_at TIMESTAMPTZ,
      canonical_routing_eligible INTEGER NOT NULL DEFAULT 0 CHECK (
        canonical_routing_eligible IN (0, 1)
      ),
      routing_hard_denied INTEGER NOT NULL DEFAULT 0 CHECK (
        routing_hard_denied IN (0, 1)
      ),
      FOREIGN KEY (expected_keyset_id, normalized_root_label)
        REFERENCES hns_root_issued_keysets(issued_keyset_id, normalized_root_label),
      FOREIGN KEY (pending_keyset_id, normalized_root_label)
        REFERENCES hns_root_issued_keysets(issued_keyset_id, normalized_root_label),
      FOREIGN KEY (
        last_parent_observation_id,
        normalized_root_label,
        last_parent_observation_outcome
      ) REFERENCES hns_root_parent_observations(
        parent_observation_id,
        normalized_root_label,
        outcome
      ),
      FOREIGN KEY (
        last_redundancy_observation_id,
        normalized_root_label,
        last_redundancy_observation_outcome
      ) REFERENCES hns_root_redundancy_observations(
        redundancy_observation_id,
        normalized_root_label,
        outcome
      ),
      CONSTRAINT hns_root_delegation_state_pending_evidence_complete CHECK (
        (pending_evidence_kind IS NULL
          AND pending_evidence_ref IS NULL
          AND pending_evidence_at IS NULL)
        OR (pending_evidence_kind IS NOT NULL
          AND pending_evidence_ref IS NOT NULL
          AND pending_evidence_at IS NOT NULL)
      ),
      CONSTRAINT hns_root_delegation_state_last_observation_complete CHECK (
        (last_parent_observation_id IS NULL
          AND last_parent_observation_outcome IS NULL)
        OR (last_parent_observation_id IS NOT NULL
          AND last_parent_observation_outcome IS NOT NULL)
      ),
      CONSTRAINT hns_root_delegation_state_redundancy_complete CHECK (
        (authority_redundancy_ok IS NULL
          AND last_redundancy_observation_id IS NULL
          AND last_redundancy_observation_outcome IS NULL
          AND last_redundancy_observation_at IS NULL)
        OR (authority_redundancy_ok IS NOT NULL
          AND last_redundancy_observation_id IS NOT NULL
          AND last_redundancy_observation_outcome = 'succeeded'
          AND last_redundancy_observation_at IS NOT NULL)
      )
    );
  `,
  `
    INSERT INTO hns_root_delegation_state_sqlite_rebuild (
      normalized_root_label,
      rollover_state,
      expected_keyset_id,
      expected_ds_derived_at,
      pending_keyset_id,
      pending_evidence_kind,
      pending_evidence_ref,
      pending_evidence_at,
      last_parent_observation_id,
      last_parent_observation_outcome,
      last_parent_observation_attempt_at,
      state_changed_at,
      created_at,
      updated_at
    )
    SELECT
      normalized_root_label,
      rollover_state,
      expected_keyset_id,
      expected_ds_derived_at,
      pending_keyset_id,
      pending_evidence_kind,
      pending_evidence_ref,
      pending_evidence_at,
      last_parent_observation_id,
      last_parent_observation_outcome,
      last_parent_observation_attempt_at,
      state_changed_at,
      created_at,
      updated_at
    FROM hns_root_delegation_state;
  `,
  `DROP TABLE hns_root_delegation_state;`,
  `ALTER TABLE hns_root_delegation_state_sqlite_rebuild RENAME TO hns_root_delegation_state;`,
  `
    CREATE INDEX idx_hns_root_delegation_state_observation_due
      ON hns_root_delegation_state(
        (last_parent_observation_attempt_at IS NOT NULL),
        last_parent_observation_attempt_at
      );
  `,
  `
    CREATE INDEX idx_hns_root_delegation_state_last_observation
      ON hns_root_delegation_state(last_parent_observation_id);
  `,
  `
    CREATE INDEX idx_hns_root_delegation_state_rollover
      ON hns_root_delegation_state(rollover_state)
      WHERE rollover_state <> 'none';
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

  if (
    normalized.startsWith("ALTER TABLE HNS_ROOT_DELEGATION_STATE ")
    && normalized.includes("ADD COLUMN AUTHORITY_REDUNDANCY_OK ")
    && normalized.includes("HNS_ROOT_DELEGATION_STATE_REDUNDANCY_COMPLETE")
  ) {
    return SQLITE_HNS_ROOT_DELEGATION_STATE_REDUNDANCY_REBUILD
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
  if (normalized.startsWith("CREATE TABLE REWARD_CAMPAIGN_FUNDING_EFFECTS")) {
    // PostgreSQL migration 0148 expands the custody-state constraints through
    // ALTER TABLE, which SQLite cannot mirror. Build fresh local/test databases
    // with the final enum and receipt invariants in the original CREATE TABLE.
    sqliteCompat = sqliteCompat
      .replace(
        /'quoted',\s*'confirming',\s*'confirmed',\s*'failed',\s*'refunded'/i,
        "'quoted', 'confirming', 'confirmed', 'failed', 'refund_pending', 'refunded'",
      )
      .replace(
        /status\s+IN\s*\(\s*'confirmed',\s*'refunded'\s*\)/gi,
        "status IN ('confirmed', 'refund_pending', 'refunded')",
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
  // PostgreSQL's `~` operator is unavailable in the SQLite test mirror. Preserve the
  // fixed-length lowercase 0x-hex checks used by funding-observation migrations.
  sqliteCompat = sqliteCompat.replace(
    /\b([A-Za-z_][A-Za-z0-9_]*)\s*~\s*'\^0x\[0-9a-f\]\{(\d+)\}\$'/g,
    (_match, column: string, hexLength: string) => {
      const expectedLength = Number(hexLength) + 2
      return `length(${column}) = ${expectedLength} AND substr(${column}, 1, 2) = '0x' AND substr(${column}, 3) NOT GLOB '*[^0-9a-f]*'`
    },
  )

  return [sqliteCompat]
}

export function toSqliteCompatibleStatement(statement: string): string | null {
  return toSqliteCompatibleStatements(statement)[0] ?? null
}
