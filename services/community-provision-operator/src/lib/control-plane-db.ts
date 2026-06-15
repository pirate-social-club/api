import { createClient } from "@libsql/client";
import type { Client as LibsqlClient, Transaction as LibsqlTransaction, InArgs } from "@libsql/core/api";
import { Pool } from "@neondatabase/serverless";
import { configurePostgresDriverForUrl, normalizePostgresConnectionStringForDriver } from "@pirate/api-shared";
import type { ControlPlaneDatabase, ControlPlaneQueryable } from "./types";

type PostgresQueryable = {
  query: (sql: string, values?: unknown[]) => Promise<{ rows: unknown[]; rowCount?: number | null }>;
};

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

const LOCAL_CONTROL_PLANE_ENVIRONMENTS = new Set(["development", "test"]);

const REMOTE_CONTROL_PLANE_SCHEMES = new Set([
  "libsql:",
  "https:",
  "http:",
  "wss:",
  "ws:",
  "postgres:",
  "postgresql:",
]);

export class ControlPlaneUrlError extends Error {
  readonly code = "control_plane_url_invalid";
  constructor(message: string) {
    super(message);
    this.name = "ControlPlaneUrlError";
  }
}

function parseUrlScheme(url: string): string | null {
  const match = /^([a-z][a-z0-9+.-]*:)/i.exec(url.trim());
  return match ? match[1].toLowerCase() : null;
}

/**
 * Rejects a control-plane URL the Cloudflare Workers runtime cannot use.
 *
 * `@libsql/client` resolves `file:`/path URLs through `fs.readFileSync`, which
 * does not exist in the Workers runtime. A misconfigured
 * `CONTROL_PLANE_DATABASE_URL` therefore *constructs* fine and only blows up at
 * the first query (`Ir.readFileSync is not a function`) — deep inside
 * provisioning at `load_next_rotation`, long after irreversible Turso resources
 * have been created. This converts that late, cryptic failure into an explicit,
 * actionable error at the request boundary.
 *
 * Local file URLs are allowed in `development`/`test`, where the runtime is
 * Node/Bun and local SQLite is the intended control plane for tests. The scheme
 * is intentionally only echoed (never the full URL) so credentials/tokens in
 * the connection string cannot leak into error messages or logs.
 */
export function assertRemoteControlPlaneUrl(
  url: string,
  options: { environment?: string | null } = {},
): void {
  const environment = (options.environment ?? "").trim().toLowerCase();
  if (LOCAL_CONTROL_PLANE_ENVIRONMENTS.has(environment)) {
    return;
  }

  const trimmed = url.trim();
  if (!trimmed) {
    throw new ControlPlaneUrlError(
      "CONTROL_PLANE_DATABASE_URL is empty; a remote control-plane URL is required.",
    );
  }

  const scheme = parseUrlScheme(trimmed);
  if (!scheme) {
    throw new ControlPlaneUrlError(
      "CONTROL_PLANE_DATABASE_URL has no URL scheme; the Workers runtime requires a remote " +
        "libsql://, https://, or postgres:// URL (a bare path is read as a local file and fails in production).",
    );
  }

  if (scheme === "file:") {
    throw new ControlPlaneUrlError(
      `CONTROL_PLANE_DATABASE_URL uses the "file:" scheme for environment "${environment || "production"}"; ` +
        "the Workers runtime has no filesystem. Point it at a remote libsql://, https://, or postgres:// control plane.",
    );
  }

  if (!REMOTE_CONTROL_PLANE_SCHEMES.has(scheme)) {
    throw new ControlPlaneUrlError(
      `CONTROL_PLANE_DATABASE_URL uses unsupported scheme "${scheme}"; ` +
        "expected one of libsql://, https://, http://, wss://, ws://, postgres://, postgresql://.",
    );
  }
}

function openPostgresControlPlaneDatabase(url: string): ControlPlaneDatabase {
  configurePostgresDriverForUrl(url);
  // max: 1 — scoped to a single operator request; one connection is enough.
  // connectionTimeoutMillis: fail fast rather than queue behind a stuck slot.
  // idleTimeoutMillis: recycle the slot even if pool.end() doesn't flush server-side.
  const pool = new Pool({
    connectionString: normalizePostgresConnectionStringForDriver(url),
    max: 1,
    connectionTimeoutMillis: 5_000,
    idleTimeoutMillis: 30_000,
  });

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
