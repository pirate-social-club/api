declare module "bun:test" {
  interface BunExpectMatchers {
    not: BunExpectMatchers
    rejects: BunExpectMatchers
    resolves: BunExpectMatchers
    [key: string]: ((...args: unknown[]) => unknown) | BunExpectMatchers
    toBe(expected: unknown): void
    toBeDefined(): void
    toBeFalsy(): void
    toBeGreaterThan(expected: number): void
    toBeNull(): void
    toBeTruthy(): void
    toContain(expected: unknown): void
    toEqual(expected: unknown): void
    toHaveLength(expected: number): void
    toMatch(expected: RegExp | string): void
    toMatchObject(expected: unknown): void
    toThrow(expected?: unknown): void
  }

  export const mock: {
    module(path: string, factory: () => Record<string, unknown>): void
    restore(): void
  }
  export const test: (name: string, fn: () => unknown | Promise<unknown>) => void
  export const describe: (name: string, fn: () => unknown) => void
  export const beforeEach: (fn: () => unknown | Promise<unknown>) => void
  export const afterEach: (fn: () => unknown | Promise<unknown>) => void
  export function expect<T>(value: T): BunExpectMatchers
  export namespace expect {
    function any(expected: unknown): unknown
  }
}
