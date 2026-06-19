import { buildLocalCommunityDbUrl } from "../community-local-db"
import type { LocalCommunitySnapshot } from "../community-local-db"
import type {
  CommunityProvisioningMode,
  InitialCommunityDatabaseBinding,
} from "../community-repository-types"
import {
  bootstrapCommunityLocalSnapshot,
  buildPendingCommunityDatabaseUrl,
  buildPendingD1CommunityBindingUrl,
  buildProvisionOperatorBootstrapPayload,
  resolveCommunityDbRoot,
  resolveCommunityProvisionGroupLocation,
} from "../create/repository"
import { internalError, notImplementedError } from "../../errors"
import type {
  CreateCommunityAuth,
  CreateCommunityRequestBody,
} from "../create/validation"
import type { Env } from "../../../env"
import {
  isCommunityProvisionOperatorConfigured,
  provisionCommunityViaOperator,
} from "./operator-client"

type BindingInput = {
  env: Env
  communityId: string
  databaseRegion?: string | null
}

type ProvisionInput = {
  env: Env
  body: CreateCommunityRequestBody
  auth: CreateCommunityAuth
  communityId: string
  namespaceVerificationId: string | null
  routeSlug: string | null
}

export type ProvisionedCommunityCredential = {
  credentialId: string
  organizationSlug: string
  groupName: string
  groupId: string | null
  databaseName: string
  databaseId: string | null
  databaseUrl: string
  location: string | null
  tokenName: string
  plaintextToken: string
  issuedAt: string
  expiresAt: string | null
}

export type ProvisionedCommunityDatabase = {
  mode: CommunityProvisioningMode
  binding: InitialCommunityDatabaseBinding
  credential: ProvisionedCommunityCredential | null
  localSnapshot: LocalCommunitySnapshot | null
}

export type CommunityProvisioningBackend = {
  mode: CommunityProvisioningMode
  initialBinding(input: BindingInput): InitialCommunityDatabaseBinding
  provision(input: ProvisionInput): Promise<ProvisionedCommunityDatabase>
}

const localDevProvisioningBackend: CommunityProvisioningBackend = {
  mode: "local_dev",
  initialBinding(input) {
    return {
      organizationSlug: "local-dev",
      groupName: `club-${input.communityId}`,
      groupId: null,
      databaseName: "main",
      databaseId: null,
      databaseUrl: buildLocalCommunityDbUrl(resolveCommunityDbRoot(input.env), input.communityId),
      location: "local",
      requiresCredentials: false,
      provisioningMode: "local_dev",
    }
  },
  async provision(input) {
    const binding = this.initialBinding({
      env: input.env,
      communityId: input.communityId,
      databaseRegion: input.body.database_region,
    })
    const localSnapshot = await bootstrapCommunityLocalSnapshot({
      env: input.env,
      body: input.body,
      auth: input.auth,
      communityId: input.communityId,
      namespaceVerificationId: input.namespaceVerificationId,
      namespaceLabel: input.routeSlug,
    })
    return {
      mode: "local_dev",
      binding,
      credential: null,
      localSnapshot,
    }
  },
}

const tursoOperatorProvisioningBackend: CommunityProvisioningBackend = {
  mode: "turso_operator",
  initialBinding(input) {
    return {
      organizationSlug: "pending",
      groupName: `club-${input.communityId}`,
      groupId: null,
      databaseName: "main",
      databaseId: null,
      databaseUrl: buildPendingCommunityDatabaseUrl(input.communityId),
      location: resolveCommunityProvisionGroupLocation(input.env, input.databaseRegion),
      requiresCredentials: true,
      provisioningMode: "turso_operator",
    }
  },
  async provision(input) {
    const binding = this.initialBinding({
      env: input.env,
      communityId: input.communityId,
      databaseRegion: input.body.database_region,
    })
    const provisioned = await provisionCommunityViaOperator({
      env: input.env,
      communityId: input.communityId,
      creatorUserId: input.auth.userId,
      displayName: input.auth.communityDisplayName,
      namespaceVerificationId: input.namespaceVerificationId,
      groupLocation: binding.location ?? resolveCommunityProvisionGroupLocation(input.env, input.body.database_region),
      bootstrapPayload: buildProvisionOperatorBootstrapPayload(input.body, input.routeSlug),
    })
    return {
      mode: "turso_operator",
      binding: {
        organizationSlug: provisioned.organizationSlug,
        groupName: provisioned.groupName,
        groupId: provisioned.groupId,
        databaseName: provisioned.databaseName,
        databaseId: provisioned.databaseId,
        databaseUrl: provisioned.databaseUrl,
        location: provisioned.location,
        requiresCredentials: true,
        provisioningMode: "turso_operator",
      },
      credential: {
        credentialId: provisioned.credentialId,
        organizationSlug: provisioned.organizationSlug,
        groupName: provisioned.groupName,
        groupId: provisioned.groupId,
        databaseName: provisioned.databaseName,
        databaseId: provisioned.databaseId,
        databaseUrl: provisioned.databaseUrl,
        location: provisioned.location,
        tokenName: provisioned.tokenName,
        plaintextToken: provisioned.plaintextToken,
        issuedAt: provisioned.issuedAt,
        expiresAt: provisioned.expiresAt,
      },
      localSnapshot: null,
    }
  },
}

