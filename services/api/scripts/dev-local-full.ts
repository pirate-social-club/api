import { spawn, type ChildProcess } from "node:child_process"
import { existsSync } from "node:fs"
import { connect } from "node:net"
import { fileURLToPath } from "node:url"
import { readDevVarsFromCwd } from "./_lib/dev-vars"
import { mergeCommaSeparatedValues, startTryCloudflareTunnel, type ManagedTunnel } from "./_lib/dev-public-tunnel"

type ManagedChild = {
  name: string
  process: ChildProcess
}

function envFlag(value: string | undefined, defaultValue: boolean): boolean {
  if (value == null || value.trim() === "") return defaultValue
  const normalized = value.trim().toLowerCase()
  return normalized === "1" || normalized === "true" || normalized === "yes" || normalized === "on"
}

function spawnManagedChild(
  name: string,
  args: string[],
  input: {
    cwd?: string
    env?: NodeJS.ProcessEnv
  } = {},
): ManagedChild {
  const child = spawn(
    process.execPath,
    args,
    {
      cwd: input.cwd ?? process.cwd(),
      env: input.env ?? process.env,
      stdio: "inherit",
    },
  )

  return {
    name,
    process: child,
  }
}

function apiLocalOrigin(): string {
  const port = Number(process.env.PORT || "8787")
  return `http://127.0.0.1:${Number.isInteger(port) && port > 0 ? port : 8787}`
}

function webRootPath(): string {
  return fileURLToPath(new URL("../../../../web", import.meta.url))
}

function assistantWorkerRootPath(): string {
  return fileURLToPath(new URL("../../../../assistant-worker", import.meta.url))
}

async function isTcpPortOpen(port: number, host = "127.0.0.1"): Promise<boolean> {
  return await new Promise((resolve) => {
    const socket = connect({ host, port })
    socket.once("connect", () => {
      socket.end()
      resolve(true)
    })
    socket.once("error", () => {
      socket.destroy()
      resolve(false)
    })
  })
}

async function findAvailableTcpPort(startPort: number, host = "127.0.0.1"): Promise<number> {
  for (let port = startPort; port < startPort + 100; port += 1) {
    if (!await isTcpPortOpen(port, host)) return port
  }
  throw new Error(`could not find an available TCP port starting at ${startPort}`)
}

async function startPublicTunnel(localOrigin: string): Promise<ManagedTunnel | null> {
  const mode = String(process.env.PIRATE_DEV_TUNNEL || "off").trim().toLowerCase()
  if (mode === "0" || mode === "false" || mode === "off" || mode === "none") {
    return null
  }

  const tunnel = await startTryCloudflareTunnel({
    apiLocalOrigin: localOrigin,
    command: process.env.CLOUDFLARED_BIN || "cloudflared",
  }).catch((error: unknown) => {
    if (mode === "required") {
      const message = error instanceof Error ? error.message : String(error)
      throw new Error(
        `cloudflared tunnel is required but could not start: ${message}. `
        + "Run without PIRATE_DEV_TUNNEL=required for local-only development, or fix cloudflared/certificate trust.",
      )
    }
    const message = error instanceof Error ? error.message : String(error)
    console.warn(`warning: cloudflared tunnel unavailable; continuing locally (${message})`)
    return null
  })
  if (!tunnel && mode === "required") {
    throw new Error("cloudflared is required but was not found. Install cloudflared or set PIRATE_DEV_TUNNEL=off.")
  }
  if (!tunnel) {
    console.warn("warning: cloudflared was not found; Self callbacks will require a valid PIRATE_API_PUBLIC_ORIGIN")
  }
  return tunnel
}

function isPublicTunnelDisabled(): boolean {
  const mode = String(process.env.PIRATE_DEV_TUNNEL || "off").trim().toLowerCase()
  return mode === "0" || mode === "false" || mode === "off" || mode === "none"
}

function localNoProxy(): string {
  return mergeCommaSeparatedValues(
    process.env.NO_PROXY ?? process.env.no_proxy,
    [
      "127.0.0.1",
      "localhost",
      "::1",
    ],
  )
}

async function waitForExit(child: ChildProcess): Promise<number> {
  return await new Promise((resolve, reject) => {
    child.once("error", reject)
    child.once("exit", (code, signal) => {
      if (typeof code === "number") {
        resolve(code)
        return
      }
      resolve(signal ? 1 : 0)
    })
  })
}

