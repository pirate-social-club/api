import { encryptCommunityDbCredential } from "../community-db-credential-crypto"
import {
  type ProvisionedCommunityCredential,
  resolveCommunityProvisioningBackend,
} from "./backend"
import type { UserRepository } from "../../auth/repositories"
import type { CommunityDatabaseBindingRow, CommunityRow, JobRow } from "../../auth/auth-db-rows"
import type {
  CommunityDatabaseBindingRepository,
  CommunityJobReadRepository,
  CommunityMembershipProjectionRepository,
  CommunityMutationRepository,
  CommunityProvisioningRepository,
  CommunityReadRepository,
} from "../db-community-repository"
import { eligibilityFailed, internalError, notFoundError } from "../../errors"
import { makeId, nowIso } from "../../helpers"
import type { VerificationRepository } from "../../verification/verification-repository"
import { createNamespaceVerificationTask, resolveNamespaceVerificationTask } from "../../notifications/notification-task-service"
import type {
  Community,
  CommunityCreateAcceptedResponse,
  Env,
  NamespaceVerification,
} from "../../../types"
import { serializeCommunity, serializeJob } from "../community-serialization"
import { syncCommunityAuthProjection } from "../community-auth-projection-service"
import { serializeCommunityCreateAcceptedResponse } from "../../../serializers/community"
import { openCommunityDb } from "../community-db-factory"
import {
  isExpired,
  loadCommunityLocalSnapshot,
  loadCommunityProjection,
  requireOwnedCommunity,
  resolveCommunityDbWrapKey,
  resolveCommunityDbWrapKeyVersion,
  resolveProvisioningRetryAction,
} from "../create/repository"
import {
  type CreateCommunityAuth,
  type CreateCommunityRequestBody,
  resolveCreateCommunityAuth,
} from "../create/validation"
import { HttpError } from "../../errors"

type CommunityProvisioningServiceRepository =
  & CommunityReadRepository
  & CommunityDatabaseBindingRepository
  & CommunityJobReadRepository
  & CommunityProvisioningRepository
  & CommunityMembershipProjectionRepository
  & CommunityMutationRepository

function resolveProvisionedCredentialId(communityId: string, credentialId: string): string {
  const trimmed = credentialId.trim()
  if (trimmed.length > 0) {
    return trimmed
  }
  const fallbackId = makeId("cdc")
  console.warn("[community-provisioning] operator omitted credential_id; generated fallback", {
    communityId,
    credentialId: fallbackId,
  })
  return fallbackId
}

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

