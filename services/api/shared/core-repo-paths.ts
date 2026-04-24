import { existsSync } from "node:fs"
import { resolve } from "node:path"

function candidateHasCoreDb(root: string): boolean {
  return existsSync(resolve(root, "db/control-plane/migrations"))
}

export function resolveCoreRepoRoot(input?: {
  serviceRoot?: string
  override?: string | null | undefined
}): string {
  const serviceRoot = input?.serviceRoot ?? process.cwd()
  const workspaceRoot = resolve(serviceRoot, "../../..")
  const candidates = [
    input?.override?.trim(),
    process.env.PIRATE_CORE_REPO?.trim(),
    workspaceRoot,
    resolve(serviceRoot, "../core"),
    resolve(serviceRoot, "../../core"),
    resolve(serviceRoot, "../../../core"),
    resolve(workspaceRoot, "core"),
    resolve(workspaceRoot, "../core"),
  ].filter((value): value is string => Boolean(value))

  for (const candidate of new Set(candidates)) {
    if (candidateHasCoreDb(candidate)) {
      return candidate
    }
  }

  throw new Error("could not locate Pirate core repo; set PIRATE_CORE_REPO to the core checkout")
}

export function resolveCoreRepoPath(relativePath: string, input?: {
  serviceRoot?: string
  override?: string | null | undefined
}): string {
  return resolve(resolveCoreRepoRoot(input), relativePath)
}