async function stopChildren(children: ManagedChild[], signal: NodeJS.Signals = "SIGTERM"): Promise<void> {
  for (const child of children) {
    if (child.process.exitCode === null && !child.process.killed) {
      child.process.kill(signal)
    }
  }

  await Promise.all(children.map(async (child) => {
    try {
      await waitForExit(child.process)
    } catch {
      // Ignore shutdown races while draining child exits.
    }
  }))
}

async function main(): Promise<void> {
  const devVars = readDevVarsFromCwd()
  const useRemoteVerifiers = envFlag(process.env.PIRATE_DEV_USE_REMOTE_VERIFIERS, false)
  const spacesVerifierBaseUrl = useRemoteVerifiers
    ? process.env.SPACES_VERIFIER_BASE_URL || devVars.SPACES_VERIFIER_BASE_URL || "http://127.0.0.1:8799"
    : "http://127.0.0.1:8799"
  const hnsVerifierBaseUrl = useRemoteVerifiers
    ? process.env.HNS_VERIFIER_BASE_URL || devVars.HNS_VERIFIER_BASE_URL || "http://127.0.0.1:8798"
    : "http://127.0.0.1:8798"
  const localApiOrigin = apiLocalOrigin()
  const tunnel = await startPublicTunnel(localApiOrigin)
  const publicApiOrigin = isPublicTunnelDisabled()
    ? localApiOrigin
    : tunnel?.publicOrigin || process.env.PIRATE_API_PUBLIC_ORIGIN || devVars.PIRATE_API_PUBLIC_ORIGIN
  if (!tunnel && publicApiOrigin?.includes(".trycloudflare.com")) {
    console.warn(`warning: using configured trycloudflare origin without a managed tunnel: ${publicApiOrigin}`)
    console.warn("warning: if Self callbacks fail, install cloudflared or set PIRATE_DEV_TUNNEL=required to fail fast")
  }
  const corsAllowedOrigins = mergeCommaSeparatedValues(
    process.env.CORS_ALLOWED_ORIGINS ?? devVars.CORS_ALLOWED_ORIGINS,
    [
      "http://localhost:5173",
      "http://127.0.0.1:5173",
    ],
  )
  const localEnv = {
    ...process.env,
    SPACES_VERIFIER_BASE_URL: spacesVerifierBaseUrl,
    SPACES_VERIFIER_AUTH_TOKEN: useRemoteVerifiers ? process.env.SPACES_VERIFIER_AUTH_TOKEN || devVars.SPACES_VERIFIER_AUTH_TOKEN || "" : "",
    HNS_VERIFIER_BASE_URL: hnsVerifierBaseUrl,
    HNS_VERIFIER_AUTH_TOKEN: useRemoteVerifiers ? process.env.HNS_VERIFIER_AUTH_TOKEN || devVars.HNS_VERIFIER_AUTH_TOKEN || "" : "",
    NO_PROXY: localNoProxy(),
    no_proxy: localNoProxy(),
    ...(publicApiOrigin ? { PIRATE_API_PUBLIC_ORIGIN: publicApiOrigin } : {}),
    CORS_ALLOWED_ORIGINS: corsAllowedOrigins,
  }
  const webEnv = {
    ...process.env,
    ...(publicApiOrigin ? { VITE_PIRATE_API_BASE_URL: publicApiOrigin } : {}),
  }
  const shouldStartWeb = envFlag(process.env.PIRATE_DEV_START_WEB, true)
  const shouldStartAssistant = envFlag(process.env.PIRATE_DEV_START_ASSISTANT, true)
  const webPort = 5173
  const assistantPort = 8791
  const assistantInspectorPort = await findAvailableTcpPort(Number(process.env.PIRATE_DEV_ASSISTANT_INSPECTOR_PORT || "9239"))
  const openRouterProxyPort = Number(process.env.PIRATE_DEV_OPENROUTER_PROXY_PORT || "8792")
  const openRouterProxyOrigin = `http://127.0.0.1:${Number.isInteger(openRouterProxyPort) && openRouterProxyPort > 0 ? openRouterProxyPort : 8792}`
  const webPortInUse = shouldStartWeb ? await isTcpPortOpen(webPort) : false
  const assistantPortInUse = shouldStartAssistant ? await isTcpPortOpen(assistantPort) : false
  const openRouterProxyPortInUse = shouldStartAssistant ? await isTcpPortOpen(openRouterProxyPort) : false
  const resolvedWebRoot = webRootPath()
  const resolvedAssistantWorkerRoot = assistantWorkerRootPath()
  const assistantEnv = {
    ...localEnv,
    OPENROUTER_BASE_URL: `${openRouterProxyOrigin}/api/v1`,
    PIRATE_API_BASE_URL: localApiOrigin,
  }
  if (webPortInUse) {
    console.warn(`warning: web port ${webPort} is already in use; not starting web dev server`)
    if (publicApiOrigin) {
      console.warn(`warning: restart web with VITE_PIRATE_API_BASE_URL=${publicApiOrigin} if the existing server was started before this tunnel`)
    }
  }
  if (assistantPortInUse) {
    console.warn(`warning: assistant worker port ${assistantPort} is already in use; not starting assistant worker`)
  }
  if (openRouterProxyPortInUse) {
    console.warn(`warning: OpenRouter proxy port ${openRouterProxyPort} is already in use; not starting local OpenRouter proxy`)
  }
  const children = [
    ...(tunnel ? [{ name: "cloudflared", process: tunnel.process }] : []),
    ...(useRemoteVerifiers
      ? []
      : [spawnManagedChild("spaces-verifier", ["run", "scripts/serve-local-spaces-verifier.ts"], { env: localEnv })]),
    ...(useRemoteVerifiers
      ? []
      : [spawnManagedChild("hns-verifier", ["run", "scripts/serve-local-hns-verifier.ts"], { env: localEnv })]),
    spawnManagedChild("api", ["run", "scripts/serve-local.ts"], { env: localEnv }),
    ...(shouldStartAssistant && !openRouterProxyPortInUse
      ? [spawnManagedChild("openrouter-proxy", ["run", "scripts/serve-local-openrouter-proxy.ts"], { env: localEnv })]
      : []),
    ...(shouldStartAssistant && !assistantPortInUse && existsSync(resolvedAssistantWorkerRoot)
      ? [spawnManagedChild("assistant-worker", [
        "run",
        "dev",
        "--",
        "--inspector-port",
        String(assistantInspectorPort),
        "--var",
        `OPENROUTER_BASE_URL:${openRouterProxyOrigin}/api/v1`,
      ], { cwd: resolvedAssistantWorkerRoot, env: assistantEnv })]
      : []),
    spawnManagedChild("community-job-worker", ["run", "scripts/run-community-job-worker.ts"], { env: localEnv }),
    ...(shouldStartWeb && !webPortInUse && existsSync(resolvedWebRoot)
      ? [spawnManagedChild("web", ["run", "dev"], { cwd: resolvedWebRoot, env: webEnv })]
      : []),
  ]

  if (publicApiOrigin) {
    console.log(`dev public API origin: ${publicApiOrigin}`)
  }
  console.log(`HNS verifier: ${hnsVerifierBaseUrl}`)
  console.log(`Spaces verifier: ${spacesVerifierBaseUrl}`)
  if (shouldStartWeb && publicApiOrigin) {
    console.log(`web dev VITE_PIRATE_API_BASE_URL: ${publicApiOrigin}`)
  }

  let shuttingDown = false

  const shutdown = async (signal: NodeJS.Signals, exitCode: number): Promise<never> => {
    if (!shuttingDown) {
      shuttingDown = true
      console.log(`dev:local:full shutting down (${signal})`)
      await stopChildren(children, signal)
    }
    process.exit(exitCode)
  }

  for (const signal of ["SIGINT", "SIGTERM"] as const) {
    process.once(signal, () => {
      void shutdown(signal, 0)
    })
  }

  const firstExit = await Promise.race(children.map(async (child) => ({
    name: child.name,
    code: await waitForExit(child.process),
  })))

  if (!shuttingDown) {
    shuttingDown = true
    console.error(`dev:local:full child exited: ${firstExit.name} (code ${firstExit.code})`)
    await stopChildren(children)
  }

  process.exit(firstExit.code)
}

await main()
