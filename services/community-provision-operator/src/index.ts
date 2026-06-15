import type { CloudflareOptions } from "@sentry/cloudflare";
import { captureException, withSentry } from "@sentry/cloudflare";
import { provisionCommunityRuntime } from "./lib/provision-runtime";
import { rotateCommunityToken } from "./lib/rotate-token";
import { doctorControlPlane } from "./lib/doctor";
import { migrateCommunityDatabase } from "./lib/community-bootstrap";
import { assertRemoteControlPlaneUrl, createStatelessPostgresClient, isPostgresControlPlaneUrl, openControlPlaneDatabase, pingPostgresControlPlane } from "./lib/control-plane-db";
import { errorMessage, requireText, trim } from "./lib/helpers";
import { reapStaleCommunityProvisioningJobs } from "./lib/reap-stale";

export type Env = {
  CONTROL_PLANE_DATABASE_URL: string;
  TURSO_CONTROL_PLANE_AUTH_TOKEN?: string;
  TURSO_PLATFORM_API_TOKEN: string;
  TURSO_ORGANIZATION_SLUG: string;
  EXPECTED_TURSO_ORGANIZATION_SLUG: string;
  TURSO_COMMUNITY_DB_WRAP_KEY?: string;
  TURSO_COMMUNITY_DB_WRAP_KEY_VERSION?: string;
  COMMUNITY_PROVISION_OPERATOR_AUTH_TOKEN: string;
  SENTRY_DSN?: string;
  ENVIRONMENT?: string;
  BUILD_GIT_REF?: string;
  BUILD_GIT_SHA?: string;
  BUILD_TIMESTAMP?: string;
};

export type OperatorDeps = {
  provisionFn?: typeof provisionCommunityRuntime;
  rotateFn?: typeof rotateCommunityToken;
  doctorFn?: typeof doctorControlPlane;
  migrateFn?: typeof migrateCommunityDatabase;
  reapStaleFn?: typeof reapStaleCommunityProvisioningJobs;
  openControlPlaneDbFn?: typeof openControlPlaneDatabase;
};

type ProvisionRouteBody = {
  community_id?: string;
  creator_user_id?: string;
  display_name?: string;
  namespace_verification_id?: string | null;
  group_location?: string;
  database_token_expiration?: string | null;
  bootstrap_payload?: {
    description?: string | null;
    avatar_ref?: string | null;
    banner_ref?: string | null;
    membership_mode?: "open" | "request" | "gated";
    default_age_gate_policy?: "none" | "18_plus";
    gate_policy?: Record<string, unknown> | null;
    membership_unique_human_provider?: "self" | "very" | null;
    posting_unique_human_provider?: "self" | "very" | null;
    handle_policy_template?: "standard" | "premium" | "membership_gated" | "custom";
    handle_pricing_model?: string | null;
    namespace_label?: string | null;
    initial_settings?: Record<string, unknown> | null;
  } | null;
};

type RotateRouteBody = {
  community_id?: string;
  reason?: string | null;
  database_token_expiration?: string | null;
};

type DoctorRouteBody = {
  community_id?: string | null;
};

type ReapStaleRouteBody = {
  stale_after_ms?: number | string | null;
};

type MigrateRouteBody = {
  database_url?: string;
  database_auth_token?: string;
};

function json(body: unknown, init?: ResponseInit): Response {
  return new Response(JSON.stringify(body), {
    ...init,
    headers: {
      "content-type": "application/json",
      ...(init?.headers ?? {}),
    },
  });
}

function requireOperatorAuth(request: Request, env: Env): Response | null {
  const expected = trim(env.COMMUNITY_PROVISION_OPERATOR_AUTH_TOKEN);
  if (!expected) {
    return json({ error_code: "operator_auth_not_configured" }, { status: 500 });
  }

  return request.headers.get("authorization") === `Bearer ${expected}`
    ? null
    : json({ error_code: "unauthorized" }, { status: 401 });
}

