import { afterEach, describe, expect, test } from "bun:test"
import type { Client } from "../sql-client"
import {
  buildTestEnv,
  createControlPlaneTestClient,
  withMockedFetch,
} from "../../../tests/helpers"
import {
  hnsNamespaceRevalidationAlertState,
  sweepHnsNamespaceRevalidations,
} from "./namespace-revalidation-cron"

const NOW = new Date("2026-07-13T12:00:00.000Z")
const FUTURE_EXPIRY = "2026-07-20T12:00:00.000Z"
const EXPIRED = "2026-07-01T12:00:00.000Z"
const CONFIG = {
  enabled: true,
  intervalSeconds: 86_400,
  validitySeconds: 2_592_000,
  batchSize: 25,
}

let cleanup: (() => Promise<void>) | null = null

afterEach(async () => {
  await cleanup?.()
  cleanup = null
})

async function setup() {
  const controlPlane = await createControlPlaneTestClient({ includeAllMigrations: true })
  cleanup = controlPlane.cleanup
  return controlPlane.client
}

async function seedAcceptedHnsVerification(input: {
  client: Client
  suffix?: string
  status?: "verified" | "stale"
  expiresAt?: string
}): Promise<{ namespaceVerificationId: string }> {
  const suffix = input.suffix ?? "one"
  const userId = `usr_revalidation_${suffix}`
  const sessionId = `nvs_revalidation_${suffix}`
  const namespaceVerificationId = `namespace_revalidation_${suffix}`
  const evidenceBundleId = `nev_revalidation_${suffix}`
  const rootLabel = `root-${suffix}`
  const acceptedAt = "2026-06-01T00:00:00.000Z"
  const expiresAt = input.expiresAt ?? FUTURE_EXPIRY

  await input.client.batch([
    {
      sql: `
        INSERT INTO users (
          user_id, verification_state, verification_capabilities_json, created_at, updated_at
        ) VALUES (?1, 'verified', '[]', ?2, ?2)
      `,
      args: [userId, acceptedAt],
    },
    {
      sql: `
        INSERT INTO namespace_verification_sessions (
          namespace_verification_session_id, namespace_verification_id, user_id, family,
          submitted_root_label, normalized_root_label, status, root_exists,
          root_control_verified, expiry_horizon_sufficient, routing_enabled,
          pirate_dns_authority_verified, authority_health_verified, club_attach_allowed,
          pirate_web_routing_allowed, pirate_subdomain_issuance_allowed,
          accepted_at, expires_at, created_at, updated_at
        ) VALUES (
          ?1, ?2, ?3, 'hns', ?4, ?4, 'verified', 1, 1, 1, 1, 1, 1, 1, 1, 1,
          ?5, ?6, ?5, ?5
        )
      `,
      args: [sessionId, namespaceVerificationId, userId, rootLabel, acceptedAt, expiresAt],
    },
    {
      sql: `
        INSERT INTO namespace_verifications (
          namespace_verification_id, source_namespace_verification_session_id, user_id,
          family, normalized_root_label, status, root_exists, root_control_verified,
          expiry_horizon_sufficient, routing_enabled, pirate_dns_authority_verified,
          authority_health_verified, club_attach_allowed, pirate_web_routing_allowed,
          pirate_subdomain_issuance_allowed, accepted_at, expires_at, created_at, updated_at
        ) VALUES (
          ?1, ?2, ?3, 'hns', ?4, ?5, 1, 1, 1, 1, 1, 1, 1, 1, 1,
          ?6, ?7, ?6, ?6
        )
      `,
      args: [
        namespaceVerificationId,
        sessionId,
        userId,
        rootLabel,
        input.status ?? "verified",
        acceptedAt,
        expiresAt,
      ],
    },
    {
      sql: `
        INSERT INTO namespace_verification_evidence_bundles (
          evidence_bundle_id, namespace_verification_session_id, namespace_verification_id,
          family, normalized_root_label, evidence_kind, provider, resolver_path_json,
          raw_response_json, observed_at, created_at, updated_at
        ) VALUES (?1, ?2, ?3, 'hns', ?4, 'accepted_snapshot', 'legacy', '[]', '{}', ?5, ?5, ?5)
      `,
      args: [evidenceBundleId, sessionId, namespaceVerificationId, rootLabel, acceptedAt],
    },
    ...[
      "root_exists",
      "root_control_verified",
      "expiry_horizon_sufficient",
      "routing_enabled",
      "pirate_dns_authority_verified",
      "authority_health_verified",
    ].map((assertionName) => ({
      sql: `
        INSERT INTO namespace_verification_assertions (
          assertion_record_id, namespace_verification_session_id, namespace_verification_id,
          family, assertion_name, assertion_value, source_evidence_bundle_id, status,
          first_accepted_at, last_revalidated_at, created_at, updated_at
        ) VALUES (?1, ?2, ?3, 'hns', ?4, 1, ?5, 'accepted', ?6, ?7, ?6, ?6)
      `,
      args: [
        `nva_${suffix}_${assertionName}`,
        sessionId,
        namespaceVerificationId,
        assertionName,
        evidenceBundleId,
        acceptedAt,
        assertionName === "expiry_horizon_sufficient" ? null : acceptedAt,
      ],
    })),
    ...[
      "club_attach_allowed",
      "pirate_web_routing_allowed",
      "pirate_subdomain_issuance_allowed",
    ].map((capabilityName) => ({
      sql: `
        INSERT INTO namespace_verification_capabilities (
          capability_record_id, namespace_verification_session_id, namespace_verification_id,
          family, capability_name, capability_value, source_evidence_bundle_id, status,
          first_accepted_at, last_revalidated_at, created_at, updated_at
        ) VALUES (?1, ?2, ?3, 'hns', ?4, 1, ?5, 'accepted', ?6, ?6, ?6, ?6)
      `,
      args: [
        `nvc_${suffix}_${capabilityName}`,
        sessionId,
        namespaceVerificationId,
        capabilityName,
        evidenceBundleId,
        acceptedAt,
      ],
    })),
  ], "write")

  return { namespaceVerificationId }
}

