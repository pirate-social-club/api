import { createDecipheriv } from "node:crypto";

const ALGORITHM = "aes-256-gcm";
const FORMAT_PREFIX = "v1";

type BunSqlConstructor = new (url: string) => {
  <T>(strings: TemplateStringsArray, ...values: unknown[]): Promise<T>;
  end(): Promise<void>;
};

type CommunityDbBindingRow = {
  database_url: string;
  encrypted_token: string;
  encryption_key_version: number | string;
};

export type ResolvedCommunityDb = {
  url: string;
  authToken: string;
};

function requireWrapKeyHex(wrapKey: string): Buffer {
  const normalized = wrapKey.trim();
  if (!/^[0-9a-fA-F]{64}$/.test(normalized)) {
    throw new Error("TURSO_COMMUNITY_DB_WRAP_KEY must be 32 bytes encoded as hex");
  }
  return Buffer.from(normalized, "hex");
}

export function decryptCommunityDbCredential(input: {
  encryptedToken: string;
  encryptionKeyVersion: number;
  wrapKey: string;
}): string {
  if (!Number.isInteger(input.encryptionKeyVersion) || input.encryptionKeyVersion <= 0) {
    throw new Error("Community DB credential encryption key version is invalid");
  }
  const [format, ivHex, tagHex, ciphertextHex] = input.encryptedToken.trim().split(":");
  if (format !== FORMAT_PREFIX || !ivHex || !tagHex || !ciphertextHex) {
    throw new Error("Community DB credential ciphertext format is invalid");
  }
  try {
    const decipher = createDecipheriv(ALGORITHM, requireWrapKeyHex(input.wrapKey), Buffer.from(ivHex, "hex"));
    decipher.setAuthTag(Buffer.from(tagHex, "hex"));
    const plaintext = Buffer.concat([
      decipher.update(Buffer.from(ciphertextHex, "hex")),
      decipher.final(),
    ]).toString("utf8");
    if (!plaintext.trim()) {
      throw new Error("empty plaintext");
    }
    return plaintext;
  } catch {
    throw new Error("Community DB credential ciphertext could not be decrypted");
  }
}

function getBunSql(): BunSqlConstructor {
  const maybeBun = (globalThis as typeof globalThis & {
    Bun?: { SQL?: BunSqlConstructor };
  }).Bun;
  if (!maybeBun?.SQL) {
    throw new Error("Bun.SQL is required to resolve community DB credentials from the control plane");
  }
  return maybeBun.SQL;
}

export async function resolveCommunityDbFromControlPlane(input: {
  communityId: string;
  controlPlaneDatabaseUrl: string;
  tursoCommunityDbWrapKey: string;
}): Promise<ResolvedCommunityDb> {
  const Sql = getBunSql();
  const db = new Sql(input.controlPlaneDatabaseUrl);
  try {
    const rows = await db<CommunityDbBindingRow[]>`
      SELECT
        b.database_url,
        cred.encrypted_token,
        cred.encryption_key_version
      FROM communities AS c
      JOIN community_database_bindings AS b
        ON b.community_database_binding_id = c.primary_database_binding_id
      JOIN community_db_credentials AS cred
        ON cred.community_database_binding_id = b.community_database_binding_id
       AND cred.status = 'active'
      WHERE c.community_id = ${input.communityId}
        AND c.provisioning_state = 'active'
      ORDER BY cred.created_at DESC
      LIMIT 1
    `;
    const row = rows[0];
    if (!row) {
      throw new Error(`No active community DB binding found for ${input.communityId}`);
    }
    return {
      url: row.database_url,
      authToken: decryptCommunityDbCredential({
        encryptedToken: row.encrypted_token,
        encryptionKeyVersion: Number(row.encryption_key_version),
        wrapKey: input.tursoCommunityDbWrapKey,
      }),
    };
  } finally {
    await db.end();
  }
}
