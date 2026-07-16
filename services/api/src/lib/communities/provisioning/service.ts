import { normalizeCommunityMediaRef } from "../community-identity-media"
import { resolveCommunityProvisioningBackend } from "./backend"
import type { UserRepository } from "../../auth/repositories"
import type { CommunityRow, JobRow } from "../../auth/auth-db-rows"
import type {
  CommunityDatabaseBindingRepository,
  CommunityJobReadRepository,
  CommunityMembershipProjectionRepository,
  CommunityMutationRepository,
  CommunityProvisioningRepository,
  CommunityReadRepository,
} from "../db-community-repository"
import type {
  CommunityNamespaceRole,
  CommunityProvisioningMode,
} from "../community-repository-types"
import { eligibilityFailed, internalError, notFoundError } from "../../errors"
import { makeId, nowIso } from "../../helpers"
import { withTransaction } from "../../transactions"
import type { VerificationRepository } from "../../verification/verification-repository"
import { createNamespaceVerificationTask, resolveNamespaceVerificationTask } from "../../notifications/notification-task-service"
import type {
  Community,
  CommunityCreateAcceptedResponse,
  Env,
  NamespaceVerification,
} from "../../../types"
import { serializeCommunity, serializeJob } from "../community-serialization"
import { serializeCommunityCreateAcceptedResponse } from "../../../serializers/community"
import { openCommunityWriteClient } from "../community-read-access"
import {
  isExpired,
  loadCommunityLocalSnapshot,
  loadCommunityProjection,
  requireOwnedCommunity,
  resolveProvisioningRetryAction,
} from "../create/repository"
import {
  type CreateCommunityAuth,
  type CreateCommunityRequestBody,
  resolveCreateCommunityAuth,
} from "../create/validation"
import { assertGatePolicyContractsValid } from "../membership/gate-policy-contract-validation"
import type { GatePolicy } from "../membership/gate-types"
import { HttpError } from "../../errors"

type CommunityProvisioningServiceRepository =
  & CommunityReadRepository
  & CommunityDatabaseBindingRepository
  & CommunityJobReadRepository
  & CommunityProvisioningRepository
  & CommunityMembershipProjectionRepository
  & CommunityMutationRepository

function namespaceRouteSlug(namespaceVerification: Pick<NamespaceVerification, "family" | "normalized_root_label">): string {
  return namespaceVerification.family === "spaces"
    ? `@${namespaceVerification.normalized_root_label}`
    : namespaceVerification.normalized_root_label
}

function isSameNamespaceRoot(
  left: Pick<NamespaceVerification, "family" | "normalized_root_label">,
  right: Pick<NamespaceVerification, "family" | "normalized_root_label">,
): boolean {
  return left.family === right.family && left.normalized_root_label === right.normalized_root_label
}

function provisioningFailureErrorCode(mode: CommunityProvisioningMode): string {
  switch (mode) {
    case "d1_native":
      return "d1_native_provision_failed"
    default:
      return "local_dev_bootstrap_failed"
  }
}

function communityProvisioningFailureDetails(
  error: unknown,
  mode: CommunityProvisioningMode,
): Record<string, unknown> {
  const details: Record<string, unknown> = {
    mode,
    cause: error instanceof Error ? error.message : String(error),
  }

  if (error instanceof HttpError) {
    details["error_code"] = error.code
    details["error_status"] = error.status
    if (error.details) {
      details["cause_details"] = error.details
    }
  }

  return details
}

function communityProvisioningFailureError(input: {
  error: unknown
  mode: CommunityProvisioningMode
  communityId: string
  jobId: string
}): HttpError {
  const details = {
    ...communityProvisioningFailureDetails(input.error, input.mode),
    community_id: input.communityId,
    job_id: input.jobId,
  }

  if (input.error instanceof HttpError) {
    return new HttpError(
      input.error.status,
      input.error.code,
      input.error.message,
      input.error.retryable,
      {
        ...(input.error.details ?? {}),
        ...details,
      },
    )
  }

  return internalError("Community provisioning failed", details)
}

