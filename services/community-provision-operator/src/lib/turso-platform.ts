const TURSO_API_BASE_URL = "https://api.turso.tech";

export type TursoPlatformFetch = typeof fetch;

export class TursoPlatformError extends Error {
  constructor(
    message: string,
    public readonly status: number,
    public readonly method: string,
    public readonly path: string,
    public readonly body: unknown,
  ) {
    super(message);
  }
}

export type TursoGroup = {
  name: string;
  uuid: string | null;
  locations: string[];
  primary: string | null;
  version: string | null;
  deleteProtection: boolean | null;
};

export type TursoDatabase = {
  name: string;
  dbId: string | null;
  hostname: string | null;
  group: string | null;
  primaryRegion: string | null;
  regions: string[];
  libsqlUrl: string | null;
  deleteProtection: boolean | null;
};

type RequestOptions = {
  method?: "GET" | "POST" | "PATCH" | "DELETE";
  path: string;
  query?: Record<string, string | null | undefined>;
  body?: unknown;
};

function encodeQuery(query: Record<string, string | null | undefined> | undefined): string {
  if (!query) {
    return "";
  }

  const params = new URLSearchParams();
  for (const [key, value] of Object.entries(query)) {
    if (value == null || value === "") {
      continue;
    }
    params.set(key, value);
  }

  const encoded = params.toString();
  return encoded ? `?${encoded}` : "";
}

function readString(source: Record<string, unknown>, ...keys: string[]): string | null {
  for (const key of keys) {
    const value = source[key];
    if (typeof value === "string" && value.length > 0) {
      return value;
    }
  }

  return null;
}

function readBoolean(source: Record<string, unknown>, ...keys: string[]): boolean | null {
  for (const key of keys) {
    const value = source[key];
    if (typeof value === "boolean") {
      return value;
    }
  }

  return null;
}

function readStringArray(source: Record<string, unknown>, ...keys: string[]): string[] {
  for (const key of keys) {
    const value = source[key];
    if (Array.isArray(value)) {
      return value.filter((entry): entry is string => typeof entry === "string");
    }
  }

  return [];
}

function normalizeGroup(raw: unknown): TursoGroup {
  const source = (raw ?? {}) as Record<string, unknown>;
  return {
    name: readString(source, "name", "Name") ?? "",
    uuid: readString(source, "uuid", "Uuid"),
    locations: readStringArray(source, "locations", "Locations"),
    primary: readString(source, "primary", "Primary"),
    version: readString(source, "version", "Version"),
    deleteProtection: readBoolean(source, "delete_protection", "deleteProtection"),
  };
}

function buildLibsqlUrl(hostname: string | null): string | null {
  if (!hostname) {
    return null;
  }

  if (hostname.startsWith("libsql://")) {
    return hostname;
  }

  return `libsql://${hostname}`;
}

function normalizeDatabase(raw: unknown): TursoDatabase {
  const source = (raw ?? {}) as Record<string, unknown>;
  const hostname = readString(source, "hostname", "Hostname");
  return {
    name: readString(source, "name", "Name") ?? "",
    dbId: readString(source, "db_id", "dbId", "DbId"),
    hostname,
    group: readString(source, "group", "Group"),
    primaryRegion: readString(source, "primary_region", "primaryRegion", "PrimaryRegion"),
    regions: readStringArray(source, "regions", "Regions"),
    libsqlUrl: buildLibsqlUrl(hostname),
    deleteProtection: readBoolean(source, "delete_protection", "deleteProtection"),
  };
}

export class TursoPlatformClient {
  constructor(
    private readonly input: {
      apiToken: string;
      fetch?: TursoPlatformFetch;
      baseUrl?: string;
    },
  ) {}

  private get baseUrl(): string {
    return this.input.baseUrl ?? TURSO_API_BASE_URL;
  }

  private get fetchImpl(): TursoPlatformFetch {
    return this.input.fetch ?? fetch;
  }

  private async request<T>(options: RequestOptions): Promise<T> {
    const method = options.method ?? "GET";
    const path = `${options.path}${encodeQuery(options.query)}`;
    const response = await this.fetchImpl(`${this.baseUrl}${path}`, {
      method,
      headers: {
        authorization: `Bearer ${this.input.apiToken}`,
        ...(options.body === undefined ? {} : { "content-type": "application/json" }),
      },
      ...(options.body === undefined ? {} : { body: JSON.stringify(options.body) }),
    });

    let body: unknown = null;
    const text = await response.text();
    if (text) {
      try {
        body = JSON.parse(text) as unknown;
      } catch {
        body = text;
      }
    }

    if (!response.ok) {
      const message =
        typeof body === "object" && body && "error" in body
          ? String((body as Record<string, unknown>).error)
          : `${method} ${path} failed`;
      throw new TursoPlatformError(message, response.status, method, options.path, body);
    }

    return body as T;
  }

  validateApiToken(): Promise<{ exp: number | null }> {
    return this.request<{ exp?: number }>({
      path: "/v1/auth/validate",
    }).then((body) => ({
      exp: typeof body.exp === "number" ? body.exp : null,
    }));
  }