function optionalPositiveInt(value: number | string | null | undefined, label: string): number | null {
  if (value == null || trim(String(value)) === "") {
    return null;
  }
  const parsed = Number(value);
  if (!Number.isInteger(parsed) || parsed <= 0) {
    throw new Error(`${label} must be a positive integer`);
  }
  return parsed;
}

function requireOrgGuard(env: Env): void {
  const actual = requireText(env.TURSO_ORGANIZATION_SLUG, "TURSO_ORGANIZATION_SLUG");
  const expected = requireText(env.EXPECTED_TURSO_ORGANIZATION_SLUG, "EXPECTED_TURSO_ORGANIZATION_SLUG");
  if (actual !== expected) {
    throw new Error(`TURSO_ORGANIZATION_SLUG mismatch: expected ${expected}, got ${actual}`);
  }
}

// Single chokepoint: every route reads the control-plane URL through here so a
// non-remote (e.g. `file:`) URL is rejected at the boundary instead of failing
// deep inside provisioning once irreversible Turso resources already exist.
function requireControlPlaneUrl(env: Env): string {
  const url = requireText(env.CONTROL_PLANE_DATABASE_URL, "CONTROL_PLANE_DATABASE_URL");
  assertRemoteControlPlaneUrl(url, { environment: env.ENVIRONMENT });
  return url;
}

function errorExtra(error: unknown): Record<string, unknown> {
  if (!(error instanceof Error)) {
    return { error: String(error) };
  }
  return {
    name: error.name,
    message: error.message,
    stack: error.stack,
    provision_step: typeof (error as Error & { provisionStep?: unknown }).provisionStep === "string"
      ? (error as Error & { provisionStep: string }).provisionStep
      : null,
  };
}

function errorProvisionStep(error: unknown): string | null {
  return error instanceof Error && typeof (error as Error & { provisionStep?: unknown }).provisionStep === "string"
    ? (error as Error & { provisionStep: string }).provisionStep
    : null;
}

function makeSentryOptions(env: Env): CloudflareOptions {
  return {
    dsn: env.SENTRY_DSN,
    environment: trim(env.ENVIRONMENT) || "development",
    sendDefaultPii: false,
    tracesSampleRate: trim(env.ENVIRONMENT) === "production" ? 0.2 : 1.0,
    beforeSend(event) {
      if (event.request?.headers && typeof event.request.headers === "object") {
        const safe: Record<string, string> = {};
        for (const [key, value] of Object.entries(event.request.headers)) {
          safe[key] = key.toLowerCase() === "authorization" ? "[redacted]" : value;
        }
        event.request.headers = safe;
      }
      return event;
    },
  };
}