async function upsertLocalNamespaceAttachment(input: {
  env: Env
  repo: CommunityDatabaseBindingRepository
  communityId: string
  namespaceVerificationId: string
  namespaceRole: CommunityNamespaceRole
  namespaceLabel: string
  now: string
}): Promise<void> {
  const db = await openCommunityWriteClient(input.env, input.repo, input.communityId)
  const namespaceKey = input.namespaceRole === "primary"
    ? input.communityId
    : input.namespaceVerificationId
  const namespaceId = `ns_${namespaceKey}`
  const namespaceHandlePolicyId = `nhp_${namespaceKey}`

  try {
    await withTransaction(db.client, "write", async (tx) => {
      await tx.execute({
        sql: `
          INSERT INTO namespace_bindings (
            namespace_id, community_id, namespace_verification_id, display_label, normalized_label,
            resolver_label, route_family, status, created_at, updated_at, namespace_role
          ) VALUES (
            ?1, ?2, ?3, ?4, ?5, NULL, NULL, 'active', ?6, ?6, ?7
          )
          ON CONFLICT(namespace_id) DO UPDATE SET
            namespace_verification_id = excluded.namespace_verification_id,
            display_label = excluded.display_label,
            normalized_label = excluded.normalized_label,
            namespace_role = excluded.namespace_role,
            status = excluded.status,
            updated_at = excluded.updated_at
        `,
        args: [
          namespaceId,
          input.communityId,
          input.namespaceVerificationId,
          input.namespaceLabel,
          input.namespaceLabel.toLowerCase(),
          input.now,
          input.namespaceRole,
        ],
      })

      await tx.execute({
        sql: `
          INSERT INTO namespace_handle_policies (
            namespace_handle_policy_id, community_id, namespace_id, policy_template, pricing_model,
            membership_required_for_claim, claims_enabled, settings_json, created_at, updated_at
          ) VALUES (
            ?1, ?2, ?3, 'premium', 'flat_by_length', 1, 1, ?4, ?5, ?5
          )
          ON CONFLICT(namespace_handle_policy_id) DO UPDATE SET
            namespace_id = excluded.namespace_id,
            membership_required_for_claim = excluded.membership_required_for_claim,
            claims_enabled = excluded.claims_enabled,
            updated_at = excluded.updated_at
        `,
        args: [
          namespaceHandlePolicyId,
          input.communityId,
          namespaceId,
          JSON.stringify({
            flat_price_cents: 500,
            premium_price_cents: 2500,
            premium_max_length: 4,
            min_length: 3,
            max_length: 32,
            special_price_cents_by_label: {
              crown: 100000,
              "xn--2p8h": 100000,
              prince: 50000,
              "xn--tq9h": 50000,
              princess: 50000,
              "xn--6q8h": 50000,
              diamond: 75000,
              "xn--tr8h": 75000,
              ring: 50000,
              "xn--sr8h": 50000,
              "xn--cs8h": 50000,
              "xn--cz8h": 25000,
            },
          }),
          input.now,
        ],
      })

    })
  } finally {
    db.close()
  }
}

