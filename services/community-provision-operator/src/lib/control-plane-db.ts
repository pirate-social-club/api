import { createClient } from "@libsql/client";
import type { Client as LibsqlClient, Transaction as LibsqlTransaction, InArgs } from "@libsql/core/api";
import type { ControlPlaneDatabase, ControlPlaneQueryable } from "./types";

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

export function openControlPlaneDatabase(input: {
  url: string;
  authToken?: string | null;
}): ControlPlaneDatabase {
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
