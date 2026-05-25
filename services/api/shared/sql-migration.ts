export function splitSqlStatements(sql: string): string[] {
  const statements: string[] = []
  let current = ""
  let inSingleQuote = false
  let inTrigger = false
  let dollarQuoteTag: string | null = null

  for (let index = 0; index < sql.length; index += 1) {
    const char = sql[index]
    const next = sql[index + 1]
    current += char

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

export function toSqliteCompatibleStatements(statement: string): string[] {
  const normalized = statement.trim().replace(/\s+/g, " ").toUpperCase()

  if (isSqlCommentOnly(statement)) {
    return []
  }

  if (normalized.startsWith("DO ")) {
    return []
  }

  if (normalized.startsWith("GRANT ")) {
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
    return []
  }

  let sqliteCompat = statement
  if (normalized.startsWith("CREATE TABLE IF NOT EXISTS COMMUNITY_ASSISTANT_CREDENTIALS")) {
    sqliteCompat = sqliteCompat.replace(
      /provider\s+IN\s+\('openrouter'\)/i,
      "provider IN ('openrouter', 'elevenlabs')",
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
