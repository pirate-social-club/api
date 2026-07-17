import { describe, expect, test } from "bun:test"
import { createGracefulHttpShutdownHandler } from "./graceful-http-shutdown"

function fakeServer(closeError?: Error) {
  let closeCalls = 0
  let closeIdleConnectionsCalls = 0
  return {
    server: {
      close(callback?: (error?: Error) => void) {
        closeCalls += 1
        callback?.(closeError)
        return this
      },
      closeIdleConnections() {
        closeIdleConnectionsCalls += 1
      },
    },
    calls: () => ({ closeCalls, closeIdleConnectionsCalls }),
  }
}

describe("graceful HTTP shutdown", () => {
  test("closes the server and exits successfully", () => {
    const { server, calls } = fakeServer()
    const exitCodes: number[] = []
    const shutdown = createGracefulHttpShutdownHandler(server, {
      service: "test service",
      exit: (code) => exitCodes.push(code),
      log: () => {},
      logError: () => {},
    })

    shutdown("SIGTERM")

    expect(calls()).toEqual({ closeCalls: 1, closeIdleConnectionsCalls: 1 })
    expect(exitCodes).toEqual([0])
  })

  test("exits unsuccessfully when server shutdown fails", () => {
    const { server } = fakeServer(new Error("close failed"))
    const exitCodes: number[] = []
    const shutdown = createGracefulHttpShutdownHandler(server, {
      service: "test service",
      exit: (code) => exitCodes.push(code),
      log: () => {},
      logError: () => {},
    })

    shutdown("SIGTERM")

    expect(exitCodes).toEqual([1])
  })

  test("ignores duplicate shutdown signals", () => {
    const { server, calls } = fakeServer()
    const exitCodes: number[] = []
    const shutdown = createGracefulHttpShutdownHandler(server, {
      service: "test service",
      exit: (code) => exitCodes.push(code),
      log: () => {},
      logError: () => {},
    })

    shutdown("SIGTERM")
    shutdown("SIGINT")

    expect(calls().closeCalls).toBe(1)
    expect(exitCodes).toEqual([0])
  })

  test("force-exits when the server never finishes closing", async () => {
    let closeCalls = 0
    let closeIdleConnectionsCalls = 0
    const exitCodes: number[] = []
    const errors: string[] = []
    const server = {
      close() {
        closeCalls += 1
        return this
      },
      closeIdleConnections() {
        closeIdleConnectionsCalls += 1
      },
    }
    const shutdown = createGracefulHttpShutdownHandler(server, {
      service: "test service",
      forceExitAfterMs: 10,
      exit: (code) => exitCodes.push(code),
      log: () => {},
      logError: (message) => errors.push(message),
    })

    shutdown("SIGTERM")
    await Bun.sleep(25)

    expect(closeCalls).toBe(1)
    expect(closeIdleConnectionsCalls).toBe(1)
    expect(exitCodes).toEqual([1])
    expect(errors).toEqual(["test service did not stop within 10ms; forcing exit"])
  })
})
