import type { Server } from "node:http"

const DEFAULT_FORCE_EXIT_AFTER_MS = 5_000

type ShutdownServer = Pick<Server, "close" | "closeIdleConnections">

type GracefulHttpShutdownOptions = {
  service: string
  forceExitAfterMs?: number
  exit?: (code: number) => void
  log?: (message: string) => void
  logError?: (message: string) => void
}

export function createGracefulHttpShutdownHandler(
  server: ShutdownServer,
  options: GracefulHttpShutdownOptions,
): (signal: NodeJS.Signals) => void {
  const exit = options.exit ?? ((code: number) => process.exit(code))
  const log = options.log ?? console.log
  const logError = options.logError ?? console.error
  const forceExitAfterMs = options.forceExitAfterMs ?? DEFAULT_FORCE_EXIT_AFTER_MS
  let shuttingDown = false

  return (signal) => {
    if (shuttingDown) return
    shuttingDown = true

    log(`${options.service} received ${signal}; shutting down`)

    const forceExitTimer = setTimeout(() => {
      logError(`${options.service} did not stop within ${forceExitAfterMs}ms; forcing exit`)
      exit(1)
    }, forceExitAfterMs)
    forceExitTimer.unref()

    server.close((error) => {
      clearTimeout(forceExitTimer)
      if (error) {
        logError(`${options.service} shutdown failed: ${error.message}`)
        exit(1)
        return
      }
      log(`${options.service} stopped`)
      exit(0)
    })
    server.closeIdleConnections()
  }
}

export function installGracefulHttpShutdown(
  server: ShutdownServer,
  options: GracefulHttpShutdownOptions,
): void {
  const shutdown = createGracefulHttpShutdownHandler(server, options)
  process.once("SIGTERM", shutdown)
  process.once("SIGINT", shutdown)
}
