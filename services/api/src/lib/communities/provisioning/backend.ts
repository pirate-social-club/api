import { buildLocalCommunityDbUrl } from "../community-local-db"
import type { LocalCommunitySnapshot } from "../community-local-db"
import type {
  CommunityProvisioningMode,
  CommunityProvisioningRepository,
  InitialCommunityDatabaseBinding,
} from "../community-repository-types"
import {
  bootstrapCommunityLocalSnapshot,
  buildPendingCommunityDatabaseUrl,
  buildPendingD1CommunityBindingUrl,
  buildProvisionOperatorBootstrapPayload,
  localCommunityShardStatements,
  resolveCommunityDbRoot,
  resolveCommunityProvisionGroupLocation,
} from "../create/repository"
import { HttpError, internalError } from "../../errors"
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
  /**
   * d1_native orchestrator uses this to seed the routing row at 'ready' and
   * to persist the resolved d1 binding URL (gap 1 — see D1-NATIVE-PROVISIONING-DESIGN.md
   * §3, §4). Unused by the local_dev / turso_operator backends.
   */
  communityRepository: CommunityProvisioningRepository
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
   * a binding from the shard pool, loads the snapshot (idempotent no-op for
   * v1 — the schema is in the binding's pre-applied migrations, the data load
   * is a follow-up slice), seeds the routing row at 'ready', and persists the
   * resolved d1:// URL on the binding row.
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
      // Resolver selects d1_native only when COMMUNITY_D1_SHARD is bound
      // (per isD1NativeProvisioningSelected), so this is unreachable in
      // practice. Fail loud rather than silently fall back.
      throw internalError(
        "d1_native provisioning: COMMUNITY_D1_SHARD service binding is not configured on this Worker",
      )
    }

    // 1. Allocate a binding from the shard pool.
    const bindResult = await shard.communityD1Bind({ communityId, now })
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

    // 3. Seed the routing row at 'ready' (the §8.1 acceptance criterion:
    //    a community_database_routing row at backend='d1', state='ready').
    //    Bumping the routing row happens BEFORE persistProvisionedD1Binding
    //    so that any concurrent routed read sees a consistent
    //    (binding-name, routing-state) pair.
    await input.communityRepository.upsertD1CommunityRoutingRow({
      communityId,
      shardWorkerId,
      bindingName,
      region: initialBinding.location as string,
      now,
      provisioningState: "ready",
    })

    // 4. Persist the resolved d1:// URL on the binding row, replacing the
    //    d1://pending-<communityId>.invalid sentinel written at create time
    //    (gap 1 of the prior audit, fixed in PR #57 slice 3). The binding ID
    //    is the one createCommunityProvisioningRequest generated; we look it
    //    up rather than threading it through ProvisionInput.
    const databaseUrl = `d1://shard/${bindingName}`
    const bindingRow = await input.communityRepository.getPrimaryCommunityDatabaseBinding(communityId)
    if (!bindingRow) {
      // createCommunityProvisioningRequest just inserted this row; if it's
      // gone, something deleted it. Fail loud.
      throw internalError(
        `d1_native provisioning: binding row for communityId ${communityId} is missing after createCommunityProvisioningRequest`,
      )
    }
    await input.communityRepository.persistProvisionedD1Binding({
      communityDatabaseBindingId: bindingRow.community_database_binding_id,
      bindingName,
      databaseUrl,
      region: initialBinding.location as string,
      updatedAt: now,
    })

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

/** True when D1-native provisioning is explicitly opted in AND the shard binding exists. */
export function isD1NativeProvisioningSelected(env: Env): boolean {
  return String(env.COMMUNITY_PROVISION_BACKEND ?? "").trim() === "d1_native" && Boolean(env.COMMUNITY_D1_SHARD)
}

export type ProvisioningRequestShape = {
  /** True if the create call carries a namespaceVerificationId. */
  hasNamespace: boolean
}

export function resolveCommunityProvisioningBackend(
  env: Env,
  _request: ProvisioningRequestShape,
): CommunityProvisioningBackend {
  if (isD1NativeProvisioningSelected(env)) {
    return d1NativeProvisioningBackend
  }
  return isCommunityProvisionOperatorConfigured(env)
    ? tursoOperatorProvisioningBackend
    : localDevProvisioningBackend
}
