import { mkdirSync, readFileSync, writeFileSync } from "node:fs"
import { dirname, resolve } from "node:path"
import { fileURLToPath } from "node:url"

const scriptDir = dirname(fileURLToPath(import.meta.url))
const skillMdPath = resolve(scriptDir, "..", "docs", "agents", "pirate-agent-protocol", "SKILL.md")
const outDir = resolve(scriptDir, "..", "src", "generated")
const outPath = resolve(outDir, "pirate-agent-protocol-skill.ts")

const markdown = readFileSync(skillMdPath, "utf-8")
const generatedSource = `// GENERATED FILE. Run \`bun run scripts/generate-agent-skill.ts\` to regenerate.
// Source: docs/agents/pirate-agent-protocol/SKILL.md

const skillMarkdown = ${JSON.stringify(markdown)}

export default skillMarkdown
`

if (process.argv.includes("--check")) {
  const currentSource = readFileSync(outPath, "utf-8")
  if (currentSource !== generatedSource) {
    console.error("Generated pirate-agent-protocol skill is stale. Run `bun run generate:agent-skill`.")
    process.exit(1)
  }
  console.log("Generated pirate-agent-protocol skill is current.")
  process.exit(0)
}

mkdirSync(outDir, { recursive: true })
writeFileSync(outPath, generatedSource, "utf-8")

console.log(`Generated ${outPath} (${markdown.length} bytes)`)