function testEnv() {
  return buildTestEnv({
    ENVIRONMENT: "test",
    HNS_VERIFIER_BASE_URL: "http://hns-verifier.test",
    HNS_VERIFIER_AUTH_TOKEN: "test-verifier-token",
    HNS_NAMESPACE_REVALIDATION_ENABLED: "true",
  })
}

async function withInspection<T>(
  inspection: Record<string, unknown>,
  run: () => Promise<T>,
): Promise<T> {
  return withMockedFetch(
    () => async (request, init) => {
      const normalizedRequest = new Request(request, init)
      expect(normalizedRequest.url).toContain("/inspect-public?root_label=")
      expect(normalizedRequest.headers.get("authorization")).toBe("Bearer test-verifier-token")
      return Response.json(inspection)
    },
    run,
  )
}

async function readVerification(client: Client, namespaceVerificationId: string) {
  const result = await client.execute({
    sql: "SELECT * FROM namespace_verifications WHERE namespace_verification_id = ?1",
    args: [namespaceVerificationId],
  })
  return result.rows[0]
}

describe("HNS namespace revalidation sweep", () => {
  test("is a no-op while disabled", async () => {
    const client = await setup()
    await seedAcceptedHnsVerification({ client })
    let fetchCalled = false

    const summary = await withMockedFetch(
      () => async () => {
        fetchCalled = true
        return Response.json({})
      },
      () => sweepHnsNamespaceRevalidations({
        client,
        env: buildTestEnv(),
        now: NOW,
        config: { ...CONFIG, enabled: false },
      }),
    )

    expect(summary).toEqual({
      enabled: false,
      candidates: 0,
      attempted: 0,
      refreshed: 0,
      downgraded: 0,
      staled: 0,
      deferred: 0,
      leasesApproachingExpiry: 0,
      errors: 0,
      deadlineReached: false,
    })
    expect(fetchCalled).toBeFalse()
  })

  test("refreshes a bounded lease only from sufficient hsd evidence", async () => {
    const client = await setup()
    const { namespaceVerificationId } = await seedAcceptedHnsVerification({ client })

    const summary = await withInspection({
      root_exists: true,
      expiry_root_exists: true,
      expiry_horizon_sufficient: true,
      expiry_observation_provider: "hsd_json_rpc",
      expiry_height: 250_000,
      expiry_blocks_remaining: 20_000,
    }, () => sweepHnsNamespaceRevalidations({ client, env: testEnv(), now: NOW, config: CONFIG }))

    expect(summary.refreshed).toBe(1)
    const verification = await readVerification(client, namespaceVerificationId)
    expect(verification?.status).toBe("verified")
    expect(verification?.expires_at).toBe("2026-08-12T12:00:00.000Z")
    expect(Number(verification?.expiry_horizon_sufficient)).toBe(1)

    const assertion = await client.execute({
      sql: `
        SELECT assertion_value, status, last_revalidated_at
        FROM namespace_verification_assertions
        WHERE namespace_verification_id = ?1 AND assertion_name = 'expiry_horizon_sufficient'
      `,
      args: [namespaceVerificationId],
    })
    expect(assertion.rows[0]).toMatchObject({
      assertion_value: 1,
      status: "accepted",
      last_revalidated_at: NOW.toISOString(),
    })

    const evidence = await client.execute({
      sql: `
        SELECT provider, raw_response_json
        FROM namespace_verification_evidence_bundles
        WHERE namespace_verification_id = ?1 AND evidence_kind = 'revalidation_snapshot'
      `,
      args: [namespaceVerificationId],
    })
    expect(evidence.rows[0]?.provider).toBe("hsd_json_rpc")
    expect(JSON.parse(String(evidence.rows[0]?.raw_response_json))).toMatchObject({
      revalidation_outcome: "refreshed",
      previous_expires_at: FUTURE_EXPIRY,
      inspection: {
        expiry_root_exists: true,
        expiry_horizon_sufficient: true,
        expiry_observation_provider: "hsd_json_rpc",
      },
    })
  })

  test("derives restored capabilities from assertions changed after candidate selection", async () => {
    const client = await setup()
    const { namespaceVerificationId } = await seedAcceptedHnsVerification({ client })

    const summary = await withMockedFetch(
      () => async () => {
        await client.execute({
          sql: `
            UPDATE namespace_verification_assertions
            SET assertion_value = 0, status = 'stale', updated_at = ?2
            WHERE namespace_verification_id = ?1
              AND assertion_name = 'root_control_verified'
          `,
          args: [namespaceVerificationId, NOW.toISOString()],
        })
        return Response.json({
          expiry_root_exists: true,
          expiry_horizon_sufficient: true,
          expiry_observation_provider: "hsd_json_rpc",
        })
      },
      () => sweepHnsNamespaceRevalidations({ client, env: testEnv(), now: NOW, config: CONFIG }),
    )

    expect(summary.refreshed).toBe(1)
    expect(await readVerification(client, namespaceVerificationId)).toMatchObject({
      status: "verified",
      club_attach_allowed: 0,
      pirate_subdomain_issuance_allowed: 0,
    })
    const capabilities = await client.execute({
      sql: `
        SELECT capability_name, capability_value, status
        FROM namespace_verification_capabilities
        WHERE namespace_verification_id = ?1
          AND capability_name IN ('club_attach_allowed', 'pirate_subdomain_issuance_allowed')
        ORDER BY capability_name
      `,
      args: [namespaceVerificationId],
    })
    expect(capabilities.rows).toEqual([
      { capability_name: "club_attach_allowed", capability_value: 0, status: "stale" },
      { capability_name: "pirate_subdomain_issuance_allowed", capability_value: 0, status: "stale" },
    ])
  })

  test("withholds expiry-gated capabilities without extending a still-live lease", async () => {
    const client = await setup()
    const { namespaceVerificationId } = await seedAcceptedHnsVerification({ client })

    const summary = await withInspection({
      expiry_root_exists: true,
      expiry_horizon_sufficient: false,
      expiry_observation_provider: "hsd_json_rpc",
    }, () => sweepHnsNamespaceRevalidations({ client, env: testEnv(), now: NOW, config: CONFIG }))

    expect(summary.downgraded).toBe(1)
    const verification = await readVerification(client, namespaceVerificationId)
    expect(verification).toMatchObject({
      status: "verified",
      expires_at: FUTURE_EXPIRY,
      expiry_horizon_sufficient: 0,
      club_attach_allowed: 0,
      pirate_web_routing_allowed: 1,
      pirate_subdomain_issuance_allowed: 0,
    })

    const capabilities = await client.execute({
      sql: `
        SELECT capability_name, capability_value, status
        FROM namespace_verification_capabilities
        WHERE namespace_verification_id = ?1
        ORDER BY capability_name
      `,
      args: [namespaceVerificationId],
    })
    expect(capabilities.rows).toEqual([
      { capability_name: "club_attach_allowed", capability_value: 0, status: "stale" },
      { capability_name: "pirate_subdomain_issuance_allowed", capability_value: 0, status: "stale" },
      { capability_name: "pirate_web_routing_allowed", capability_value: 1, status: "accepted" },
    ])
  })

  test("immediately stales every capability when hsd proves the root is absent", async () => {
    const client = await setup()
    const { namespaceVerificationId } = await seedAcceptedHnsVerification({ client })

    const summary = await withInspection({
      expiry_root_exists: false,
      expiry_horizon_sufficient: false,
      expiry_observation_provider: "hsd_json_rpc",
    }, () => sweepHnsNamespaceRevalidations({ client, env: testEnv(), now: NOW, config: CONFIG }))

    expect(summary.staled).toBe(1)
    expect(await readVerification(client, namespaceVerificationId)).toMatchObject({
      status: "stale",
      root_exists: 0,
      club_attach_allowed: 0,
      pirate_web_routing_allowed: 0,
      pirate_subdomain_issuance_allowed: 0,
    })
    const capabilities = await client.execute({
      sql: `
        SELECT COUNT(*) AS count
        FROM namespace_verification_capabilities
        WHERE namespace_verification_id = ?1 AND (capability_value != 0 OR status != 'stale')
      `,
      args: [namespaceVerificationId],
    })
    expect(Number(capabilities.rows[0]?.count)).toBe(0)
  })

  test("backs off unknown observations while the ownership lease remains live", async () => {
    const client = await setup()
    const live = await seedAcceptedHnsVerification({ client, suffix: "live" })

    const deferred = await withInspection({
      expiry_root_exists: null,
      expiry_horizon_sufficient: null,
      expiry_observation_provider: null,
    }, () => sweepHnsNamespaceRevalidations({ client, env: testEnv(), now: NOW, config: CONFIG }))
    expect(deferred.deferred).toBe(1)
    expect(await readVerification(client, live.namespaceVerificationId)).toMatchObject({
      status: "verified",
      expires_at: FUTURE_EXPIRY,
    })
  })

  test("surfaces deferred observations that put a lease inside the next sweep interval", async () => {
    const client = await setup()
    await seedAcceptedHnsVerification({
      client,
      suffix: "near-expiry",
      expiresAt: "2026-07-14T06:00:00.000Z",
    })

    const summary = await withInspection({
      expiry_root_exists: null,
      expiry_horizon_sufficient: null,
      expiry_observation_provider: null,
    }, () => sweepHnsNamespaceRevalidations({ client, env: testEnv(), now: NOW, config: CONFIG }))

    expect(summary).toMatchObject({
      attempted: 1,
      deferred: 1,
      leasesApproachingExpiry: 1,
    })
    expect(hnsNamespaceRevalidationAlertState(summary)).toEqual({
      allDeferred: true,
      massDeferred: false,
      leaseExpiryRisk: true,
    })
  })

  test("classifies broad deferral without treating small partial batches as mass failures", () => {
    const baseSummary = {
      enabled: true,
      candidates: 10,
      attempted: 10,
      refreshed: 5,
      downgraded: 0,
      staled: 0,
      deferred: 5,
      leasesApproachingExpiry: 0,
      errors: 0,
      deadlineReached: false,
    }
    expect(hnsNamespaceRevalidationAlertState(baseSummary)).toEqual({
      allDeferred: false,
      massDeferred: true,
      leaseExpiryRisk: false,
    })
    expect(hnsNamespaceRevalidationAlertState({
      ...baseSummary,
      candidates: 4,
      attempted: 4,
      refreshed: 3,
      deferred: 1,
    })).toEqual({
      allDeferred: false,
      massDeferred: false,
      leaseExpiryRisk: false,
    })
  })

  test("never revives an expired ownership lease from expiry-only hsd evidence", async () => {
    const client = await setup()

    const expired = await seedAcceptedHnsVerification({ client, suffix: "expired", expiresAt: EXPIRED })
    const staled = await withInspection({
      expiry_root_exists: true,
      expiry_horizon_sufficient: true,
      expiry_observation_provider: "hsd_json_rpc",
    }, () => sweepHnsNamespaceRevalidations({ client, env: testEnv(), now: NOW, config: CONFIG }))
    expect(staled.staled).toBe(1)
    expect(await readVerification(client, expired.namespaceVerificationId)).toMatchObject({
      status: "stale",
      expires_at: EXPIRED,
      expiry_horizon_sufficient: 1,
    })

    const recoveryAttempt = await withInspection({
      expiry_root_exists: true,
      expiry_horizon_sufficient: true,
      expiry_observation_provider: "hsd_json_rpc",
    }, () => sweepHnsNamespaceRevalidations({ client, env: testEnv(), now: NOW, config: CONFIG }))
    expect(recoveryAttempt.candidates).toBe(0)
    expect(await readVerification(client, expired.namespaceVerificationId)).toMatchObject({ status: "stale" })
  })

  test("stops before starting another observation when its execution budget is exhausted", async () => {
    const client = await setup()
    await seedAcceptedHnsVerification({ client, suffix: "first" })
    await seedAcceptedHnsVerification({ client, suffix: "second" })
    let clockMs = 0

    const summary = await withMockedFetch(
      () => async () => {
        clockMs = 25_000
        return Response.json({
          expiry_root_exists: true,
          expiry_horizon_sufficient: true,
          expiry_observation_provider: "hsd_json_rpc",
        })
      },
      () => sweepHnsNamespaceRevalidations({
        client,
        env: testEnv(),
        now: NOW,
        config: CONFIG,
        clock: () => clockMs,
      }),
    )

    expect(summary).toMatchObject({
      candidates: 2,
      attempted: 1,
      refreshed: 1,
      deadlineReached: true,
    })
  })
})
