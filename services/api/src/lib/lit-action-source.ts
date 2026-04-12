import { existsSync, readFileSync } from "node:fs"

function candidateUrls(relativePath: string): URL[] {
  return [
    new URL(`../../../../lit-actions/${relativePath}`, import.meta.url),
    new URL(`../../../../../lit-actions/${relativePath}`, import.meta.url),
  ]
}

export function readLocalLitActionSource(relativePath: string): string {
  for (const url of candidateUrls(relativePath)) {
    if (existsSync(url)) {
      return readFileSync(url, "utf8")
    }
  }
  throw new Error(`lit_action_local_source_missing:${relativePath}`)
}
