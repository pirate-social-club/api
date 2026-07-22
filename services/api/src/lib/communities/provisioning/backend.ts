import { buildLocalCommunityDbUrl } from "../community-local-db"
import type { LocalCommunitySnapshot } from "../community-local-db"
import type {
  CommunityProvisioningMode,
  CommunityProvisioningRepository,
  InitialCommunityDatabaseBinding,
} from "../community-repository-types"
import {
  bootstrapCommunityLocalSnapshot,
  buildPendingD1CommunityBindingUrl,
  localCommunityShardStatements,
  resolveCommunityDbRoot,
} from "../create/repository"
import { HttpError, internalError } from "../../errors"
import type {
  CreateCommunityAuth,
  CreateCommunityRequestBody,
} from "../create/validation"
import type { Env } from "../../../env"
import { shouldUseLocalCommunityDb } from "../community-local-mode"

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
  communityRepository: CommunityProvisioningRepository
  /** DIAGNOSTIC-ONLY pool attribution; forwarded to the shard allocator. */
  allocationAttribution?: { source?: string | null; runId?: string | null }
}

type ProvisionedCommunityCredential = {
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

type ProvisionedCommunityDatabase = {
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

/**
 * Region label for a D1-native binding: the request's `database_region` if given,
 * else the env default. Required when D1-native is in use (the 0117 CHECK needs
 * `region` NOT NULL on d1 rows) — fail loud rather than write an invalid row.
 */
function resolveShardRegion(env: Env, requestedRegion?: string | null): string {
  const requested = String(requestedRegion ?? "").trim()
  const allowed = new Set(
    String(env.COMMUNITY_PROVISION_ALLOWED_GROUP_LOCATIONS || "")
      .split(",")
      .map((entry) => entry.trim())
      .filter(Boolean),
  )
  if (requested && requested !== "auto" && allowed.size > 0 && !allowed.has(requested)) {
    throw new HttpError(400, "bad_request", "database_region is not supported")
  }
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
      databaseName: `pending-${input.communityId}`,
      databaseId: null,
      databaseUrl: buildPendingD1CommunityBindingUrl(input.communityId),
      location: resolveShardRegion(input.env, input.databaseRegion),
      requiresCredentials: false,
      provisioningMode: "d1_native",
    }
  },
  /**
   * Step 4 of the D1-native workstream: the d1_native orchestrator. Allocates
   * a binding from the shard pool, loads the snapshot, and seeds the routing row
   * at 'ready'. The control plane no longer stores a separate database binding
   * row; the routing row is the authoritative D1 directory.
   *
   * Branches on raw `ShardResult` (`.ok` / `.code`) at every step, not via
   * throw+re-catch — each error code has a distinct recovery path that the
   * service's catch block can't easily reconstruct from a generic throw.
   * The unwrap helper is right for the DML read/write path (the consumer just
   * wants the value or a hard error); the orchestrator is the one case that
   * needs to inspect codes for control flow.
   */
  async provision(input: ProvisionInput): Promise<ProvisionedCommunityDatabase> {
    const communityId = input.communityId
    const now = new Date().toISOString()
    const initialBinding = this.initialBinding({
      env: input.env,
      communityId,
      databaseRegion: input.body.database_region,
    })
    const shard = input.env.COMMUNITY_D1_SHARD
    if (!shard) {
      throw internalError(
        "d1_native provisioning: COMMUNITY_D1_SHARD service binding is not configured on this Worker",
      )
    }

    // 1. Allocate a binding from the shard pool.
    const bindResult = await shard.communityD1Bind({
      communityId,
      now,
      source: input.allocationAttribution?.source ?? null,
      runId: input.allocationAttribution?.runId ?? null,
    })
    if (!bindResult.ok) {
      if (bindResult.code === "shard_pool_exhausted") {
        throw new HttpError(
          503,
          "d1_pool_exhausted",
          `d1_native provisioning failed: shard pool exhausted (${bindResult.message})`,
          true,
        )
      }
      if (bindResult.code === "shard_pool_write_conflict") {
        // The allocator's internal retries are exhausted. The
        // resolveProvisioningRetryAction path will retry on a subsequent
        // community_create for the same communityId; surface as a transient
        // provisioning failure here.
        throw new HttpError(
          503,
          "d1_pool_write_conflict",
          `d1_native provisioning failed: shard pool allocator exhausted retries (${bindResult.message})`,
          true,
        )
      }
      throw internalError(
        `d1_native provisioning failed: shard communityD1Bind returned ${bindResult.code}: ${bindResult.message}`,
      )
    }
    const { bindingName, shardWorkerId, allocated } = bindResult.value
    if (!allocated) {
      // createNamespacelessCommunity always uses a fresh communityId, so
      // the idempotency check on the shard always finds no row. If the shard
      // ever returns allocated: false here, the create flow is being called
      // twice for the same communityId without an intermediate
      // markCommunityProvisioningSucceeded — that's an orchestrator bug.
      throw internalError(
        `d1_native provisioning: shard bind returned allocated=false for fresh communityId ${communityId}`,
      )
    }

    // 2. Load the schema + data into the allocated binding (§8.7). The
    //    statements are the bundled final-form community schema + a
    //    schema_migrations seed + the community data seed (the SAME pure
    //    generator the operator path uses — no drift). All CREATE/INSERT, so
    //    guard-compatible. On success the binding is marked loaded and the
    //    routing row flips to 'ready'.
    const loadResult = await shard.communityD1LoadSnapshot({
      communityId,
      bindingName,
      statements: localCommunityShardStatements({
        env: input.env,
        body: input.body,
        auth: input.auth,
        communityId,
        namespaceVerificationId: input.namespaceVerificationId,
        namespaceLabel: input.routeSlug,
      }),
    })
    if (!loadResult.ok) {
      if (loadResult.code === "shard_binding_not_allocated") {
        // The binding was released between bind and load (a concurrent
        // reconciler ran). The reconciler (§6) handles cleanup; the
        // orchestrator surfaces this as a transient provisioning failure.
        throw new HttpError(
          503,
          "d1_binding_not_allocated",
          `d1_native provisioning failed: binding ${bindingName} was released during load (${loadResult.message})`,
          true,
        )
      }
      if (loadResult.code === "shard_write_not_allowed") {
        // The bootstrap guard allows only CREATE/INSERT; the §8.7 translator
        // (localCommunityShardStatements) emits only those, so this firing means
        // a guard or translator bug (e.g. a template migration introduced a verb
        // the final-schema dump didn't reduce to CREATE).
        throw internalError(
          `d1_native provisioning failed: bootstrap guard rejected load (${loadResult.message})`,
        )
      }
      throw internalError(
        `d1_native provisioning failed: shard communityD1LoadSnapshot returned ${loadResult.code}: ${loadResult.message}`,
      )
    }

    // 3. Seed the routing row at 'ready'. Any concurrent routed read sees a
    //    consistent (binding-name, routing-state) pair from this row alone.
    await input.communityRepository.upsertD1CommunityRoutingRow({
      communityId,
      shardWorkerId,
      bindingName,
      region: initialBinding.location as string,
      now,
      provisioningState: "ready",
    })

    const databaseUrl = `d1://shard/${bindingName}`

    return {
      mode: "d1_native",
      binding: {
        organizationSlug: initialBinding.organizationSlug,
        groupName: initialBinding.groupName,
        groupId: initialBinding.groupId,
        databaseName: bindingName,
        databaseId: null,
        databaseUrl,
        location: initialBinding.location,
        requiresCredentials: false,
        provisioningMode: "d1_native",
      },
      credential: null,
      localSnapshot: null,
    }
  },
}

/** True when D1-native provisioning has the required shard binding. */
export function isD1NativeProvisioningSelected(env: Env): boolean {
  return Boolean(env.COMMUNITY_D1_SHARD)
}

export type ProvisioningRequestShape = {
  /** True if the create call carries a namespaceVerificationId. */
  hasNamespace: boolean
}

export function resolveCommunityProvisioningBackend(
  env: Env,
  _request: ProvisioningRequestShape,
): CommunityProvisioningBackend {
  if (shouldUseLocalCommunityDb(env)) {
    return localDevProvisioningBackend
  }
  return d1NativeProvisioningBackend
}