async function createNamespacelessCommunity(input: {
  env: Env
  body: CreateCommunityRequestBody
  auth: CreateCommunityAuth
  communityRepository: CommunityProvisioningServiceRepository
}): Promise<CommunityCreateAcceptedResponse> {
  const communityId = makeId("cmt")
  const bindingId = makeId("cdb")
  const jobId = makeId("job")
  const backend = resolveCommunityProvisioningBackend(input.env, { hasNamespace: false })
  const initialBinding = backend.initialBinding({
    env: input.env,
    communityId,
    databaseRegion: input.body.database_region,
  })
  const prepared = await input.communityRepository.createCommunityProvisioningRequest({
    communityId,
    communityDatabaseBindingId: bindingId,
    jobId,
    creatorUserId: input.auth.userId,
    displayName: input.auth.communityDisplayName,
    description: input.body.description?.trim() || null,
    avatarRef: normalizeCommunityMediaRef(input.body.avatar_ref),
    bannerRef: normalizeCommunityMediaRef(input.body.banner_ref),
    membershipMode: input.body.membership_mode ?? "gated",
    namespaceVerificationId: null,
    routeSlug: null,
    binding: initialBinding,
    createdAt: input.auth.createdAt,
  })

  try {
    const provisioned = await backend.provision({
      env: input.env,
      body: input.body,
      auth: input.auth,
      communityId,
      namespaceVerificationId: null,
      routeSlug: null,
      communityRepository: input.communityRepository,
    })
    const localSnapshot = provisioned.localSnapshot
      ?? await loadCommunityLocalSnapshot(input.env, input.communityRepository, communityId)
    const databaseUrl = provisioned.binding.databaseUrl

    const finalized = await input.communityRepository.markCommunityProvisioningSucceeded({
      communityId,
      communityDatabaseBindingId: prepared.binding.community_database_binding_id,
      jobId: prepared.job.job_id,
      actorUserId: input.auth.userId,
      resultRef: databaseUrl,
      description: localSnapshot?.description ?? input.body.description?.trim() ?? null,
      avatarRef: localSnapshot?.avatar_ref ?? normalizeCommunityMediaRef(input.body.avatar_ref),
      bannerRef: localSnapshot?.banner_ref ?? normalizeCommunityMediaRef(input.body.banner_ref),
      createdAt: input.auth.createdAt,
      metadata: {
        binding_id: prepared.binding.community_database_binding_id,
        database_url: databaseUrl,
        mode: provisioned.mode,
      },
    })

    await input.communityRepository.upsertCommunityMembershipProjection({
      communityId,
      userId: input.auth.userId,
      membershipState: "member",
      sourceUpdatedAt: input.auth.createdAt,
      createdAt: input.auth.createdAt,
    })

    try {
      await createNamespaceVerificationTask({
        env: input.env,
        userId: input.auth.userId,
        communityId,
        communityDisplayName: input.auth.communityDisplayName,
      })
    } catch (error) {
      console.error("[community-provisioning] namespace verification task creation failed", {
        communityId,
        error,
      })
    }

    return serializeCommunityCreateAcceptedResponse({
      community: serializeCommunity(input.env, finalized.community, localSnapshot),
      job: serializeJob(finalized.job),
    })
  } catch (error) {
    await input.communityRepository.markCommunityProvisioningFailed({
      communityId,
      jobId: prepared.job.job_id,
      actorUserId: input.auth.userId,
      errorCode: provisioningFailureErrorCode(backend.mode),
      createdAt: nowIso(),
      metadata: {
        binding_id: prepared.binding.community_database_binding_id,
        database_url: prepared.binding.database_url,
        message: error instanceof Error ? error.message : String(error),
      },
    }).catch((markFailedError) => {
      console.error("[community-provisioning] failed to persist provisioning failure", {
        communityId,
        jobId: prepared.job.job_id,
        error: markFailedError,
      })
    })

    throw communityProvisioningFailureError({
      error,
      mode: backend.mode,
      communityId,
      jobId: prepared.job.job_id,
    })
  }
}

