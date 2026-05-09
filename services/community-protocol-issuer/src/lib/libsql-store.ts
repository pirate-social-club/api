import { createProtocolIssuanceStore, type ProtocolIssuanceSqlClient } from "./protocol-issuance-db.js";
import type { ProtocolIssuanceStore } from "./types.js";

type LibsqlModule = {
  createClient(input: { url: string; authToken?: string }): {
    execute(statement: { sql: string; args?: unknown[] }): Promise<{ rows: Array<Record<string, unknown>> }>;
    transaction(mode: "write"): Promise<{
      execute(statement: { sql: string; args?: unknown[] }): Promise<{ rows: Array<Record<string, unknown>> }>;
      commit(): Promise<void>;
      rollback(): Promise<void>;
      close(): void;
    }>;
    close(): void;
  };
};

export type OpenedProtocolIssuanceStore = {
  store: ProtocolIssuanceStore;
  close(): void;
};

async function loadLibsqlModule(): Promise<LibsqlModule> {
  const moduleName = "@libsql/client";
  return await import(moduleName) as LibsqlModule;
}

export async function openLibsqlProtocolIssuanceStore(input: {
  url: string;
  authToken?: string | null;
}): Promise<OpenedProtocolIssuanceStore> {
  const libsql = await loadLibsqlModule();
  const client = libsql.createClient({
    url: input.url,
    authToken: input.authToken?.trim() || undefined,
  });
  return {
    store: createProtocolIssuanceStore(client as ProtocolIssuanceSqlClient),
    close() {
      client.close();
    },
  };
}
