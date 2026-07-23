import { afterEach, beforeEach, describe, expect, test } from "bun:test"
import { app } from "../../src/index"
import { createRouteTestContext, json, resetRuntimeCaches } from "../helpers"

let cleanup: (() => Promise<void>) | null = null

beforeEach(() => {
  resetRuntimeCaches()
})

afterEach(async () => {
  if (cleanup) {
    await cleanup()
    cleanup = null
  }
})

async function insertVerifiedHnsNamespace(input: {
  ctx: Awaited<ReturnType<typeof createRouteTestContext>>
  rootLabel: string
  pirateDnsAuthorityVerified?: number
  pirateWebRoutingAllowed?: number
  expiresAt?: string
  communityStatus?: "active" | "draft"
}) {
  const now = "2026-05-02T00:00:00.000Z"
  const expiresAt = input.expiresAt ?? "2999-01-01T00:00:00.000Z"
  await input.ctx.client.execute({
    sql: `
      INSERT INTO users (
        user_id, verification_state, verification_capabilities_json, created_at, updated_at
      ) VALUES (
        'usr_public_namespace_test', 'verified', '[]', ?1, ?1
      )
    `,
    args: [now],
  })
  await input.ctx.client.execute({
    sql: `
      INSERT INTO namespace_verification_sessions (
        namespace_verification_session_id, namespace_verification_id, user_id, family, submitted_root_label,
        normalized_root_label, status, expires_at, created_at, updated_at
      ) VALUES (
        'nvs_public_namespace_test', 'namespace_public_test', 'usr_public_namespace_test', 'hns', ?1,
        ?1, 'verified', ?2, ?2, ?2
      )
    `,
    args: [input.rootLabel, now],
  })
  await input.ctx.client.execute({
    sql: `
      INSERT INTO namespace_verifications (
        namespace_verification_id, source_namespace_verification_session_id, user_id, family, normalized_root_label,
        status, root_exists, root_control_verified, expiry_horizon_sufficient, routing_enabled,
        pirate_dns_authority_verified, club_attach_allowed, pirate_web_routing_allowed, pirate_subdomain_issuance_allowed,
        accepted_at, expires_at, created_at, updated_at
      ) VALUES (
        'namespace_public_test', 'nvs_public_namespace_test', 'usr_public_namespace_test', 'hns', ?1,
        'verified', 1, 1, 1, 1,
        ?2, 1, ?3, 1,
        ?4, ?5, ?4, ?4
      )
    `,
    args: [
      input.rootLabel,
      input.pirateDnsAuthorityVerified ?? 1,
      input.pirateWebRoutingAllowed ?? 1,
      now,
      expiresAt,
    ],
  })
  await input.ctx.client.execute({
    sql: `
      INSERT INTO communities (
        community_id, creator_user_id, display_name, membership_mode, status, provisioning_state,
        transfer_state, route_slug, namespace_verification_id, pending_namespace_verification_session_id, created_at, updated_at
      ) VALUES (
        'cmt_public_namespace_test', 'usr_public_namespace_test', 'Imported Root', 'request', ?1, 'active',
        'none', ?2, 'namespace_public_test', NULL,
        ?3, ?3
      )
    `,
    args: [input.communityStatus ?? "active", input.rootLabel, now],
  })
}

async function insertSecureRootDelegation(
  ctx: Awaited<ReturnType<typeof createRouteTestContext>>,
  rootLabel: string,
  observedAt = new Date(),
) {
  const observationId = `obs_${rootLabel}`
  await ctx.client.execute({
    sql: `
      INSERT INTO hns_root_parent_observations (
        parent_observation_id, normalized_root_label, outcome, provider,
        observed_delegation_security,
        parent_ds_matches_live_dnskey, authoritative_dnssec_valid, observed_at,
        earliest_rrsig_expires_at, created_at
      ) VALUES (?1, ?2, 'succeeded', 'test', 'secure', 1, 1, ?3, ?4, ?3)
    `,
    args: [
      observationId,
      rootLabel,
      observedAt.toISOString(),
      new Date(Date.now() + 86_400_000).toISOString(),
    ],
  })
  await ctx.client.execute({
    sql: `
      INSERT INTO hns_root_delegation_state (
        normalized_root_label, rollover_state, pending_evidence_kind,
        last_parent_observation_id, last_parent_observation_outcome,
        last_parent_observation_attempt_at, state_changed_at, created_at, updated_at
      ) VALUES (?1, 'none', NULL, ?2, 'succeeded', ?3, ?3, ?3, ?3)
    `,
    args: [rootLabel, observationId, observedAt.toISOString()],
  })
}

