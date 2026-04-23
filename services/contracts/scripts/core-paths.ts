import { existsSync } from "node:fs"
import { resolve } from "node:path"

export function resolveCoreRepoRoot(repoRoot: string): string {
  const candidates = [
    process.env.PIRATE_CORE_REPO?.trim(),
    resolve(repoRoot, "../../pirate-v2"),
    resolve(repoRoot, "../pirate-v2"),
  ].filter((value): value is string => Boolean(value))

  for (const candidate of new Set(candidates)) {
    if (existsSync(resolve(candidate, "specs/api/scripts/generate-api-contracts.ts"))) {
      return candidate
    }
  }

  throw new Error("Could not locate Pirate core repo. Set PIRATE_CORE_REPO.")
}
