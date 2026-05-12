import "bun:test"

declare module "bun:test" {
  interface Matchers<T = unknown> {
    // TODO(#6): Remove after fixing test assertion types to match official Bun signatures.
    toBe(expected: unknown): void
    toEqual(expected: unknown): void
  }
}
