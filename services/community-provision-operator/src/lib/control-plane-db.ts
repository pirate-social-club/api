import { createClient } from "@libsql/client";
import type { Client as LibsqlClient, Transaction as LibsqlTransaction, InArgs } from "@libsql/core/api";
import { Pool, neonConfig } from "@neondatabase/serverless";
import type { ControlPlaneDatabase, ControlPlaneQueryable } from "./types";

type PostgresQueryable = {
  query: (sql: string, values?: unknown[]) => Promise<{ rows: unknown[]; rowCount?: number | null }>;
};

const defaultNeonFetchEndpoint = neonConfig.fetchEndpoint;
const defaultNeonWsProxy = neonConfig.wsProxy;
const defaultNeonPipelineConnect = neonConfig.pipelineConnect;

neonConfig.poolQueryViaFetch = true;

// PlanetScale Postgres (*.pg.psdb.cloud) speaks the Neon HTTP/WS protocol but at
// its own endpoints, and sends `sslrootcert=system` which the bundled pg driver
// would try to fs.readFileSync() (fails in Workers). Rewire the endpoints and
// strip the cert param so the control-plane connection works in production.
function isPlanetScalePostgresUrl(value: string): boolean {
  try {
    const url = new URL(value);
    return url.hostname.toLowerCase().endsWith(".pg.psdb.cloud");
  } catch {
    return false;
  }
}

function configurePostgresDriverForUrl(url: string): void {
  neonConfig.poolQueryViaFetch = true;

  if (!isPlanetScalePostgresUrl(url)) {
    neonConfig.fetchEndpoint = defaultNeonFetchEndpoint;
    neonConfig.wsProxy = defaultNeonWsProxy;
    neonConfig.pipelineConnect = defaultNeonPipelineConnect;
    return;
  }

  neonConfig.fetchEndpoint = (host) => `https://${host}/sql`;
  neonConfig.wsProxy = (host, port) => `${host}/v2?address=${host}:${port}`;
  neonConfig.pipelineConnect = false;
}

function normalizePostgresConnectionStringForDriver(value: string): string {
  if (!isPlanetScalePostgresUrl(value)) {
    return value;
  }

  const url = new URL(value);
  if (url.searchParams.get("sslrootcert") === "system") {
    url.searchParams.delete("sslrootcert");
  }
  return url.toString();
}

function normalizeSqlArg(value: unknown): unknown {
  if (value === undefined) {
    return null;
  }
  if (typeof value === "boolean") {
    return value ? 1 : 0;
  }
  if (value instanceof Date) {
    return value.toISOString();
  }
  return value;
}

function compileTaggedStatement(
  strings: TemplateStringsArray,
  values: unknown[],
): { sql: string; args: InArgs } {
  let sql = "";
  const args: unknown[] = [];

  for (let index = 0; index < strings.length; index += 1) {
    sql += strings[index];
    if (index < values.length) {
      sql += "?";
      args.push(normalizeSqlArg(values[index]));
    }
  }

  return { sql, args: args as InArgs };
}

function compilePostgresStatement(
  strings: TemplateStringsArray,
  values: unknown[],
): { sql: string; args: unknown[] } {
  let sql = "";
  const args: unknown[] = [];

  for (let index = 0; index < strings.length; index += 1) {
    sql += strings[index];
    if (index < values.length) {
      args.push(normalizeSqlArg(values[index]));
      sql += `$${args.length}`;
    }
  }

  return { sql, args };
}

function createLibsqlQueryable(
  executor: Pick<LibsqlClient, "execute"> | Pick<LibsqlTransaction, "execute">,
): ControlPlaneQueryable {
  return {
    sql: async <T = unknown[]>(strings: TemplateStringsArray, ...values: unknown[]): Promise<T> => {
      const statement = compileTaggedStatement(strings, values);
      const result = await executor.execute(statement);
      return result.rows as T;
    },
  };
}

function normalizePostgresRowValue(value: unknown): unknown {
  if (value instanceof Date) {
    return value.toISOString();
  }
  return value;
}

function normalizePostgresRows(rows: unknown[]): unknown[] {
  return rows.map((row) => {
    if (!row || typeof row !== "object") {
      return {};
    }
    return Object.fromEntries(
      Object.entries(row as Record<string, unknown>)
        .map(([key, value]) => [key, normalizePostgresRowValue(value)]),
    );
  });
}

function createPostgresQueryable(executor: PostgresQueryable): ControlPlaneQueryable {
  return {
    sql: async <T = unknown[]>(strings: TemplateStringsArray, ...values: unknown[]): Promise<T> => {
      const statement = compilePostgresStatement(strings, values);
      const result = await executor.query(statement.sql, statement.args);
      return normalizePostgresRows(result.rows) as T;
    },
  };
}

function isPostgresControlPlaneUrl(url: string): boolean {
  const normalized = url.trim().toLowerCase();
  return normalized.startsWith("postgres://") || normalized.startsWith("postgresql://");
}

function openPostgresControlPlaneDatabase(url: string): ControlPlaneDatabase {
  configurePostgresDriverForUrl(url);
  const pool = new Pool({ connectionString: normalizePostgresConnectionStringForDriver(url), max: 4 });

  return {
    ...createPostgresQueryable(pool),
    begin: async <T>(callback: (tx: ControlPlaneQueryable) => Promise<T>): Promise<T> => {
      const client = await pool.connect();
      try {
        await client.query("BEGIN");
        const result = await callback(createPostgresQueryable(client));
        await client.query("COMMIT");
        return result;
      } catch (error) {
        try {
          await client.query("ROLLBACK");
        } catch {}
        throw error;
      } finally {
        client.release();
      }
    },
    close: async (): Promise<void> => {
      await pool.end();
    },
  };
}

export function openControlPlaneDatabase(input: {
  url: string;
  authToken?: string | null;
}): ControlPlaneDatabase {
  if (isPostgresControlPlaneUrl(input.url)) {
    return openPostgresControlPlaneDatabase(input.url);
  }

  const client = createClient({
    url: input.url,
    authToken: input.authToken?.trim() || undefined,
  });

  return {
    ...createLibsqlQueryable(client),
    begin: async <T>(callback: (tx: ControlPlaneQueryable) => Promise<T>): Promise<T> => {
      const tx = await client.transaction("write");
      try {
        const result = await callback(createLibsqlQueryable(tx));
        await tx.commit();
        return result;
      } catch (error) {
        try {
          await tx.rollback();
        } catch {}
        throw error;
      } finally {
        tx.close();
      }
    },
    close: async (): Promise<void> => {
      client.close();
    },
  };
}
