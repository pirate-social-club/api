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
})
