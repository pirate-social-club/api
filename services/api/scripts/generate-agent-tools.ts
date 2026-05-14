import { mkdir, readFile, writeFile } from "node:fs/promises"
import { dirname, resolve } from "node:path"

function asTsString(value: string): string {
  return JSON.stringify(value)
}

async function main(): Promise<void> {
  const inputPath = resolve("scripts/agent-tools/guest-comment.mjs")
  const outputPath = resolve("src/generated/agent-tools/guest-comment.ts")
  const script = await readFile(inputPath, "utf8")
  await mkdir(dirname(outputPath), { recursive: true })
  await writeFile(outputPath, `const guestCommentTool = ${asTsString(script)}\n\nexport default guestCommentTool\n`)
  console.log(`Generated ${outputPath}`)
}

main().catch((error) => {
  console.error(error)
  process.exit(1)
})
