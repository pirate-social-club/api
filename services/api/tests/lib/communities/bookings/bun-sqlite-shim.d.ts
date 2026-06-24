// bun:sqlite types are not in this project's tsconfig `types` (only bun-types/test). Ambient shim
// for the minimal synchronous surface the operator-signing-coordinator DO test uses.
declare module "bun:sqlite" {
  export class Database {
    constructor(path: string)
    query(sql: string): { all: (...args: unknown[]) => unknown[]; run: (...args: unknown[]) => void }
    transaction<T>(cb: () => T): () => T
  }
}
