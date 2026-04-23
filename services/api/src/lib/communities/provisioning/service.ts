import { encryptCommunityDbCredential } from "../community-db-credential-crypto"
import { buildLocalCommunityDbUrl } from "../community-local-db"
import {
  isCommunityProvisionOperatorConfigured,
  provisionCommunityViaOperator,
} from "./operator-client"
import type { UserRepository } from "../../auth/repositories"
import type { CommunityDatabaseBindingRow, CommunityRow, JobRow } from "../../auth/auth-db-rows"
import type { CommunityRepository } from "../db-community-repository"
import { eligibilityFailed, internalError, notFoundError } from "../../errors"
import { makeId, nowIso } from "../../helpers"
import type { VerificationRepository } from "../../verification/verification-repository"
import { createNamespaceVerificationTask, resolveNamespaceVerificationTask } from "../../notifications/notification-service"
import type {
  Community,
  CommunityCreateAcceptedResponse,
  Env,
  NamespaceVerification,
} from "../../../types"
import { serializeCommunity, serializeJob } from "../community-serialization"
import { openCommunityDb } from "../community-db-factory"
import {
  bootstrapCommunityLocalSnapshot,
  buildPendingCommunityDatabaseUrl,
  buildProvisionOperatorBootstrapPayload,
  CreateCommunityAuth,
  CreateCommunityRequestBody,
  isExpired,
  loadCommunityLocalSnapshot,
  loadCommunityProjection,
  requireOwnedCommunity,
  resolveCommunityDbRoot,
  resolveCommunityDbWrapKey,
  resolveCommunityDbWrapKeyVersion,
  resolveCommunityProvisionGroupLocation,
  resolveCreateCommunityAuth,
  resolveProvisioningRetryAction,
} from "../create/shared"

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

