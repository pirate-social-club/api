declare module "bun:test" {
  export const test: (name: string, fn: () => unknown | Promise<unknown>) => void
  export const describe: (name: string, fn: () => unknown) => void
  export const beforeEach: (fn: () => unknown | Promise<unknown>) => void
  export const afterEach: (fn: () => unknown | Promise<unknown>) => void
  export function expect<T>(value: T): {
    toBe(expected: unknown): void
    toBeDefined(): void
    toBeTruthy(): void
    toBeNull(): void
    toBeUndefined(): void
    toEqual(expected: unknown): void
    toMatch(expected: RegExp): void
    toMatchObject(expected: unknown): void
    toHaveLength(expected: number): void
    toContain(expected: string): void
    toContainEqual(expected: unknown): void
    toBeGreaterThan(expected: unknown): void
    toThrow(expected?: string | RegExp): void
    readonly not: {
      toBe(expected: unknown): void
      toBeNull(): void
      toContain(expected: string): void
      toEqual(expected: unknown): void
      toThrow(expected?: string | RegExp): void
    }
    readonly rejects: {
      toThrow(expected?: string | RegExp): Promise<void>
    }
  }
  export namespace expect {
    export function objectContaining<T extends object>(value: T): T
  }
}
