import { describe, expect, test } from "bun:test"
import { readdir, readFile } from "node:fs/promises"
import { relative, resolve } from "node:path"

const SERVICE_ROOT = resolve(import.meta.dir, "..")
const RUNTIME_ROOT = resolve(SERVICE_ROOT, "src")
const PROVENANCE_COLUMN = /\bage_gate_(?:source|evidence_ref|set_at)\b/u
const CAPABILITY_GUARD = /\bhasAgeGateProvenanceColumns\b/u

async function runtimeSourceFiles(directory = RUNTIME_ROOT): Promise<string[]> {
  const files: string[] = []
  for (const entry of await readdir(directory, { withFileTypes: true })) {
    if (entry.name === "generated") continue
    const path = resolve(directory, entry.name)
    if (entry.isDirectory()) {
      files.push(...await runtimeSourceFiles(path))
    } else if (entry.isFile() && /\.tsx?$/u.test(entry.name) && !/\.test\.tsx?$/u.test(entry.name)) {
      files.push(path)
    }
  }
  return files
}

describe("age-gate provenance schema compatibility", () => {
  test("runtime references cannot bypass the 1148 capability guard", async () => {
    const unguarded: string[] = []
    for (const path of await runtimeSourceFiles()) {
      const source = await readFile(path, "utf8")
      if (PROVENANCE_COLUMN.test(source) && !CAPABILITY_GUARD.test(source)) {
        unguarded.push(relative(SERVICE_ROOT, path))
      }
    }

    expect(
      unguarded,
      "Every runtime reference to migration 1148 columns must share the hasAgeGateProvenanceColumns compatibility guard",
    ).toEqual([])
  })
})
