declare module "bun:test" {
  export const mock: {
    module(path: string, factory: () => Record<string, unknown>): void
  }
  export const test: (name: string, fn: () => unknown | Promise<unknown>) => void
  export const describe: (name: string, fn: () => unknown) => void
  export const beforeEach: (fn: () => unknown | Promise<unknown>) => void
  export const afterEach: (fn: () => unknown | Promise<unknown>) => void
  export function expect<T>(value: T): {
    toBe(expected: unknown): void
    toBeNull(): void
    toEqual(expected: unknown): void
    toMatch(expected: RegExp): void
    toHaveLength(expected: number): void
  }
}
