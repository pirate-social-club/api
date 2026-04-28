const SQL_IDENTIFIER_PATTERN = /^[a-z_][a-z0-9_]*$/

export function sqlIdentifier(value: string): string {
  if (!SQL_IDENTIFIER_PATTERN.test(value)) {
    throw new Error(`invalid SQL identifier: ${value}`)
  }
  return value
}