async function upsertLocalNamespaceAttachment(input: {
  env: Env
  repo: CommunityRepository
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
            membership_required_for_claim, settings_json, created_at, updated_at
          ) VALUES (
            ?1, ?2, ?3, 'standard', NULL, 1, NULL, ?4, ?4
          )
          ON CONFLICT(namespace_handle_policy_id) DO UPDATE SET
            namespace_id = excluded.namespace_id,
            membership_required_for_claim = excluded.membership_required_for_claim,
            updated_at = excluded.updated_at
        `,
        args: [
          namespaceHandlePolicyId,
          input.communityId,
          namespaceId,
          input.now,
        ],
      })

      await tx.commit()
    } catch (error) {
      try {
        await tx.rollback()
      } catch {}
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
  communityRepository: CommunityRepository
}): Promise<CommunityCreateAcceptedResponse> {
  const communityId = makeId("cmt")
  const bindingId = makeId("cdb")
  const jobId = makeId("job")
  const useProvisionOperator = isCommunityProvisionOperatorConfigured(input.env)
  const groupLocation = useProvisionOperator
    ? resolveCommunityProvisionGroupLocation(input.env, input.body.database_region)
    : "local"
  const databaseUrl = useProvisionOperator
    ? buildPendingCommunityDatabaseUrl(communityId)
    : buildLocalCommunityDbUrl(resolveCommunityDbRoot(input.env), communityId)
  const prepared = await input.communityRepository.createCommunityProvisioningRequest({
    communityId,
    communityDatabaseBindingId: bindingId,
    jobId,
    creatorUserId: input.auth.userId,
    displayName: input.auth.communityDisplayName,
    membershipMode: input.body.membership_mode ?? "open",
    namespaceVerificationId: null,
    routeSlug: null,
    databaseUrl,
    createdAt: input.auth.createdAt,
  })

  try {
    let localSnapshot: Awaited<ReturnType<typeof loadCommunityLocalSnapshot>> = null
    let resolvedBinding: CommunityDatabaseBindingRow | null | undefined

    if (useProvisionOperator) {
      const provisioned = await provisionCommunityViaOperator({
        env: input.env,
        communityId,
        creatorUserId: input.auth.userId,
        displayName: input.auth.communityDisplayName,
        namespaceVerificationId: null,
        groupLocation,
        bootstrapPayload: buildProvisionOperatorBootstrapPayload(
          input.body,
          null,
        ),
      })
      const encryptedToken = encryptCommunityDbCredential({
        plaintextToken: provisioned.plaintextToken,
        wrapKey: resolveCommunityDbWrapKey(input.env),
      })
      const communityDbCredentialId = resolveProvisionedCredentialId(communityId, provisioned.credentialId)
      await input.communityRepository.persistProvisionedCommunityDatabaseAccess({
        communityDatabaseBindingId: prepared.binding.community_database_binding_id,
        communityDbCredentialId,
        organizationSlug: provisioned.organizationSlug,
        groupName: provisioned.groupName,
        groupId: provisioned.groupId,
        databaseName: provisioned.databaseName,
        databaseId: provisioned.databaseId,
        databaseUrl: provisioned.databaseUrl,
        location: provisioned.location,
        tokenName: provisioned.tokenName,
        encryptedToken,
        encryptionKeyVersion: resolveCommunityDbWrapKeyVersion(input.env),
        issuedAt: provisioned.issuedAt,
        expiresAt: provisioned.expiresAt,
        updatedAt: input.auth.createdAt,
      })
      localSnapshot = await loadCommunityLocalSnapshot(input.env, input.communityRepository, communityId)
      resolvedBinding = await input.communityRepository.getPrimaryCommunityDatabaseBinding(communityId)
    } else {
      localSnapshot = await bootstrapCommunityLocalSnapshot({
        env: input.env,
        body: input.body,
        auth: input.auth,
        communityId,
        namespaceVerificationId: null,
        namespaceLabel: null,
      })
    }

    const finalized = await input.communityRepository.markCommunityProvisioningSucceeded({
      communityId,
      communityDatabaseBindingId: prepared.binding.community_database_binding_id,
      jobId: prepared.job.job_id,
      actorUserId: input.auth.userId,
      resultRef: useProvisionOperator
        ? resolvedBinding?.database_url ?? prepared.binding.database_url
        : prepared.binding.database_url,
      createdAt: input.auth.createdAt,
      metadata: {
        binding_id: prepared.binding.community_database_binding_id,
        database_url: useProvisionOperator
          ? resolvedBinding?.database_url ?? prepared.binding.database_url
          : prepared.binding.database_url,
        mode: useProvisionOperator ? "turso_operator" : "local_stub",
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
    } catch {}

    return {
      community: serializeCommunity(input.env, finalized.community, localSnapshot),
      job: serializeJob(finalized.job),
    }
  } catch (error) {
    await input.communityRepository.markCommunityProvisioningFailed({
      communityId,
      jobId: prepared.job.job_id,
      actorUserId: input.auth.userId,
      errorCode: useProvisionOperator ? "turso_operator_provision_failed" : "local_stub_bootstrap_failed",
      createdAt: nowIso(),
      metadata: {
        binding_id: prepared.binding.community_database_binding_id,
        database_url: prepared.binding.database_url,
        message: error instanceof Error ? error.message : String(error),
      },
    }).catch(() => {})

    throw internalError("Community provisioning failed")
  }
}

async function finalizeExistingCommunity(input: {
  env: Env
  body: CreateCommunityRequestBody
  auth: CreateCommunityAuth
  existingCommunity: CommunityRow
  existingJob: JobRow
  binding: CommunityDatabaseBindingRow
  communityRepository: CommunityRepository
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
  return {
    community: serializeCommunity(input.env, finalized.community, local),
    job: serializeJob(finalized.job),
  }
}

async function provisionNamespacedCommunity(input: {
  env: Env
  body: CreateCommunityRequestBody
  auth: CreateCommunityAuth
  existingCommunity: CommunityRow | null
  namespaceVerificationId: string
  namespaceVerification: Pick<NamespaceVerification, "family" | "normalized_root_label">
  communityRepository: CommunityRepository
}): Promise<CommunityCreateAcceptedResponse> {
  const { env, body, auth, existingCommunity, namespaceVerificationId, namespaceVerification, communityRepository: repo } = input
  const routeSlug = namespaceRouteSlug(namespaceVerification)
  const communityId = existingCommunity?.community_id ?? makeId("cmt")
  const bindingId = existingCommunity?.primary_database_binding_id ?? makeId("cdb")
  const jobId = makeId("job")
  const useProvisionOperator = isCommunityProvisionOperatorConfigured(env)
  const groupLocation = useProvisionOperator
    ? resolveCommunityProvisionGroupLocation(env, body.database_region)
    : "local"
  const databaseUrl = useProvisionOperator
    ? buildPendingCommunityDatabaseUrl(communityId)
    : buildLocalCommunityDbUrl(resolveCommunityDbRoot(env), communityId)

  const prepared = await (async () => {
    return existingCommunity
      ? repo.retryCommunityProvisioningRequest({
          communityId,
          fallbackBindingId: bindingId,
          jobId,
          namespaceVerificationId,
          routeSlug,
          databaseUrl,
          createdAt: auth.createdAt,
        })
      : repo.createCommunityProvisioningRequest({
          communityId,
          communityDatabaseBindingId: bindingId,
          jobId,
          creatorUserId: auth.userId,
          displayName: auth.communityDisplayName,
          membershipMode: body.membership_mode ?? "open",
          namespaceVerificationId,
          routeSlug,
          databaseUrl,
          createdAt: auth.createdAt,
        })
  })()

  let provisioningCompleted = false
  let provisioningFinalized: { community: CommunityRow; job: JobRow } | null = null
  let localSnapshot: Awaited<ReturnType<typeof loadCommunityLocalSnapshot>> = null
  let resolvedBinding: CommunityDatabaseBindingRow | null | undefined

  try {
    if (useProvisionOperator) {
      const provisioned = await provisionCommunityViaOperator({
        env,
        communityId,
        creatorUserId: auth.userId,
        displayName: auth.communityDisplayName,
        namespaceVerificationId,
        groupLocation,
        bootstrapPayload: buildProvisionOperatorBootstrapPayload(
          body,
          routeSlug,
        ),
      })
      const encryptedToken = encryptCommunityDbCredential({
        plaintextToken: provisioned.plaintextToken,
        wrapKey: resolveCommunityDbWrapKey(env),
      })
      const communityDbCredentialId = resolveProvisionedCredentialId(communityId, provisioned.credentialId)
      await repo.persistProvisionedCommunityDatabaseAccess({
        communityDatabaseBindingId: prepared.binding.community_database_binding_id,
        communityDbCredentialId,
        organizationSlug: provisioned.organizationSlug,
        groupName: provisioned.groupName,
        groupId: provisioned.groupId,
        databaseName: provisioned.databaseName,
        databaseId: provisioned.databaseId,
        databaseUrl: provisioned.databaseUrl,
        location: provisioned.location,
        tokenName: provisioned.tokenName,
        encryptedToken,
        encryptionKeyVersion: resolveCommunityDbWrapKeyVersion(env),
        issuedAt: provisioned.issuedAt,
        expiresAt: provisioned.expiresAt,
        updatedAt: auth.createdAt,
      })
      localSnapshot = await loadCommunityLocalSnapshot(env, repo, communityId)
    } else {
      localSnapshot = await bootstrapCommunityLocalSnapshot({
        env,
        body,
        auth,
        communityId,
        namespaceVerificationId,
        namespaceLabel: routeSlug,
      })
    }

    provisioningFinalized = await repo.markCommunityProvisioningSucceeded({
      communityId,
      communityDatabaseBindingId: prepared.binding.community_database_binding_id,
      jobId: prepared.job.job_id,
      actorUserId: auth.userId,
      resultRef: useProvisionOperator
        ? (resolvedBinding ??= await repo.getPrimaryCommunityDatabaseBinding(communityId))?.database_url ?? prepared.binding.database_url
        : prepared.binding.database_url,
      createdAt: auth.createdAt,
      metadata: {
        binding_id: prepared.binding.community_database_binding_id,
        database_url: useProvisionOperator
          ? resolvedBinding?.database_url ?? prepared.binding.database_url
          : prepared.binding.database_url,
        mode: useProvisionOperator ? "turso_operator" : "local_stub",
      },
    })
    provisioningCompleted = true

    return {
      community: serializeCommunity(input.env, provisioningFinalized.community, localSnapshot),
      job: serializeJob(provisioningFinalized.job),
    }
  } catch (error) {
    const failedAt = nowIso()

    if (!provisioningCompleted) {
      await repo.markCommunityProvisioningFailed({
        communityId,
        jobId: prepared.job.job_id,
        actorUserId: auth.userId,
        errorCode: useProvisionOperator ? "turso_operator_provision_failed" : "local_stub_bootstrap_failed",
        createdAt: failedAt,
        metadata: {
          binding_id: prepared.binding.community_database_binding_id,
          database_url: prepared.binding.database_url,
          message: error instanceof Error ? error.message : String(error),
        },
      }).catch(() => {})

      throw internalError("Community provisioning failed")
    }

    const communityRow = await repo.getCommunityById(communityId)
    if (!communityRow || !provisioningFinalized) {
      throw internalError("Community provisioning failed")
    }

    return {
      community: serializeCommunity(input.env, communityRow, localSnapshot),
      job: serializeJob(provisioningFinalized.job),
    }
  }
}

export async function createCommunity(input: {
  env: Env
  userId: string
  body: CreateCommunityRequestBody
  userRepository: UserRepository
  verificationRepository: VerificationRepository
  communityRepository: CommunityRepository
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
      return {
        community: await loadCommunityProjection(input.env, input.communityRepository, existingCommunity),
        job: serializeJob(existingJob),
      }
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
  communityRepository: CommunityRepository
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
  } catch {}

  return loadCommunityProjection(input.env, input.communityRepository, attachedCommunity)
}
