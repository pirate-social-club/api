import { getFlag } from "./args.js"
import { readSeedAccounts } from "./config.js"
import type { ParsedArgs } from "./types.js"

export function resolveSeedActorUserId(args: ParsedArgs): string | null {
  const explicitUserId = getFlag(args, "as-user-id")
  if (explicitUserId) {
    return explicitUserId
  }
  const alias = getFlag(args, "as")
  if (!alias) {
    return null
  }
  const accountsFile = getFlag(args, "accounts-file") ?? undefined
  const accounts = readSeedAccounts(accountsFile)
  const resolved = accounts[alias]
  if (!resolved) {
    throw new Error(`Unknown seed account alias ${alias}`)
  }
  return resolved
}
