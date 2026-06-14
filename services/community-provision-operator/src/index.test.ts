import { describe, expect, test } from "bun:test";
import { createHandler, type Env } from "./index";

const baseEnv: Env = {
  CONTROL_PLANE_DATABASE_URL: "libsql://control.test.turso.io",
  TURSO_CONTROL_PLANE_AUTH_TOKEN: "cp-auth-token",
  TURSO_PLATFORM_API_TOKEN: "platform-token",
  TURSO_ORGANIZATION_SLUG: "pirate-prod",
  EXPECTED_TURSO_ORGANIZATION_SLUG: "pirate-prod",
  TURSO_COMMUNITY_DB_WRAP_KEY: "11".repeat(32),
  TURSO_COMMUNITY_DB_WRAP_KEY_VERSION: "2",
  COMMUNITY_PROVISION_OPERATOR_AUTH_TOKEN: "operator-shared-token",
};

function handlerRequest(
  handler: ReturnType<typeof createHandler>,
  path: string,
  opts: {
    env?: Partial<Env>;
    authToken?: string | null;
    body?: unknown;
    method?: string;
  } = {},
): Promise<Response> {
  const env = { ...baseEnv, ...opts.env } as Env;
  const headers: Record<string, string> = {
    "content-type": "application/json",
  };
  if (opts.authToken !== null) {
    headers.authorization = `Bearer ${opts.authToken ?? env.COMMUNITY_PROVISION_OPERATOR_AUTH_TOKEN}`;
  }
  return handler(
    new Request(`https://operator.test${path}`, {
      method: opts.method ?? "POST",
      headers,
      body: opts.body !== undefined ? JSON.stringify(opts.body) : undefined,
    }),
    env,
  );
}

