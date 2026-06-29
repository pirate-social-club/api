import "bun:test"

declare global {
  interface Function {
    // Bun 1.3 adds fetch.preconnect to typeof fetch. Existing tests often assign plain async
    // functions as fetch mocks; keep those mocks structurally assignable under the newer type.
    preconnect(url: string | URL, options?: { dns?: boolean; tcp?: boolean; http?: boolean; https?: boolean }): void
  }
}

declare module "bun:test" {
  interface Matchers<T = unknown> {
    // TODO(#6): Remove after fixing test assertion types to match official Bun signatures.
    toBe(expected: unknown): void
    toEqual(expected: unknown): void
  }
}