async function provisionNamespacedCommunity(input: {
  env: Env
  body: CreateCommunityRequestBody
  auth: CreateCommunityAuth
  existingCommunity: CommunityRow | null
  namespaceVerificationId: string
  namespaceVerification: Pick<NamespaceVerification, "family" | "normalized_root_label">
  communityRepository: CommunityProvisioningServiceRepository
}): Promise<CommunityCreateAcceptedResponse> {
  const { env, body, auth, existingCommunity, namespaceVerificationId, namespaceVerification, communityRepository: repo } = input
  const routeSlug = namespaceRouteSlug(namespaceVerification)
  const communityId = existingCommunity?.community_id ?? makeId("cmt")
  const bindingId = makeId("cdb")
  const jobId = makeId("job")
  const backend = resolveCommunityProvisioningBackend(env, { hasNamespace: true })
  const initialBinding = backend.initialBinding({
    env,
    communityId,
    databaseRegion: body.database_region,
  })

  const prepared = await (async () => {
    return existingCommunity
      ? repo.retryCommunityProvisioningRequest({
          communityId,
          fallbackBindingId: bindingId,
          jobId,
          namespaceVerificationId,
          routeSlug,
          binding: initialBinding,
          createdAt: auth.createdAt,
        })
      : repo.createCommunityProvisioningRequest({
          communityId,
          communityDatabaseBindingId: bindingId,
          jobId,
          creatorUserId: auth.userId,
          displayName: auth.communityDisplayName,
          description: body.description?.trim() || null,
          avatarRef: normalizeCommunityMediaRef(body.avatar_ref),
          bannerRef: normalizeCommunityMediaRef(body.banner_ref),
          membershipMode: body.membership_mode ?? "gated",
          namespaceVerificationId,
          routeSlug,
          binding: initialBinding,
          createdAt: auth.createdAt,
        })
  })()

  let provisioningCompleted = false
  let provisioningFinalized: { community: CommunityRow; job: JobRow } | null = null
  let localSnapshot: Awaited<ReturnType<typeof loadCommunityLocalSnapshot>> = null

  try {
    const provisioned = await backend.provision({
      env,
      body,
      auth,
      communityId,
      namespaceVerificationId,
      routeSlug,
      communityRepository: repo,
    })
    localSnapshot = provisioned.localSnapshot ?? await loadCommunityLocalSnapshot(env, repo, communityId)
    const databaseUrl = provisioned.binding.databaseUrl

    provisioningFinalized = await repo.markCommunityProvisioningSucceeded({
      communityId,
      communityDatabaseBindingId: prepared.binding.community_database_binding_id,
      jobId: prepared.job.job_id,
      actorUserId: auth.userId,
      resultRef: databaseUrl,
      description: localSnapshot?.description ?? body.description?.trim() ?? null,
      avatarRef: localSnapshot?.avatar_ref ?? normalizeCommunityMediaRef(body.avatar_ref),
      bannerRef: localSnapshot?.banner_ref ?? normalizeCommunityMediaRef(body.banner_ref),
      createdAt: auth.createdAt,
      metadata: {
        binding_id: prepared.binding.community_database_binding_id,
        database_url: databaseUrl,
        mode: provisioned.mode,
      },
    })
    provisioningCompleted = true

    return serializeCommunityCreateAcceptedResponse({
      community: serializeCommunity(input.env, provisioningFinalized.community, localSnapshot),
      job: serializeJob(provisioningFinalized.job),
    })
  } catch (error) {
    const failedAt = nowIso()

    if (!provisioningCompleted) {
      await repo.markCommunityProvisioningFailed({
        communityId,
        jobId: prepared.job.job_id,
        actorUserId: auth.userId,
        errorCode: provisioningFailureErrorCode(backend.mode),
        createdAt: failedAt,
        metadata: {
          binding_id: prepared.binding.community_database_binding_id,
          database_url: prepared.binding.database_url,
          message: error instanceof Error ? error.message : String(error),
        },
      }).catch((markFailedError) => {
        console.error("[community-provisioning] failed to persist retry provisioning failure", {
          communityId,
          jobId: prepared.job.job_id,
          error: markFailedError,
        })
      })

      throw communityProvisioningFailureError({
        error,
        mode: backend.mode,
        communityId,
        jobId: prepared.job.job_id,
      })
    }

    const communityRow = await repo.getCommunityById(communityId)
    if (!communityRow || !provisioningFinalized) {
      throw internalError("Community provisioning failed")
    }

    return serializeCommunityCreateAcceptedResponse({
      community: serializeCommunity(input.env, communityRow, localSnapshot),
      job: serializeJob(provisioningFinalized.job),
    })
  }
}

export async function createCommunity(input: {
  env: Env
  userId: string
  body: CreateCommunityRequestBody
  userRepository: UserRepository
  verificationRepository: VerificationRepository
  communityRepository: CommunityProvisioningServiceRepository
}): Promise<CommunityCreateAcceptedResponse> {
  const auth = await resolveCreateCommunityAuth(input)
  await assertGatePolicyContractsValid({
    env: input.env,
    policy: input.body.gate_policy as GatePolicy | null | undefined,
  })

  if (!auth.namespaceVerificationId) {
    return createNamespacelessCommunity({
      env: input.env,
      body: input.body,
      auth,
      communityRepository: input.communityRepository,
    })
  }

  const namespaceVerification = await input.verificationRepository.getNamespaceVerification(
    auth.namespaceVerificationId,
    auth.userId,
  )
  if (!namespaceVerification) {
    throw notFoundError("Namespace verification not found")
  }
  if (namespaceVerification.status !== "verified" || !namespaceVerification.capabilities.club_attach_allowed) {
    throw eligibilityFailed("Namespace verification is not currently attachable")
  }
  if (isExpired(namespaceVerification.expires_at)) {
    throw eligibilityFailed("Namespace verification has expired")
  }

  const existingCommunity = await input.communityRepository.getCommunityByNamespaceVerificationId(
    auth.namespaceVerificationId,
  )
  if (existingCommunity) {
    const existingJob = await input.communityRepository.getLatestCommunityProvisioningJob(existingCommunity.community_id)
    if (!existingJob) {
      throw notFoundError("Existing community provisioning job not found")
    }
    const retryAction = await resolveProvisioningRetryAction(input.communityRepository, existingCommunity, existingJob)
    if (retryAction.action === "return_existing") {
      return serializeCommunityCreateAcceptedResponse({
        community: await loadCommunityProjection(input.env, input.communityRepository, existingCommunity),
        job: serializeJob(existingJob),
      })
    }
  }

  return provisionNamespacedCommunity({
    env: input.env,
    body: input.body,
    auth,
    existingCommunity,
    namespaceVerificationId: auth.namespaceVerificationId,
    namespaceVerification,
    communityRepository: input.communityRepository,
  })
}

