declare module "bun:test" {
  export const test: (name: string, fn: () => unknown | Promise<unknown>) => void
  export const describe: (name: string, fn: () => unknown) => void
  export function expect<T>(value: T): {
    toBe(expected: unknown): void
    toEqual(expected: unknown): void
    toThrow(expected?: string | RegExp): void
  }
}