describe("community provision operator handler", () => {
  test("health endpoint returns ok without auth", async () => {
    const handler = createHandler();
    const response = await handlerRequest(handler, "/health", {
      method: "GET",
      authToken: null,
    });
    expect(response.status).toBe(200);
    const body = await response.json() as {
      ok: boolean;
      service: string;
      environment: string | null;
      git_sha: string | null;
      git_ref: string | null;
      build_timestamp: string | null;
      runtime: string;
      requires_bearer_auth: boolean;
    };
    expect(body.ok).toBe(true);
    expect(body.service).toBe("community-provision-operator");
    expect(body.environment).toBe(null);
    expect(body.git_sha).toBe(null);
    expect(body.git_ref).toBe(null);
    expect(body.build_timestamp).toBe(null);
    expect(body.runtime).toBe("cloudflare-worker");
    expect(body.requires_bearer_auth).toBe(true);
  });

  test("deep health requires bearer auth", async () => {
    const handler = createHandler();
    const response = await handlerRequest(handler, "/health/deep", {
      method: "GET",
      authToken: null,
    });
    expect(response.status).toBe(401);
  });

  test("deep health returns ok when the control plane answers SELECT 1", async () => {
    const handler = createHandler({
      openControlPlaneDbFn: () => ({
        sql: async () => [] as unknown as never,
        begin: async (cb) => cb({ sql: async () => [] as unknown as never }),
        close: async () => {},
      }),
    });
    const response = await handlerRequest(handler, "/health/deep", { method: "GET" });
    expect(response.status).toBe(200);
    const body = await response.json() as { ok: boolean; control_plane_ok: boolean };
    expect(body.ok).toBe(true);
    expect(body.control_plane_ok).toBe(true);
  });

  test("deep health returns 503 when the control plane url is file: in production", async () => {
    // openControlPlaneDbFn must never be reached: the URL guard rejects first.
    const handler = createHandler({
      openControlPlaneDbFn: () => {
        throw new Error("must not open a file: control plane");
      },
    });
    const response = await handlerRequest(handler, "/health/deep", {
      method: "GET",
      env: { ENVIRONMENT: "production", CONTROL_PLANE_DATABASE_URL: "file:./control.db" },
    });
    expect(response.status).toBe(503);
    const body = await response.json() as { ok: boolean; control_plane_ok: boolean; error_code: string; message: string };
    expect(body.ok).toBe(false);
    expect(body.control_plane_ok).toBe(false);
    expect(body.error_code).toBe("control_plane_url_invalid");
    expect(body.message).toContain('"file:"');
  });

  test("deep health returns 503 when the control plane query fails", async () => {
    const handler = createHandler({
      openControlPlaneDbFn: () => ({
        sql: async () => {
          throw new Error("connection refused");
        },
        begin: async (cb) => cb({ sql: async () => [] as unknown as never }),
        close: async () => {},
      }),
    });
    const response = await handlerRequest(handler, "/health/deep", { method: "GET" });
    expect(response.status).toBe(503);
    const body = await response.json() as { ok: boolean; error_code: string; message: string };
    expect(body.ok).toBe(false);
    expect(body.error_code).toBe("control_plane_unreachable");
    expect(body.message).toContain("connection refused");
  });

  test("provision rejects a file: control plane url in production before doing work", async () => {
    const handler = createHandler({
      provisionFn: async () => {
        throw new Error("must not provision with a file: control plane");
      },
    });
    const response = await handlerRequest(handler, "/internal/v0/community-provisioning/provision", {
      env: { ENVIRONMENT: "production", CONTROL_PLANE_DATABASE_URL: "file:./control.db" },
      body: {
        community_id: "cmt_01",
        creator_user_id: "usr_01",
        display_name: "Test",
        group_location: "aws-us-east-1",
      },
    });
    expect(response.status).toBe(500);
    const body = await response.json() as { error_code: string; message: string };
    expect(body.message).toContain('"file:"');
  });

  test("private routes require bearer auth", async () => {
    const handler = createHandler();
    const response = await handlerRequest(handler, "/internal/v0/community-provisioning/provision", {
      authToken: null,
      body: {},
    });
    expect(response.status).toBe(401);
    const body = await response.json() as { error_code: string };
    expect(body.error_code).toBe("unauthorized");
  });

  test("wrong bearer token is rejected", async () => {
    const handler = createHandler();
    const response = await handlerRequest(handler, "/internal/v0/community-provisioning/provision", {
      authToken: "wrong-token",
      body: {},
    });
    expect(response.status).toBe(401);
  });

  test("non-POST methods are rejected on private routes", async () => {
    const handler = createHandler();
    const response = await handlerRequest(handler, "/internal/v0/community-provisioning/provision", {
      method: "GET",
    });
    expect(response.status).toBe(405);
  });

  test("unknown routes return 404", async () => {
    const handler = createHandler();
    const response = await handlerRequest(handler, "/internal/v0/unknown", {
      body: {},
    });
    expect(response.status).toBe(404);
  });

  test("org guard rejects mismatched TURSO_ORGANIZATION_SLUG on provision", async () => {
    const handler = createHandler();
    const response = await handlerRequest(handler, "/internal/v0/community-provisioning/provision", {
      env: {
        ...baseEnv,
        TURSO_ORGANIZATION_SLUG: "pirate-wrong",
      },
      body: {
        community_id: "cmt_01",
        creator_user_id: "usr_01",
        display_name: "Test",
        group_location: "aws-us-east-1",
      },
    });
    expect(response.status).toBe(500);
    const body = await response.json() as { error_code: string; message: string };
    expect(body.error_code).toBe("community_provision_operator_failed");
    expect(body.message).toContain("TURSO_ORGANIZATION_SLUG mismatch");
  });

  test("org guard rejects mismatched slug on rotate-token", async () => {
    const handler = createHandler();
    const response = await handlerRequest(handler, "/internal/v0/community-provisioning/rotate-token", {
      env: {
        ...baseEnv,
        TURSO_ORGANIZATION_SLUG: "pirate-wrong",
      },
      body: {
        community_id: "cmt_01",
      },
    });
    expect(response.status).toBe(500);
    const body = await response.json() as { error_code: string; message: string };
    expect(body.message).toContain("TURSO_ORGANIZATION_SLUG mismatch");
  });

  test("provision validates required fields", async () => {
    const handler = createHandler();
    const response = await handlerRequest(handler, "/internal/v0/community-provisioning/provision", {
      body: {},
    });
    expect(response.status).toBe(400);
    const body = await response.json() as { error_code: string; message: string };
    expect(body.error_code).toBe("invalid_request");
    expect(body.message).toContain("community_id is required");
  });

  test("reap-stale route validates stale_after_ms", async () => {
    const handler = createHandler();
    const response = await handlerRequest(handler, "/internal/v0/community-provisioning/reap-stale", {
      body: { stale_after_ms: -1 },
    });
    expect(response.status).toBe(400);
    const body = await response.json() as { error_code: string; message: string };
    expect(body.error_code).toBe("invalid_request");
    expect(body.message).toContain("must be a positive integer");
  });

  test("migrate validates required fields", async () => {
    const handler = createHandler();
    const response = await handlerRequest(handler, "/internal/v0/community-provisioning/migrate", {
      body: {
        database_url: "libsql://community.test.turso.io",
      },
    });
    expect(response.status).toBe(400);
    const body = await response.json() as { error_code: string; message: string };
    expect(body.error_code).toBe("invalid_request");
    expect(body.message).toContain("database_auth_token is required");
  });

  test("invalid JSON body returns 400", async () => {
    const handler = createHandler();
    const env = { ...baseEnv };
    const response = await handler(
      new Request("https://operator.test/internal/v0/community-provisioning/provision", {
        method: "POST",
        headers: {
          authorization: `Bearer ${env.COMMUNITY_PROVISION_OPERATOR_AUTH_TOKEN}`,
          "content-type": "application/json",
        },
        body: "not-json",
      }),
      env,
    );
    expect(response.status).toBe(400);
    const body = await response.json() as { error_code: string };
    expect(body.error_code).toBe("invalid_request");
  });
});

