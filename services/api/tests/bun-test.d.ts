declare module "bun:test" {
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
    toContain(expected: string): void
    toThrow(expected?: string | RegExp): void
    readonly not: {
      toContain(expected: string): void
    }
    readonly rejects: {
      toThrow(expected?: string | RegExp): Promise<void>
    }
  }
}
