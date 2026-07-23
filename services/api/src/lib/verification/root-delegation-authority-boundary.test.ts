import { describe, expect, test } from "bun:test"

describe("root-delegation authority boundary", () => {
  test("verification modules cannot read or write root-delegation tables", async () => {
    const modules: string[] = []
    for await (const fileName of new Bun.Glob("*.ts").scan({
      cwd: import.meta.dir,
      onlyFiles: true,
    })) {
      if (!fileName.endsWith(".test.ts")) {
        modules.push(fileName)
      }
    }
    expect(modules.length).toBeGreaterThan(0)

    for (const fileName of modules) {
      const source = await Bun.file(new URL(fileName, import.meta.url)).text()

      // These modules own session-scoped ownership, attachment, and expiry
      // evidence. Root-delegation freshness has a separate authority. Matching
      // the namespace prefix makes this a ratchet for future root tables too.
      expect(source, fileName).not.toMatch(/\bhns_root_[a-z0-9_]+\b/u)
    }
  })
})