describe("community provision operator success paths", () => {
  test("provision returns the contract JSON shape the API parses", async () => {
    const handler = createHandler({
      provisionFn: async () => ({
        communityId: "cmt_01",
        organizationSlug: "pirate-prod",
        groupName: "region-aws-us-east-1",
        groupId: "grp_01",
        databaseName: "main-cmt-01",
        databaseId: "db_01",
        databaseUrl: "libsql://main-cmt-01-pirate-prod.aws-us-east-1.turso.io",
        location: "aws-us-east-1",
        tokenName: "worker-cmt_01-v1",
        plaintextToken: "db-token-01",
        issuedAt: "2026-04-12T00:00:00.000Z",
        expiresAt: null,
        rotationNumber: 1,
      }),
    });

    const response = await handlerRequest(handler, "/internal/v0/community-provisioning/provision", {
      body: {
        community_id: "cmt_01",
        creator_user_id: "usr_01",
        display_name: "Infinity",
        namespace_verification_id: "nv_01",
        group_location: "aws-us-east-1",
        bootstrap_payload: {
          description: "hello",
          membership_mode: "gated",
          default_age_gate_policy: "18_plus",
          handle_policy_template: "standard",
        },
      },
    });

    expect(response.status).toBe(200);
    const body = await response.json() as Record<string, unknown>;
    expect(body).toMatchObject({
      community_id: "cmt_01",
      organization_slug: "pirate-prod",
      group_name: "region-aws-us-east-1",
      group_id: "grp_01",
      database_name: "main-cmt-01",
      database_id: "db_01",
      database_url: "libsql://main-cmt-01-pirate-prod.aws-us-east-1.turso.io",
      location: "aws-us-east-1",
      token_name: "worker-cmt_01-v1",
      plaintext_token: "db-token-01",
      issued_at: "2026-04-12T00:00:00.000Z",
      expires_at: null,
      rotation_number: 1,
    });
  });

  test("rotate-token returns the contract JSON shape", async () => {
    const handler = createHandler({
      rotateFn: async () => ({
        communityId: "cmt_01",
        communityDatabaseBindingId: "cdb_01",
        communityDbCredentialId: "cdc_02",
        databaseName: "main-cmt-01",
        databaseUrl: "libsql://main-cmt-01-pirate-prod.aws-us-east-1.turso.io",
        tokenName: "worker-cmt_01-v2",
        rotationNumber: 2,
      }),
    });

    const response = await handlerRequest(handler, "/internal/v0/community-provisioning/rotate-token", {
      body: {
        community_id: "cmt_01",
        reason: "scheduled rotation",
      },
    });

    expect(response.status).toBe(200);
    const body = await response.json() as Record<string, unknown>;
    expect(body).toMatchObject({
      community_id: "cmt_01",
      binding_id: "cdb_01",
      credential_id: "cdc_02",
      database_name: "main-cmt-01",
      database_url: "libsql://main-cmt-01-pirate-prod.aws-us-east-1.turso.io",
      token_name: "worker-cmt_01-v2",
      rotation_number: 2,
    });
  });

  test("doctor returns findings shape without network", async () => {
    const handler = createHandler({
      doctorFn: async () => ({
        checkedCommunityCount: 2,
        checkedBindingCount: 2,
        checkedCredentialCount: 1,
        findingCount: 1,
        findings: [
          {
            severity: "error",
            code: "binding_database_url_invalid",
            communityId: "cmt_01",
            communityDatabaseBindingId: "cdb_01",
            message: "bad url",
          },
        ],
      }),
    });

    const response = await handlerRequest(handler, "/internal/v0/community-provisioning/doctor", {
      body: { community_id: null },
    });

    expect(response.status).toBe(200);
    const body = await response.json() as Record<string, unknown>;
    expect(body).toMatchObject({
      checked_communities: 2,
      checked_bindings: 2,
      checked_credentials: 1,
      finding_count: 1,
    });
  });

  test("reap-stale returns reaped jobs without network", async () => {
    const handler = createHandler({
      reapStaleFn: async () => ({
        cutoff: "2026-05-01T17:30:00.000Z",
        staleAfterMs: 900000,
        reapedJobCount: 1,
        reapedJobs: [{
          jobId: "job_stale",
          communityId: "cmt_stale",
          updatedAt: "2026-05-01T17:00:00.000Z",
        }],
      }),
    });

    const response = await handlerRequest(handler, "/internal/v0/community-provisioning/reap-stale", {
      body: { stale_after_ms: 900000 },
    });

    expect(response.status).toBe(200);
    const body = await response.json() as Record<string, unknown>;
    expect(body).toMatchObject({
      cutoff: "2026-05-01T17:30:00.000Z",
      stale_after_ms: 900000,
      reaped_job_count: 1,
    });
    const jobs = body.reaped_jobs as Array<Record<string, string>>;
    expect(jobs[0]).toEqual({
      job_id: "job_stale",
      community_id: "cmt_stale",
      updated_at: "2026-05-01T17:00:00.000Z",
    });
  });

  test("migrate returns applied and skipped counts", async () => {
    const calls: Array<{ databaseUrl: string; databaseAuthToken: string }> = [];
    const handler = createHandler({
      migrateFn: async (input) => {
        calls.push(input);
        return { applied: 1, skipped: 61 };
      },
    });

    const response = await handlerRequest(handler, "/internal/v0/community-provisioning/migrate", {
      body: {
        database_url: "libsql://community.test.turso.io",
        database_auth_token: "community-db-token",
      },
    });

    expect(response.status).toBe(200);
    expect(calls).toEqual([{
      databaseUrl: "libsql://community.test.turso.io",
      databaseAuthToken: "community-db-token",
    }]);
    const body = await response.json() as Record<string, unknown>;
    expect(body).toEqual({
      applied: 1,
      skipped: 61,
    });
  });

  test("provision operator failure returns 500 with error details", async () => {
    const handler = createHandler({
      provisionFn: async () => {
        throw new Error("turso group creation failed");
      },
    });

    const response = await handlerRequest(handler, "/internal/v0/community-provisioning/provision", {
      body: {
        community_id: "cmt_01",
        creator_user_id: "usr_01",
        display_name: "Test",
        group_location: "aws-us-east-1",
      },
    });

    expect(response.status).toBe(500);
    const body = await response.json() as { error_code: string; message: string };
    expect(body.error_code).toBe("community_provision_operator_failed");
    expect(body.message).toContain("turso group creation failed");
  });
});