/**
 * D1-native provisioning backend: new communities are born on D1 (a binding is
 * allocated 1:1 from the shard pool and the local snapshot is loaded into it),
 * with the `community_database_routing` row seeded `backend='d1'` from the start
 * — no later `flip-community-to-d1` step.
 *
 * `initialBinding` is complete; `provision()` is intentionally NOT wired yet — it
 * requires the shard-side pool + allocator RPC (`communityD1Bind` / snapshot-load),
 * which do not exist on `ShardRpc` today. It fails loud (notImplementedError)
 * rather than silently falling back, matching the spec's fail-closed stance. The
 * resolver below only selects this backend behind an explicit opt-in env flag, so
 * the throw is unreachable until ops both set the flag AND ship the shard pool.
 */
/**
 * Region label for a D1-native binding: the request's `database_region` if given,
 * else the env default. Required when D1-native is in use (the 0117 CHECK needs
 * `region` NOT NULL on d1 rows) — fail loud rather than write an invalid row.
 */
function resolveShardRegion(env: Env, requestedRegion?: string | null): string {
  const requested = String(requestedRegion ?? "").trim()
  const resolved = requested && requested !== "auto" ? requested : String(env.COMMUNITY_D1_SHARD_REGION ?? "").trim()
  if (!resolved) {
    throw internalError("COMMUNITY_D1_SHARD_REGION is not configured")
  }
  return resolved
}

const d1NativeProvisioningBackend: CommunityProvisioningBackend = {
  mode: "d1_native",
  initialBinding(input) {
    return {
      organizationSlug: "shard",
      groupName: "shard",
      groupId: null,
      databaseName: "pending",
      databaseId: null,
      databaseUrl: buildPendingD1CommunityBindingUrl(input.communityId),
      location: resolveShardRegion(input.env, input.databaseRegion),
      requiresCredentials: false,
      provisioningMode: "d1_native",
    }
  },
  async provision() {
    throw notImplementedError(
      "d1_native provisioning is not yet wired: the shard pool + allocator RPC are required",
    )
  },
}

/** True when D1-native provisioning is explicitly opted in AND the shard binding exists. */
export function isD1NativeProvisioningSelected(env: Env): boolean {
  return String(env.COMMUNITY_PROVISION_BACKEND ?? "").trim() === "d1_native" && Boolean(env.COMMUNITY_D1_SHARD)
}

/**
 * Per-request shape passed to the resolver. v1 narrows the d1_native path
 * to namespaceless creates only (§7 of D1-NATIVE-PROVISIONING-DESIGN.md):
 * the namespace-attach path can't be routed to d1 today, so a namespaced
 * request must resolve to the Turso operator path even when the d1_native
 * env flag is set. Without this guard, flipping the flag on would brick
 * namespaced community creation globally.
 */
export type ProvisioningRequestShape = {
  /** True if the create call carries a namespaceVerificationId (i.e. it
   * routes through provisionNamespacedCommunity). False for namespaceless
   * creates (createNamespacelessCommunity). */
  hasNamespace: boolean
}

export function resolveCommunityProvisioningBackend(
  env: Env,
  request: ProvisioningRequestShape,
): CommunityProvisioningBackend {
  // v1: d1_native is namespaceless-only. Namespaced requests always go
  // through the existing Turso path regardless of the d1_native flag,
  // because the namespace-attach path can't be routed to d1 today.
  if (!request.hasNamespace && isD1NativeProvisioningSelected(env)) {
    return d1NativeProvisioningBackend
  }
  return isCommunityProvisionOperatorConfigured(env)
    ? tursoOperatorProvisioningBackend
    : localDevProvisioningBackend
}