describe("public namespace routes", () => {
  test("resolves verified Pirate-routed HNS roots to their community", async () => {
    const ctx = await createRouteTestContext()
    cleanup = ctx.cleanup
    await insertVerifiedHnsNamespace({ ctx, rootLabel: "xn--pokmon-dva" })

    const response = await app.request("http://pirate.test/public-namespaces/xn--pokmon-dva", {}, ctx.env)
    expect(response.status).toBe(200)
    const body = await json(response) as {
      root_label: string
      namespace_verification: string
      community: { id: string; display_name: string; route_slug: string }
    }
    expect(body).toEqual({
      root_label: "xn--pokmon-dva",
      namespace_role: "primary",
      namespace_verification: "nv_namespace_public_test",
      community: {
        id: "com_cmt_public_namespace_test",
        display_name: "Imported Root",
        route_slug: "xn--pokmon-dva",
      },
    })
    expect(response.headers.get("cache-control")).toBe("public, max-age=60")
  })

  test("lists verified Pirate-routed HNS roots for HNS clients", async () => {
    const ctx = await createRouteTestContext()
    cleanup = ctx.cleanup
    await insertVerifiedHnsNamespace({ ctx, rootLabel: "xn--pokmon-dva" })

    const response = await app.request("http://pirate.test/public-namespaces", {}, ctx.env)
    expect(response.status).toBe(200)
    const body = await json(response) as {
      namespaces: Array<{ root_label: string; community: { route_slug: string } }>
    }
    expect(body.namespaces).toEqual([
      {
        root_label: "xn--pokmon-dva",
        namespace_role: "primary",
        namespace_verification: "nv_namespace_public_test",
        community: {
          id: "com_cmt_public_namespace_test",
          display_name: "Imported Root",
          route_slug: "xn--pokmon-dva",
        },
      },
    ])
  })

  test("resolves an independently verified HNS mirror to the primary community", async () => {
    const ctx = await createRouteTestContext()
    cleanup = ctx.cleanup
    await insertVerifiedHnsNamespace({ ctx, rootLabel: "pokemon" })
    const now = "2026-05-02T00:00:00.000Z"
    await ctx.client.execute({
      sql: `
        INSERT INTO namespace_verification_sessions (
          namespace_verification_session_id, namespace_verification_id, user_id, family,
          submitted_root_label, normalized_root_label, status, expires_at, created_at, updated_at
        ) VALUES (
          'nvs_public_mirror_test', 'namespace_public_mirror_test', 'usr_public_namespace_test', 'hns',
          'charizard', 'charizard', 'verified', '2999-01-01T00:00:00.000Z', ?1, ?1
        )
      `,
      args: [now],
    })
    await ctx.client.execute({
      sql: `
        INSERT INTO namespace_verifications (
          namespace_verification_id, source_namespace_verification_session_id, user_id, family,
          normalized_root_label, status, root_exists, root_control_verified,
          expiry_horizon_sufficient, routing_enabled, pirate_dns_authority_verified,
          club_attach_allowed, pirate_web_routing_allowed, pirate_subdomain_issuance_allowed,
          accepted_at, expires_at, created_at, updated_at
        ) VALUES (
          'namespace_public_mirror_test', 'nvs_public_mirror_test', 'usr_public_namespace_test', 'hns',
          'charizard', 'verified', 1, 1, 1, 1, 1, 1, 1, 1,
          ?1, '2999-01-01T00:00:00.000Z', ?1, ?1
        )
      `,
      args: [now],
    })
    await ctx.client.execute({
      sql: `
        INSERT INTO community_namespace_bindings (
          community_namespace_binding_id, community_id, namespace_verification_id,
          namespace_role, status, created_at, updated_at
        ) VALUES (
          'cnb_public_mirror_test', 'cmt_public_namespace_test',
          'namespace_public_mirror_test', 'mirror', 'active', ?1, ?1
        )
      `,
      args: [now],
    })

    const response = await app.request("http://pirate.test/public-namespaces/charizard", {}, ctx.env)
    expect(response.status).toBe(200)
    const body = await json(response) as {
      namespace_role: string
      community: { id: string; route_slug: string }
    }
    expect(body.namespace_role).toBe("mirror")
    expect(body.community).toEqual({
      id: "com_cmt_public_namespace_test",
      display_name: "Imported Root",
      route_slug: "charizard",
    })
  })

  test("does not resolve roots that are not delegated to Pirate DNS for web routing", async () => {
    const ctx = await createRouteTestContext()
    cleanup = ctx.cleanup
    await insertVerifiedHnsNamespace({
      ctx,
      rootLabel: "xn--pokmon-dva",
      pirateDnsAuthorityVerified: 0,
    })

    const response = await app.request("http://pirate.test/public-namespaces/xn--pokmon-dva", {}, ctx.env)
    expect(response.status).toBe(404)
  })

  test("does not resolve roots when Pirate web routing is not allowed", async () => {
    const ctx = await createRouteTestContext()
    cleanup = ctx.cleanup
    await insertVerifiedHnsNamespace({
      ctx,
      rootLabel: "xn--pokmon-dva",
      pirateWebRoutingAllowed: 0,
    })

    const response = await app.request("http://pirate.test/public-namespaces/xn--pokmon-dva", {}, ctx.env)
    expect(response.status).toBe(404)
  })

  test("does not resolve expired namespace verifications", async () => {
    const ctx = await createRouteTestContext()
    cleanup = ctx.cleanup
    await insertVerifiedHnsNamespace({
      ctx,
      rootLabel: "xn--pokmon-dva",
      expiresAt: "2000-01-01T00:00:00.000Z",
    })

    const response = await app.request("http://pirate.test/public-namespaces/xn--pokmon-dva", {}, ctx.env)
    expect(response.status).toBe(404)
  })

  test("root delegation gate fails closed when enabled without root state", async () => {
    const ctx = await createRouteTestContext({
      HNS_ROOT_DELEGATION_ROUTING_ENABLED: "true",
    })
    cleanup = ctx.cleanup
    await insertVerifiedHnsNamespace({ ctx, rootLabel: "dankmeme" })

    const response = await app.request(
      "http://pirate.test/public-namespaces/dankmeme",
      {},
      ctx.env,
    )
    expect(response.status).toBe(404)
  })

  test("root delegation gate routes only a secure fresh root", async () => {
    const ctx = await createRouteTestContext({
      HNS_ROOT_DELEGATION_ROUTING_ENABLED: "true",
    })
    cleanup = ctx.cleanup
    await insertVerifiedHnsNamespace({ ctx, rootLabel: "dankmeme" })
    await insertSecureRootDelegation(ctx, "dankmeme")

    const response = await app.request(
      "http://pirate.test/public-namespaces/dankmeme",
      {},
      ctx.env,
    )
    expect(response.status).toBe(200)
  })

  test("root delegation gate filters the public namespace list", async () => {
    const ctx = await createRouteTestContext({
      HNS_ROOT_DELEGATION_ROUTING_ENABLED: "true",
    })
    cleanup = ctx.cleanup
    await insertVerifiedHnsNamespace({ ctx, rootLabel: "dankmeme" })

    const withheldResponse = await app.request(
      "http://pirate.test/public-namespaces",
      {},
      ctx.env,
    )
    expect(withheldResponse.status).toBe(200)
    expect(await json(withheldResponse)).toEqual({ namespaces: [] })

    await insertSecureRootDelegation(ctx, "dankmeme")
    const routedResponse = await app.request(
      "http://pirate.test/public-namespaces",
      {},
      ctx.env,
    )
    expect(routedResponse.status).toBe(200)
    const body = await json(routedResponse) as {
      namespaces: Array<{ root_label: string }>
    }
    expect(body.namespaces.map((namespace) => namespace.root_label)).toEqual([
      "dankmeme",
    ])
  })

  test("root delegation gate rejects stale observations", async () => {
    const ctx = await createRouteTestContext({
      HNS_ROOT_DELEGATION_ROUTING_ENABLED: "true",
    })
    cleanup = ctx.cleanup
    await insertVerifiedHnsNamespace({ ctx, rootLabel: "dankmeme" })
    await insertSecureRootDelegation(
      ctx,
      "dankmeme",
      new Date(Date.now() - 901_000),
    )

    const response = await app.request(
      "http://pirate.test/public-namespaces/dankmeme",
      {},
      ctx.env,
    )
    expect(response.status).toBe(404)
  })
})