function communityProvisioningFailureDetails(
  error: unknown,
  mode: "local_dev" | "turso_operator",
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

async function persistProvisionedCommunityCredential(input: {
  env: Env
  repo: CommunityProvisioningRepository
  communityId: string
  bindingId: string
  credential: ProvisionedCommunityCredential | null
  updatedAt: string
}): Promise<void> {
  if (!input.credential) {
    return
  }

  const encryptedToken = encryptCommunityDbCredential({
    plaintextToken: input.credential.plaintextToken,
    wrapKey: resolveCommunityDbWrapKey(input.env),
  })
  const communityDbCredentialId = resolveProvisionedCredentialId(
    input.communityId,
    input.credential.credentialId,
  )
  await input.repo.persistProvisionedCommunityDatabaseAccess({
    communityDatabaseBindingId: input.bindingId,
    communityDbCredentialId,
    organizationSlug: input.credential.organizationSlug,
    groupName: input.credential.groupName,
    groupId: input.credential.groupId,
    databaseName: input.credential.databaseName,
    databaseId: input.credential.databaseId,
    databaseUrl: input.credential.databaseUrl,
    location: input.credential.location,
    tokenName: input.credential.tokenName,
    encryptedToken,
    encryptionKeyVersion: resolveCommunityDbWrapKeyVersion(input.env),
    issuedAt: input.credential.issuedAt,
    expiresAt: input.credential.expiresAt,
    updatedAt: input.updatedAt,
  })
}

async function upsertLocalNamespaceAttachment(input: {
  env: Env
  repo: CommunityDatabaseBindingRepository
  communityId: string
  namespaceVerificationId: string
  namespaceLabel: string
  now: string
}): Promise<void> {
  const db = await openCommunityDb(input.env, input.repo, input.communityId)
  const namespaceId = `ns_${input.communityId}`
  const namespaceHandlePolicyId = `nhp_${input.communityId}`

  try {
    const tx = await db.client.transaction("write")
    try {
      await tx.execute({
        sql: `
          INSERT INTO namespace_bindings (
            namespace_id, community_id, namespace_verification_id, display_label, normalized_label,
            resolver_label, route_family, status, created_at, updated_at
          ) VALUES (
            ?1, ?2, ?3, ?4, ?5, NULL, NULL, 'active', ?6, ?6
          )
          ON CONFLICT(namespace_id) DO UPDATE SET
            namespace_verification_id = excluded.namespace_verification_id,
            display_label = excluded.display_label,
            normalized_label = excluded.normalized_label,
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

      await tx.commit()
    } catch (error) {
      try {
        await tx.rollback()
      } catch (rollbackError) {
        console.error("[community-provisioning] rollback failed while preparing namespace attach", rollbackError)
      }
      throw error
    } finally {
      tx.close()
    }
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
  const backend = resolveCommunityProvisioningBackend(input.env)
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
    })
    await persistProvisionedCommunityCredential({
      env: input.env,
      repo: input.communityRepository,
      communityId,
      bindingId: prepared.binding.community_database_binding_id,
      credential: provisioned.credential,
      updatedAt: input.auth.createdAt,
    })
    const localSnapshot = provisioned.localSnapshot
      ?? await loadCommunityLocalSnapshot(input.env, input.communityRepository, communityId)
    if (localSnapshot) {
      await syncCommunityAuthProjection({
        env: input.env,
        communityId,
        displayName: localSnapshot.display_name,
        avatarRef: localSnapshot.avatar_ref,
        membershipGatePolicy: localSnapshot.gate_policy,
        updatedAt: input.auth.createdAt,
      })
    }
    const resolvedBinding = await input.communityRepository.getPrimaryCommunityDatabaseBinding(communityId)
    const databaseUrl = resolvedBinding?.database_url ?? provisioned.binding.databaseUrl

    const finalized = await input.communityRepository.markCommunityProvisioningSucceeded({
      communityId,
      communityDatabaseBindingId: prepared.binding.community_database_binding_id,
      jobId: prepared.job.job_id,
      actorUserId: input.auth.userId,
      resultRef: databaseUrl,
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
      errorCode: backend.mode === "turso_operator" ? "turso_operator_provision_failed" : "local_dev_bootstrap_failed",
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

    throw internalError(
      "Community provisioning failed",
      {
        ...communityProvisioningFailureDetails(error, backend.mode),
        community_id: communityId,
        job_id: prepared.job.job_id,
      },
    )
  }
}

async function finalizeExistingCommunity(input: {
  env: Env
  body: CreateCommunityRequestBody
  auth: CreateCommunityAuth
  existingCommunity: CommunityRow
  existingJob: JobRow
  binding: CommunityDatabaseBindingRow
  communityRepository: CommunityProvisioningServiceRepository
  namespaceVerificationId: string
  namespaceVerification: Pick<NamespaceVerification, "family" | "normalized_root_label">
}): Promise<CommunityCreateAcceptedResponse> {
  const finalized = await input.communityRepository.markCommunityProvisioningSucceeded({
    communityId: input.existingCommunity.community_id,
    communityDatabaseBindingId: input.binding.community_database_binding_id,
    jobId: input.existingJob.job_id,
    actorUserId: input.auth.userId,
    resultRef: input.binding.database_url,
    createdAt: nowIso(),
    metadata: {
      binding_id: input.binding.community_database_binding_id,
      database_url: input.binding.database_url,
      mode: "finalize_after_crash",
    },
  })
  const local = await loadCommunityLocalSnapshot(input.env, input.communityRepository, input.existingCommunity.community_id)
  if (local) {
    await syncCommunityAuthProjection({
      env: input.env,
      communityId: input.existingCommunity.community_id,
      displayName: local.display_name,
      avatarRef: local.avatar_ref,
      membershipGatePolicy: local.gate_policy,
      updatedAt: nowIso(),
    })
  }
  return serializeCommunityCreateAcceptedResponse({
    community: serializeCommunity(input.env, finalized.community, local),
    job: serializeJob(finalized.job),
  })
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
  const bindingId = existingCommunity?.primary_database_binding_id ?? makeId("cdb")
  const jobId = makeId("job")
  const backend = resolveCommunityProvisioningBackend(env)
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
    })
    await persistProvisionedCommunityCredential({
      env,
      repo,
      communityId,
      bindingId: prepared.binding.community_database_binding_id,
      credential: provisioned.credential,
      updatedAt: auth.createdAt,
    })
    localSnapshot = provisioned.localSnapshot ?? await loadCommunityLocalSnapshot(env, repo, communityId)
    if (localSnapshot) {
      await syncCommunityAuthProjection({
        env,
        communityId,
        displayName: localSnapshot.display_name,
        avatarRef: localSnapshot.avatar_ref,
        membershipGatePolicy: localSnapshot.gate_policy,
        updatedAt: auth.createdAt,
      })
    }
    const resolvedBinding = await repo.getPrimaryCommunityDatabaseBinding(communityId)
    const databaseUrl = resolvedBinding?.database_url ?? provisioned.binding.databaseUrl

    provisioningFinalized = await repo.markCommunityProvisioningSucceeded({
      communityId,
      communityDatabaseBindingId: prepared.binding.community_database_binding_id,
      jobId: prepared.job.job_id,
      actorUserId: auth.userId,
      resultRef: databaseUrl,
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
        errorCode: backend.mode === "turso_operator" ? "turso_operator_provision_failed" : "local_dev_bootstrap_failed",
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

      throw internalError(
        "Community provisioning failed",
        {
          ...communityProvisioningFailureDetails(error, backend.mode),
          community_id: communityId,
          job_id: prepared.job.job_id,
        },
      )
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
    if (retryAction.action === "finalize") {
      return finalizeExistingCommunity({
        env: input.env,
        body: input.body,
        auth,
        existingCommunity,
        existingJob,
        binding: retryAction.binding,
        communityRepository: input.communityRepository,
        namespaceVerificationId: auth.namespaceVerificationId,
        namespaceVerification,
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
  let effectiveNamespaceVerification = namespaceVerification
  let attachedCommunity = community

  if (community.namespace_verification_id === input.namespaceVerificationId) {
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
  } else if (community.namespace_verification_id) {
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
        communityId: input.communityId,
        namespaceVerificationId: input.namespaceVerificationId,
        routeSlug,
        updatedAt: createdAt,
      })
  }

  await upsertLocalNamespaceAttachment({
    env: input.env,
    repo: input.communityRepository,
    communityId: input.communityId,
    namespaceVerificationId: attachedCommunity.namespace_verification_id ?? input.namespaceVerificationId,
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
