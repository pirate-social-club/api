import { spawn } from "node:child_process"
import { mkdtemp, rm, writeFile } from "node:fs/promises"
import { tmpdir } from "node:os"
import { join } from "node:path"

function readArg(name: string): string | null {
  const args = process.argv.slice(2)
  const index = args.indexOf(name)
  return index === -1 ? null : args[index + 1] ?? null
}

function requiredArg(name: string): string {
  const value = readArg(name)?.trim()
  if (!value) throw new Error(`${name} is required`)
  return value
}

function usage(): string {
  return `Usage:
  bun scripts/smoke-guest-comment-script.ts --origin https://api-staging.pirate.sc --community com_... --post post_...

Options:
  --origin <origin>     Pirate API origin. Defaults to https://api-staging.pirate.sc.
  --community <id>      Community id or identifier accepted by the hosted script.
  --post <post_id>      Public post id to comment on.
  --guest <id>          Stable guest id. Generated when omitted.
  --body <text>         Comment body. Generated when omitted.
`
}

async function downloadText(url: string): Promise<string> {
  const response = await fetch(url)
  const text = await response.text()
  if (!response.ok) {
    throw new Error(`GET ${url} failed with HTTP ${response.status}: ${text}`)
  }
  return text
}

async function runNode(args: string[]): Promise<{ stdout: string; stderr: string; exitCode: number }> {
  return await new Promise((resolve, reject) => {
    const proc = spawn("node", args, {
      stdio: ["ignore", "pipe", "pipe"],
    })
    const stdoutChunks: Buffer[] = []
    const stderrChunks: Buffer[] = []
    proc.stdout.on("data", (chunk) => stdoutChunks.push(Buffer.from(chunk)))
    proc.stderr.on("data", (chunk) => stderrChunks.push(Buffer.from(chunk)))
    proc.on("error", reject)
    proc.on("close", (code) => {
      resolve({
        stdout: Buffer.concat(stdoutChunks).toString("utf8"),
        stderr: Buffer.concat(stderrChunks).toString("utf8"),
        exitCode: code ?? 1,
      })
    })
  })
}

async function main(): Promise<void> {
  if (process.argv.includes("--help") || process.argv.includes("-h")) {
    console.log(usage())
    return
  }
  const origin = (readArg("--origin") ?? "https://api-staging.pirate.sc").replace(/\/+$/, "")
  const communityId = requiredArg("--community")
  const postId = requiredArg("--post")
  const guestId = readArg("--guest") ?? `codex-script-smoke-${Date.now()}`
  const body = readArg("--body") ?? `Live guest-comment.mjs smoke ${new Date().toISOString()}`
  const cacheBust = encodeURIComponent(`smoke-${Date.now()}`)
  const toolUrl = `${origin}/.well-known/agent-tools/guest-comment.mjs?${cacheBust}`
  const tempDir = await mkdtemp(join(tmpdir(), "pirate-guest-comment-script-smoke-"))
  const scriptPath = join(tempDir, "guest-comment.mjs")

  try {
    const script = await downloadText(toolUrl)
    if (!script.includes("pbkdf2Sync")) {
      throw new Error("served guest-comment.mjs does not contain pbkdf2Sync")
    }
    await writeFile(scriptPath, script)

    const help = await runNode([scriptPath, "--help"])
    if (help.exitCode !== 0 || !help.stdout.includes("Usage:")) {
      throw new Error(`--help failed: exit=${help.exitCode} stdout=${help.stdout} stderr=${help.stderr}`)
    }

    const version = await runNode([scriptPath, "--version"])
    if (version.exitCode !== 0 || !version.stdout.trim().startsWith("pirate-guest-comment ")) {
      throw new Error(`--version failed: exit=${version.exitCode} stdout=${version.stdout} stderr=${version.stderr}`)
    }

    const idempotencyKey = `live-guest-comment-script-smoke-${Date.now()}`
    const startedAt = performance.now()
    const reply = await runNode([
      scriptPath,
      "--api",
      origin,
      "--community",
      communityId,
      "--post",
      postId,
      "--body",
      body,
      "--guest",
      guestId,
      "--idempotency-key",
      idempotencyKey,
      "--json",
    ])
    const elapsedMs = Math.round(performance.now() - startedAt)
    if (reply.exitCode !== 0) {
      throw new Error(`guest-comment.mjs failed: exit=${reply.exitCode} stdout=${reply.stdout} stderr=${reply.stderr}`)
    }

    const parsed = JSON.parse(reply.stdout) as {
      ok?: boolean
      comment?: { id?: string; status?: string | null; anonymous_label?: string | null }
    }
    if (parsed.ok !== true || !parsed.comment?.id) {
      throw new Error(`guest-comment.mjs did not return a successful comment: ${reply.stdout}`)
    }

    console.log(JSON.stringify({
      ok: true,
      origin,
      community: communityId,
      post: postId,
      guest_id: guestId,
      idempotency_key: idempotencyKey,
      comment: parsed.comment.id,
      status: parsed.comment.status ?? null,
      anonymous_label: parsed.comment.anonymous_label ?? null,
      elapsed_ms: elapsedMs,
      script_version: version.stdout.trim(),
    }, null, 2))
  } finally {
    await rm(tempDir, { recursive: true, force: true })
  }
}

main().catch((error) => {
  console.error(error)
  process.exit(1)
})