export async function attachNamespaceToCommunity(input: {
  env: Env
  userId: string
  communityId: string
  namespaceVerificationId: string
  namespaceRole?: CommunityNamespaceRole
  verificationRepository: VerificationRepository
  communityRepository: CommunityProvisioningServiceRepository
}): Promise<Community> {
  const community = await requireOwnedCommunity(input.communityRepository, input.communityId, input.userId)
  const namespaceVerification = await input.verificationRepository.getNamespaceVerification(
    input.namespaceVerificationId,
    input.userId,
  )
  if (!namespaceVerification) {
    throw notFoundError("Namespace verification not found")
  }
  if (namespaceVerification.status !== "verified" || !namespaceVerification.capabilities.club_attach_allowed) {
    throw eligibilityFailed("Namespace verification is not currently attachable")
  }
  if (isExpired(namespaceVerification.expires_at)) {
    throw eligibilityFailed("Namespace verification has expired")
  }

  const createdAt = nowIso()
  const namespaceRole = input.namespaceRole ?? "primary"
  if (namespaceRole === "mirror" && !community.namespace_verification_id) {
    throw eligibilityFailed("Community must have a primary namespace before attaching mirrors")
  }
  let effectiveNamespaceVerification = namespaceVerification
  let attachedCommunity = community

  if (namespaceRole === "primary" && community.namespace_verification_id === input.namespaceVerificationId) {
    if (community.pending_namespace_verification_session_id) {
      await input.communityRepository.setPendingNamespaceVerificationSession({
        communityId: input.communityId,
        sessionId: null,
        updatedAt: createdAt,
      })
      attachedCommunity = {
        ...community,
        pending_namespace_verification_session_id: null,
        updated_at: createdAt,
      }
    }
  } else if (namespaceRole === "primary" && community.namespace_verification_id) {
    const existingNamespaceVerification = await input.verificationRepository.getNamespaceVerification(
      community.namespace_verification_id,
      input.userId,
    )
    if (!existingNamespaceVerification || !isSameNamespaceRoot(existingNamespaceVerification, namespaceVerification)) {
      throw eligibilityFailed("Community already has a different namespace attached")
    }
    effectiveNamespaceVerification = existingNamespaceVerification
    if (community.pending_namespace_verification_session_id) {
      await input.communityRepository.setPendingNamespaceVerificationSession({
        communityId: input.communityId,
        sessionId: null,
        updatedAt: createdAt,
      })
      attachedCommunity = {
        ...community,
        pending_namespace_verification_session_id: null,
        updated_at: createdAt,
      }
    }
  } else {
    const routeSlug = namespaceRouteSlug(namespaceVerification)
    attachedCommunity = await input.communityRepository.attachNamespaceToCommunity({
        communityNamespaceBindingId: makeId("cnb"),
        communityId: input.communityId,
        namespaceVerificationId: input.namespaceVerificationId,
        namespaceRole,
        routeSlug,
        updatedAt: createdAt,
      })
  }

  await upsertLocalNamespaceAttachment({
    env: input.env,
    repo: input.communityRepository,
    communityId: input.communityId,
    namespaceVerificationId: namespaceRole === "mirror"
      ? input.namespaceVerificationId
      : attachedCommunity.namespace_verification_id ?? input.namespaceVerificationId,
    namespaceRole,
    namespaceLabel: namespaceRouteSlug(effectiveNamespaceVerification),
    now: createdAt,
  })

  try {
    await resolveNamespaceVerificationTask({
      env: input.env,
      userId: input.userId,
      communityId: input.communityId,
    })
  } catch (error) {
    console.error("[community-provisioning] namespace verification task resolution failed", {
      communityId: input.communityId,
      userId: input.userId,
      error,
    })
  }

  return loadCommunityProjection(input.env, input.communityRepository, attachedCommunity)
}
