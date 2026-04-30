import { spawn, type ChildProcess } from "node:child_process"

const TRYCLOUDFLARE_URL_PATTERN = /https:\/\/(?!api\.)[-a-z0-9]+\.trycloudflare\.com/iu

export type ManagedTunnel = {
  process: ChildProcess
  publicOrigin: string
}

export function isTryCloudflareOrigin(value: string | null | undefined): boolean {
  try {
    const url = new URL(String(value || "").trim())
    return url.protocol === "https:" && /(?:^|\.)trycloudflare\.com$/iu.test(url.hostname) && url.hostname !== "api.trycloudflare.com"
  } catch {
    return false
  }
}

export function parseTryCloudflareUrl(value: string): string | null {
  return value.match(TRYCLOUDFLARE_URL_PATTERN)?.[0] ?? null
}

export function mergeCommaSeparatedValues(
  current: string | undefined,
  additions: string[],
): string {
  const values = new Set(
    String(current || "")
      .split(",")
      .map((value) => value.trim())
      .filter(Boolean),
  )
  for (const addition of additions) {
    if (addition.trim()) {
      values.add(addition.trim())
    }
  }
  return Array.from(values).join(",")
}

export async function startTryCloudflareTunnel(input: {
  apiLocalOrigin: string
  command?: string
  timeoutMs?: number
}): Promise<ManagedTunnel | null> {
  const command = input.command || "cloudflared"
  const child = spawn(command, [
    "tunnel",
    "--no-autoupdate",
    "--url",
    input.apiLocalOrigin,
  ], {
    env: process.env,
    stdio: ["ignore", "pipe", "pipe"],
  })

  let settled = false
  let output = ""

  return await new Promise((resolve, reject) => {
    const timeout = setTimeout(() => {
      if (settled) return
      settled = true
      child.kill("SIGTERM")
      reject(new Error(`Timed out waiting for cloudflared public URL after ${input.timeoutMs ?? 30000}ms`))
    }, input.timeoutMs ?? 30000)

    function finish(publicOrigin: string): void {
      if (settled) return
      settled = true
      clearTimeout(timeout)
      resolve({ process: child, publicOrigin })
    }

    function handleChunk(chunk: Buffer, stream: NodeJS.WriteStream): void {
      const text = chunk.toString()
      output += text
      stream.write(text)
      const publicOrigin = parseTryCloudflareUrl(output)
      if (publicOrigin) {
        finish(publicOrigin)
      }
    }

    child.once("error", (error) => {
      if (settled) return
      settled = true
      clearTimeout(timeout)
      if ("code" in error && error.code === "ENOENT") {
        resolve(null)
        return
      }
      reject(error)
    })

    child.once("exit", (code, signal) => {
      if (settled) return
      settled = true
      clearTimeout(timeout)
      reject(new Error(`cloudflared exited before publishing a URL (${signal ?? code ?? "unknown"})`))
    })

    child.stdout?.on("data", (chunk: Buffer) => handleChunk(chunk, process.stdout))
    child.stderr?.on("data", (chunk: Buffer) => handleChunk(chunk, process.stderr))
  })
}
