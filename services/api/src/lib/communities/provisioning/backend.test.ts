import { describe, expect, test } from "bun:test"
import {
  isD1NativeProvisioningSelected,
  resolveCommunityProvisioningBackend,
} from "./backend"
import type { Env } from "../../../env"
import type { ShardRpc } from "@pirate/api-shared"

// A truthy stand-in for the shard RPC binding; the resolver only checks presence.
const fakeShard = {} as unknown as ShardRpc

function buildEnv(overrides: Partial<Env> = {}): Env {
  return { ENVIRONMENT: "production", ...overrides } as Env
}

describe("resolveCommunityProvisioningBackend", () => {
  test("selects d1_native for a namespaceless request when the flag is set AND the shard binding exists", () => {
    const env = buildEnv({ COMMUNITY_PROVISION_BACKEND: "d1_native", COMMUNITY_D1_SHARD: fakeShard })
    expect(isD1NativeProvisioningSelected(env)).toBe(true)
    expect(resolveCommunityProvisioningBackend(env, { hasNamespace: false }).mode).toBe("d1_native")
  })

  test("routes a namespaced request to turso_operator even when the d1_native flag is set (v1 scope)", () => {
    // v1 of d1_native is namespaceless-only. Flipping the env flag must NOT
    // brick namespaced community creation — namespaced requests continue to
    // use the Turso operator path regardless of the d1_native flag, because
    // the namespace-attach path can't be routed to d1 today (the
    // upsertLocalNamespaceAttachment call site hits openCommunityDb which
    // fails on d1:// URLs).
    const env = buildEnv({ COMMUNITY_PROVISION_BACKEND: "d1_native", COMMUNITY_D1_SHARD: fakeShard })
    expect(resolveCommunityProvisioningBackend(env, { hasNamespace: true }).mode).toBe("turso_operator")
  })

  test("does NOT select d1_native when the flag is set but the shard binding is absent", () => {
    const env = buildEnv({ COMMUNITY_PROVISION_BACKEND: "d1_native" })
    expect(isD1NativeProvisioningSelected(env)).toBe(false)
    // Falls through to the operator path in a non-dev environment.
    expect(resolveCommunityProvisioningBackend(env, { hasNamespace: false }).mode).toBe("turso_operator")
  })

  test("ignores an unrelated COMMUNITY_PROVISION_BACKEND value (backwards compatible)", () => {
    const env = buildEnv({ COMMUNITY_PROVISION_BACKEND: "turso_operator", COMMUNITY_D1_SHARD: fakeShard })
    expect(isD1NativeProvisioningSelected(env)).toBe(false)
    expect(resolveCommunityProvisioningBackend(env, { hasNamespace: false }).mode).toBe("turso_operator")
  })

  test("default (no flag) keeps local_dev in a dev/test environment", () => {
    const env = buildEnv({ ENVIRONMENT: "test" })
    expect(resolveCommunityProvisioningBackend(env, { hasNamespace: false }).mode).toBe("local_dev")
  })
})

describe("d1NativeProvisioningBackend", () => {
  const env = buildEnv({
    COMMUNITY_PROVISION_BACKEND: "d1_native",
    COMMUNITY_D1_SHARD: fakeShard,
    COMMUNITY_D1_SHARD_REGION: "weur",
  })
  const backend = resolveCommunityProvisioningBackend(env, { hasNamespace: false })

  test("initialBinding produces a credential-free pending d1:// binding", () => {
    const binding = backend.initialBinding({ env, communityId: "cmt_d1", databaseRegion: null })
    expect(binding.provisioningMode).toBe("d1_native")
    expect(binding.databaseUrl).toBe("d1://pending-cmt_d1.invalid")
    expect(binding.requiresCredentials).toBe(false)
    expect(binding.organizationSlug).toBe("shard")
    expect(binding.location).toBe("weur")
  })

  test("initialBinding fails loud when no region is configured", () => {
    const noRegion = buildEnv({ COMMUNITY_PROVISION_BACKEND: "d1_native", COMMUNITY_D1_SHARD: fakeShard })
    expect(() =>
      resolveCommunityProvisioningBackend(noRegion, { hasNamespace: false }).initialBinding({
        env: noRegion,
        communityId: "cmt_d1",
        databaseRegion: null,
      }),
    ).toThrow(/COMMUNITY_D1_SHARD_REGION/)
  })

  test("provision fails loud until the shard pool + allocator RPC are wired", async () => {
    await expect(
      backend.provision({
        env,
        body: {} as never,
        auth: {} as never,
        communityId: "cmt_d1",
        namespaceVerificationId: null,
        routeSlug: null,
      }),
    ).rejects.toThrow(/not yet wired/)
  })
})
