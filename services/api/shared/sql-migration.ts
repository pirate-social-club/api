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

export function toSqliteCompatibleStatement(statement: string): string | null {
  const normalized = statement.trim().replace(/\s+/g, " ").toUpperCase()

  if (isSqlCommentOnly(statement)) {
    return null
  }

  if (normalized.startsWith("DO ")) {
    return null
  }

  if (normalized.startsWith("GRANT ")) {
    return null
  }

  if (normalized.startsWith("ALTER TABLE") && normalized.includes(" DROP CONSTRAINT ")) {
    return null
  }

  if (normalized.startsWith("ALTER TABLE") && normalized.includes(" ADD CONSTRAINT ")) {
    return null
  }

  let sqliteCompat = statement
  sqliteCompat = sqliteCompat.replace(/\bJSONB\b/gi, "TEXT")
  sqliteCompat = sqliteCompat.replace(/\bTIMESTAMPTZ\b/gi, "TEXT")
  sqliteCompat = sqliteCompat.replace(/\bTIMESTAMP\b/gi, "TEXT")
  sqliteCompat = sqliteCompat.replace(/\bNOW\(\)/gi, "CURRENT_TIMESTAMP")
  sqliteCompat = sqliteCompat.replace(/\bADD COLUMN IF NOT EXISTS\b/gi, "ADD COLUMN")
  sqliteCompat = sqliteCompat.replace(/::(?:jsonb|text)\b/gi, "")

  return sqliteCompat
}