export function createHandler(deps: OperatorDeps = {}) {
  const provisionFn = deps.provisionFn ?? provisionCommunityRuntime;
  const rotateFn = deps.rotateFn ?? rotateCommunityToken;
  const doctorFn = deps.doctorFn ?? doctorControlPlane;
  const migrateFn = deps.migrateFn ?? migrateCommunityDatabase;
  const reapStaleFn = deps.reapStaleFn ?? reapStaleCommunityProvisioningJobs;
  const openControlPlaneDbFn = deps.openControlPlaneDbFn ?? openControlPlaneDatabase;

  return async function handle(request: Request, env: Env): Promise<Response> {
    const url = new URL(request.url);

    if (url.pathname === "/health") {
      return json({
        ok: true,
        service: "community-provision-operator",
        environment: trim(env.ENVIRONMENT) || null,
        git_sha: trim(env.BUILD_GIT_SHA) || null,
        git_ref: trim(env.BUILD_GIT_REF) || null,
        build_timestamp: trim(env.BUILD_TIMESTAMP) || null,
        runtime: "cloudflare-worker",
        requires_bearer_auth: Boolean(trim(env.COMMUNITY_PROVISION_OPERATOR_AUTH_TOKEN)),
        turso_organization_slug: trim(env.TURSO_ORGANIZATION_SLUG),
      });
    }

    const authResponse = requireOperatorAuth(request, env);
    if (authResponse) {
      return authResponse;
    }

    // Deep health: unlike `/health`, this actually opens the control plane and
    // runs `SELECT 1`, so a misconfigured CONTROL_PLANE_DATABASE_URL (e.g. a
    // `file:` URL the Workers runtime cannot read) is caught immediately after
    // deploy instead of at the first provisioning request.
    if (url.pathname === "/health/deep") {
      const base = {
        service: "community-provision-operator",
        environment: trim(env.ENVIRONMENT) || null,
      };
      let controlPlaneUrl: string;
      try {
        controlPlaneUrl = requireControlPlaneUrl(env);
      } catch (error) {
        return json(
          {
            ...base,
            ok: false,
            control_plane_ok: false,
            check: "control_plane_url",
            error_code: "control_plane_url_invalid",
            message: errorMessage(error).slice(0, 300),
          },
          { status: 503 },
        );
      }

      if (isPostgresControlPlaneUrl(controlPlaneUrl)) {
        // Use the stateless neon() HTTP client with AbortController so the fetch
        // is cancelled at the network level on timeout. Pool-based SELECT 1
        // abandoned by Promise.race would still queue at PlanetScale and grab a
        // slot once one frees — leaking connections with every failed health check.
        try {
          await pingPostgresControlPlane(controlPlaneUrl, 5_000);
          return json({ ...base, ok: true, control_plane_ok: true });
        } catch (error) {
          console.error("[health/deep] postgres ping failed:", errorMessage(error));
          return json(
            {
              ...base,
              ok: false,
              control_plane_ok: false,
              check: "control_plane_query",
              error_code: "control_plane_unreachable",
              message: errorMessage(error).slice(0, 300),
            },
            { status: 503 },
          );
        }
      }

      const db = openControlPlaneDbFn({
        url: controlPlaneUrl,
        authToken: trim(env.TURSO_CONTROL_PLANE_AUTH_TOKEN) || null,
      });
      try {
        await db.sql`SELECT 1`;
        return json({ ...base, ok: true, control_plane_ok: true });
      } catch (error) {
        console.error("[health/deep] control plane query failed:", errorMessage(error));
        return json(
          {
            ...base,
            ok: false,
            control_plane_ok: false,
            check: "control_plane_query",
            error_code: "control_plane_unreachable",
            message: errorMessage(error).slice(0, 300),
          },
          { status: 503 },
        );
      } finally {
        await db.close().catch((e) => console.error("[health/deep] pool close failed", e));
      }
    }

    // DEBUG: use stateless neon() HTTP client to inspect connections (bypasses pool slot limits)
    if (url.pathname === "/debug/pg-connections" && request.method === "GET") {
      const controlPlaneUrl = requireControlPlaneUrl(env);
      if (!isPostgresControlPlaneUrl(controlPlaneUrl)) {
        return json({ error: "not postgres" }, { status: 400 });
      }
      try {
        const sql = createStatelessPostgresClient(controlPlaneUrl);
        const rows = await sql`
          SELECT pid, state, wait_event_type, left(query, 60) AS q
          FROM pg_stat_activity WHERE datname = current_database()
          ORDER BY state LIMIT 40
        `;
        const total = await sql`SELECT count(*) AS n FROM pg_stat_activity WHERE datname = current_database()`;
        return json({ total: (total as Array<{n: unknown}>)[0]?.n, rows });
      } catch (error) {
        return json({ error: errorMessage(error) }, { status: 503 });
      }
    }
    // DEBUG: terminate all non-self backend connections to drain a saturated pool
    if (url.pathname === "/debug/pg-terminate" && request.method === "POST") {
      const controlPlaneUrl = requireControlPlaneUrl(env);
      if (!isPostgresControlPlaneUrl(controlPlaneUrl)) {
        return json({ error: "not postgres" }, { status: 400 });
      }
      try {
        const sql = createStatelessPostgresClient(controlPlaneUrl);
        const result = await sql`
          SELECT pg_terminate_backend(pid), pid, state, left(query, 60) AS q
          FROM pg_stat_activity
          WHERE datname = current_database() AND pid <> pg_backend_pid()
        `;
        return json({ terminated: result.length, rows: result });
      } catch (error) {
        return json({ error: errorMessage(error) }, { status: 503 });
      }
    }

    if (request.method !== "POST") {
      return new Response("Method Not Allowed", { status: 405 });
    }

    try {
      if (url.pathname === "/internal/v0/community-provisioning/provision") {
        const body = await request.json() as ProvisionRouteBody;
        const requestId = trim(request.headers.get("x-request-id")) || null;
        requireOrgGuard(env);
        const result = await provisionFn({
          controlPlaneDatabaseUrl: requireControlPlaneUrl(env),
          controlPlaneAuthToken: trim(env.TURSO_CONTROL_PLANE_AUTH_TOKEN) || null,
          tursoPlatformApiToken: requireText(env.TURSO_PLATFORM_API_TOKEN, "TURSO_PLATFORM_API_TOKEN"),
          tursoOrganizationSlug: requireText(env.TURSO_ORGANIZATION_SLUG, "TURSO_ORGANIZATION_SLUG"),
          requestId,
          communityId: requireText(body.community_id, "community_id"),
          creatorUserId: requireText(body.creator_user_id, "creator_user_id"),
          displayName: requireText(body.display_name, "display_name"),
          namespaceVerificationId: trim(body.namespace_verification_id ?? "") || null,
          groupLocation: requireText(body.group_location, "group_location"),
          description: body.bootstrap_payload?.description ?? null,
          avatarRef: body.bootstrap_payload?.avatar_ref ?? null,
          bannerRef: body.bootstrap_payload?.banner_ref ?? null,
          membershipMode: body.bootstrap_payload?.membership_mode ?? "open",
          defaultAgeGatePolicy: body.bootstrap_payload?.default_age_gate_policy ?? "none",
          gatePolicy: body.bootstrap_payload?.gate_policy ?? null,
          membershipUniqueHumanProvider: body.bootstrap_payload?.membership_unique_human_provider ?? null,
          postingUniqueHumanProvider: body.bootstrap_payload?.posting_unique_human_provider ?? null,
          handlePolicyTemplate: body.bootstrap_payload?.handle_policy_template ?? "premium",
          handlePricingModel: body.bootstrap_payload?.handle_pricing_model ?? "flat_by_length",
          namespaceLabel: body.bootstrap_payload?.namespace_label ?? null,
          initialSettings: body.bootstrap_payload?.initial_settings ?? null,
          databaseTokenExpiration: trim(body.database_token_expiration ?? "") || null,
        });
        return json({
          community_id: result.communityId,
          organization_slug: result.organizationSlug,
          group_name: result.groupName,
          group_id: result.groupId,
          database_name: result.databaseName,
          database_id: result.databaseId,
          database_url: result.databaseUrl,
          location: result.location,
          token_name: result.tokenName,
          plaintext_token: result.plaintextToken,
          issued_at: result.issuedAt,
          expires_at: result.expiresAt,
          rotation_number: result.rotationNumber,
        });
      }

      if (url.pathname === "/internal/v0/community-provisioning/rotate-token") {
        const body = await request.json() as RotateRouteBody;
        requireOrgGuard(env);
        const result = await rotateFn({
          controlPlaneDatabaseUrl: requireControlPlaneUrl(env),
          controlPlaneAuthToken: trim(env.TURSO_CONTROL_PLANE_AUTH_TOKEN) || null,
          tursoPlatformApiToken: requireText(env.TURSO_PLATFORM_API_TOKEN, "TURSO_PLATFORM_API_TOKEN"),
          tursoCommunityDbWrapKey: requireText(env.TURSO_COMMUNITY_DB_WRAP_KEY, "TURSO_COMMUNITY_DB_WRAP_KEY"),
          tursoCommunityDbWrapKeyVersion: Number(requireText(env.TURSO_COMMUNITY_DB_WRAP_KEY_VERSION, "TURSO_COMMUNITY_DB_WRAP_KEY_VERSION")),
          communityId: requireText(body.community_id, "community_id"),
          reason: trim(body.reason ?? "") || null,
          databaseTokenExpiration: trim(body.database_token_expiration ?? "") || null,
        });
        return json({
          community_id: result.communityId,
          binding_id: result.communityDatabaseBindingId,
          credential_id: result.communityDbCredentialId,
          database_name: result.databaseName,
          database_url: result.databaseUrl,
          token_name: result.tokenName,
          rotation_number: result.rotationNumber,
        });
      }

      if (url.pathname === "/internal/v0/community-provisioning/doctor") {
        const body = await request.json() as DoctorRouteBody;
        const result = await doctorFn({
          controlPlaneDatabaseUrl: requireControlPlaneUrl(env),
          controlPlaneAuthToken: trim(env.TURSO_CONTROL_PLANE_AUTH_TOKEN) || null,
          communityId: trim(body.community_id ?? "") || null,
          tursoCommunityDbWrapKey: trim(env.TURSO_COMMUNITY_DB_WRAP_KEY) || null,
        });
        return json({
          checked_communities: result.checkedCommunityCount,
          checked_bindings: result.checkedBindingCount,
          checked_credentials: result.checkedCredentialCount,
          findings: result.findings,
          finding_count: result.findingCount,
        });
      }

      if (url.pathname === "/internal/v0/community-provisioning/reap-stale") {
        const body = await request.json() as ReapStaleRouteBody;
        const result = await reapStaleFn({
          controlPlaneDatabaseUrl: requireControlPlaneUrl(env),
          controlPlaneAuthToken: trim(env.TURSO_CONTROL_PLANE_AUTH_TOKEN) || null,
          staleAfterMs: optionalPositiveInt(body.stale_after_ms, "stale_after_ms") ?? undefined,
        });
        return json({
          cutoff: result.cutoff,
          stale_after_ms: result.staleAfterMs,
          reaped_job_count: result.reapedJobCount,
          reaped_jobs: result.reapedJobs.map((job: { jobId: string; communityId: string; updatedAt: string }) => ({
            job_id: job.jobId,
            community_id: job.communityId,
            updated_at: job.updatedAt,
          })),
        });
      }

      if (url.pathname === "/internal/v0/community-provisioning/migrate") {
        const body = await request.json() as MigrateRouteBody;
        requireOrgGuard(env);
        const databaseUrl = requireText(body.database_url, "database_url");
        const databaseAuthToken = requireText(body.database_auth_token, "database_auth_token");
        const result = await migrateFn({
          databaseUrl,
          databaseAuthToken,
        });
        return json({
          applied: result.applied,
          skipped: result.skipped,
        });
      }

      return new Response("Not Found", { status: 404 });
    } catch (error) {
      const message = error instanceof Error ? error.message : "operator request failed";
      const provisionStep = errorProvisionStep(error);
      const isValidationError = message.endsWith(" is required")
        || message.includes("must be valid JSON")
        || message.endsWith("must be a positive integer")
        || message.includes("Failed to parse JSON")
        || message.includes("Unexpected token")
        || message.includes("invalid JSON");
      console.error("[community-provision-operator]", request.method, url.pathname, `request_id=${trim(request.headers.get("x-request-id")) || "none"}`, message);
      if (!isValidationError && trim(env.SENTRY_DSN)) {
        captureException(error, {
          tags: {
            route: url.pathname,
            method: request.method,
            operator_request_id: trim(request.headers.get("x-request-id")) || "none",
            ...(provisionStep ? { provision_step: provisionStep } : {}),
          },
          extra: {
            ...errorExtra(error),
          },
        });
      }
      return json(
        {
          error_code: isValidationError ? "invalid_request" : "community_provision_operator_failed",
          message,
          ...(provisionStep ? { provision_step: provisionStep } : {}),
        },
        { status: isValidationError ? 400 : 500 },
      );
    }
  };
}

const handler = {
  fetch: createHandler(),
};

export default withSentry(makeSentryOptions, handler);