  async listGroups(organizationSlug: string): Promise<TursoGroup[]> {
    const body = await this.request<{ groups?: unknown[] }>({
      path: `/v1/organizations/${organizationSlug}/groups`,
    });
    return (body.groups ?? []).map(normalizeGroup);
  }

  async createGroup(input: {
    organizationSlug: string;
    groupName: string;
    location: string;
  }): Promise<TursoGroup> {
    const body = await this.request<{ group?: unknown }>({
      method: "POST",
      path: `/v1/organizations/${input.organizationSlug}/groups`,
      body: {
        name: input.groupName,
        location: input.location,
      },
    });
    return normalizeGroup(body.group);
  }

  async updateGroupConfiguration(input: {
    organizationSlug: string;
    groupName: string;
    deleteProtection: boolean;
  }): Promise<{ deleteProtection: boolean | null }> {
    const body = await this.request<{ delete_protection?: boolean }>({
      method: "PATCH",
      path: `/v1/organizations/${input.organizationSlug}/groups/${input.groupName}/configuration`,
      body: {
        delete_protection: input.deleteProtection,
      },
    });

    return {
      deleteProtection: readBoolean(body as Record<string, unknown>, "delete_protection", "deleteProtection"),
    };
  }

  async transferGroup(input: {
    organizationSlug: string;
    groupName: string;
    targetOrganizationSlug: string;
  }): Promise<TursoGroup> {
    const body = await this.request<{ group?: unknown } | unknown>({
      method: "POST",
      path: `/v1/organizations/${input.organizationSlug}/groups/${input.groupName}/transfer`,
      body: {
        organization: input.targetOrganizationSlug,
      },
    });

    if (typeof body === "object" && body && "group" in body) {
      return normalizeGroup((body as { group?: unknown }).group);
    }

    return normalizeGroup(body);
  }

  async createGroupAuthToken(input: {
    organizationSlug: string;
    groupName: string;
    expiration?: string;
    authorization?: "full-access" | "read-only";
  }): Promise<{ jwt: string }> {
    const body = await this.request<{ jwt?: string }>({
      method: "POST",
      path: `/v1/organizations/${input.organizationSlug}/groups/${input.groupName}/auth/tokens`,
      query: {
        expiration: input.expiration,
        authorization: input.authorization,
      },
    });

    return {
      jwt: String(body.jwt ?? ""),
    };
  }

  async invalidateGroupAuthTokens(input: {
    organizationSlug: string;
    groupName: string;
  }): Promise<void> {
    await this.request({
      method: "POST",
      path: `/v1/organizations/${input.organizationSlug}/groups/${input.groupName}/auth/rotate`,
    });
  }

  async listDatabases(input: {
    organizationSlug: string;
    groupName?: string;
  }): Promise<TursoDatabase[]> {
    const body = await this.request<{ databases?: unknown[] }>({
      path: `/v1/organizations/${input.organizationSlug}/databases`,
      query: {
        group: input.groupName,
      },
    });
    return (body.databases ?? []).map(normalizeDatabase);
  }

  async createDatabase(input: {
    organizationSlug: string;
    databaseName: string;
    groupName: string;
  }): Promise<TursoDatabase> {
    const body = await this.request<{ database?: unknown }>({
      method: "POST",
      path: `/v1/organizations/${input.organizationSlug}/databases`,
      body: {
        name: input.databaseName,
        group: input.groupName,
      },
    });
    return normalizeDatabase(body.database);
  }

  async updateDatabaseConfiguration(input: {
    organizationSlug: string;
    databaseName: string;
    deleteProtection: boolean;
  }): Promise<{ deleteProtection: boolean | null }> {
    const body = await this.request<Record<string, unknown>>({
      method: "PATCH",
      path: `/v1/organizations/${input.organizationSlug}/databases/${input.databaseName}/configuration`,
      body: {
        delete_protection: input.deleteProtection,
      },
    });

    return {
      deleteProtection: readBoolean(body, "delete_protection", "deleteProtection"),
    };
  }

  async createDatabaseAuthToken(input: {
    organizationSlug: string;
    databaseName: string;
    expiration?: string;
    authorization?: "full-access" | "read-only";
  }): Promise<{ jwt: string }> {
    const body = await this.request<{ jwt?: string }>({
      method: "POST",
      path: `/v1/organizations/${input.organizationSlug}/databases/${input.databaseName}/auth/tokens`,
      query: {
        expiration: input.expiration,
        authorization: input.authorization,
      },
    });

    return {
      jwt: String(body.jwt ?? ""),
    };
  }

  async invalidateDatabaseAuthTokens(input: {
    organizationSlug: string;
    databaseName: string;
  }): Promise<void> {
    await this.request({
      method: "POST",
      path: `/v1/organizations/${input.organizationSlug}/databases/${input.databaseName}/auth/rotate`,
    });
  }

  async deleteDatabase(input: {
    organizationSlug: string;
    databaseName: string;
  }): Promise<void> {
    await this.request({
      method: "DELETE",
      path: `/v1/organizations/${input.organizationSlug}/databases/${input.databaseName}`,
    });
  }

  async deleteGroup(input: {
    organizationSlug: string;
    groupName: string;
  }): Promise<void> {
    await this.request({
      method: "DELETE",
      path: `/v1/organizations/${input.organizationSlug}/groups/${input.groupName}`,
    });
  }
}
