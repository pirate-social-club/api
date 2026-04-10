import type { CommunityRow, JobRow } from "../auth/control-plane-auth-rows"
import type { CommunityRepository } from "./control-plane-community-repository"
import { badRequestError, internalError } from "../errors"
import { makeId } from "../helpers"
import type { Env } from "../../types"

type CommunityCreateAttemptResult = {
  registryAttemptId: string
  actorPrimaryWalletSnapshot: string | null
  actorGovernanceAddressSnapshot: string | null
  resultRef: string | null
}

export type RegistryPublicationResult = {
  community: CommunityRow
  job: JobRow
}

export type RegistryPublicationAdapter = {
  createCommunityCreateAttempt(input: {
    actorUserId: string
    actorPrimaryWalletSnapshot: string | null
    actorGovernanceAddressSnapshot: string | null
    namespaceVerificationId: string
    normalizedRootLabel: string
    createdAt: string
  }): Promise<CommunityCreateAttemptResult>
  publishCommunityCreate(input: {
    repo: CommunityRepository
    communityId: string
    registryAttemptId: string
    actorUserId: string
    namespaceVerificationId: string
    normalizedRootLabel: string
    canonicalSeed: {
      display_name: string
      description: string | null
      governance_mode: string
    }
    createdAt: string
  }): Promise<RegistryPublicationResult>
}

function parseTimeoutMs(value: string | undefined, fallbackMs: number): number {
  const parsed = Number(value)
  return Number.isFinite(parsed) && parsed > 0 ? parsed : fallbackMs
}

function publisherBaseUrl(env: Env): string | null {
  const configured = String(env.REGISTRY_PUBLISHER_URL || "").trim()
  return configured ? configured.replace(/\/+$/, "") : null
}

async function fetchPublisherJson(
  env: Env,
  path: string,
  body: Record<string, unknown>,
): Promise<Record<string, unknown>> {
  const baseUrl = publisherBaseUrl(env)
  if (!baseUrl) {
    throw internalError("Registry publisher URL is not configured")
  }

  const controller = new AbortController()
  const timeoutMs = parseTimeoutMs(env.REGISTRY_PUBLISHER_TIMEOUT_MS, 25000)
  const timer = setTimeout(() => controller.abort("timeout"), timeoutMs)

  try {
    const response = await fetch(`${baseUrl}${path}`, {
      method: "POST",
      headers: {
        "content-type": "application/json",
        ...(env.REGISTRY_PUBLISHER_AUTH_TOKEN
          ? { authorization: `Bearer ${String(env.REGISTRY_PUBLISHER_AUTH_TOKEN).trim()}` }
          : {}),
      },
      body: JSON.stringify(body),
      signal: controller.signal,
    })

    const raw = await response.text()
    let parsed: unknown = null
    try {
      parsed = raw ? JSON.parse(raw) : null
    } catch {
      parsed = { raw }
    }

    if (!response.ok) {
      const errorCode = typeof parsed === "object" && parsed
        ? "error_code" in parsed
          ? String((parsed as Record<string, unknown>).error_code)
          : "error" in parsed
            ? String((parsed as Record<string, unknown>).error)
            : response.status === 401
              ? "registry_publisher_unauthorized"
              : response.status === 501
                ? "registry_publisher_not_implemented"
                : "registry_publisher_http_error"
        : response.status === 401
          ? "registry_publisher_unauthorized"
          : response.status === 501
            ? "registry_publisher_not_implemented"
            : "registry_publisher_http_error"
      throw internalError(errorCode)
    }

    if (!parsed || typeof parsed !== "object") {
      throw internalError("registry_publisher_invalid_response")
    }

    return parsed as Record<string, unknown>
  } catch (error) {
    if (error instanceof Error && error.name === "AbortError") {
      throw internalError("registry_publisher_timeout")
    }
    throw error
  } finally {
    clearTimeout(timer)
  }
}

async function createCommunityCreateAttemptLocalStub(input: {
  actorUserId: string
  actorPrimaryWalletSnapshot: string | null
  actorGovernanceAddressSnapshot: string | null
}): Promise<CommunityCreateAttemptResult> {
  return {
    registryAttemptId: makeId("rga"),
    actorPrimaryWalletSnapshot: input.actorPrimaryWalletSnapshot,
    actorGovernanceAddressSnapshot: input.actorGovernanceAddressSnapshot,
    resultRef: `local_stub://registry-attempt/${input.actorUserId}`,
  }
}

async function publishCommunityCreateLocalStub(input: {
  repo: CommunityRepository
  communityId: string
  registryAttemptId: string
  actorUserId: string
  namespaceVerificationId: string
  normalizedRootLabel: string
  canonicalSeed: {
    display_name: string
    description: string | null
    governance_mode: string
  }
  createdAt: string
}): Promise<RegistryPublicationResult> {
  const jobId = makeId("job")

  try {
    const job = await input.repo.createCommunityRegistryPublicationRequest({
      communityId: input.communityId,
      registryAttemptId: input.registryAttemptId,
      jobId,
      createdAt: input.createdAt,
    })

    try {
      return await input.repo.markCommunityRegistryPublicationSucceeded({
        communityId: input.communityId,
        registryAttemptId: input.registryAttemptId,
        jobId: job.job_id,
        actorUserId: input.actorUserId,
        resultRef: `local_stub://registry/${input.communityId}`,
        createdAt: input.createdAt,
        metadata: {
          mode: "local_stub",
          registry_attempt_id: input.registryAttemptId,
          canonical_seed: input.canonicalSeed,
        },
      })
    } catch (error) {
      await input.repo.markCommunityRegistryPublicationFailed({
        communityId: input.communityId,
        registryAttemptId: input.registryAttemptId,
        jobId: job.job_id,
        actorUserId: input.actorUserId,
        errorCode: "local_stub_registry_publication_failed",
        createdAt: input.createdAt,
        metadata: {
          message: error instanceof Error ? error.message : String(error),
        },
      }).catch(() => {})

      throw internalError("Community registry publication failed")
    }
  } catch (error) {
    await input.repo.markCommunityRegistryPublicationFailed({
      communityId: input.communityId,
      registryAttemptId: input.registryAttemptId,
      jobId: null,
      actorUserId: input.actorUserId,
      errorCode: "registry_publication_request_failed",
      createdAt: input.createdAt,
      metadata: {
        message: error instanceof Error ? error.message : String(error),
      },
    }).catch(() => {})

    throw internalError("Community registry publication failed")
  }
}

function getHttpRegistryPublicationAdapter(env: Env): RegistryPublicationAdapter {
  return {
    async createCommunityCreateAttempt(input): Promise<CommunityCreateAttemptResult> {
      const payload = await fetchPublisherJson(env, "/internal/v0/create-community-attempt", {
        actor_user_id: input.actorUserId,
        actor_primary_wallet_snapshot: input.actorPrimaryWalletSnapshot,
        actor_governance_address_snapshot: input.actorGovernanceAddressSnapshot,
        namespace_verification_id: input.namespaceVerificationId,
        normalized_root_label: input.normalizedRootLabel,
        created_at: input.createdAt,
      })

      const registryAttemptId = String(payload.registry_attempt_id || "").trim()
      if (!registryAttemptId) {
        throw internalError("registry_publisher_invalid_response")
      }

      return {
        registryAttemptId,
        actorPrimaryWalletSnapshot:
          payload.actor_primary_wallet_snapshot == null ? null : String(payload.actor_primary_wallet_snapshot),
        actorGovernanceAddressSnapshot:
          payload.actor_governance_address_snapshot == null ? null : String(payload.actor_governance_address_snapshot),
        resultRef: payload.result_ref == null ? null : String(payload.result_ref),
      }
    },

    async publishCommunityCreate(input): Promise<RegistryPublicationResult> {
      const jobId = makeId("job")
      const publicationJob = await input.repo.createCommunityRegistryPublicationRequest({
        communityId: input.communityId,
        registryAttemptId: input.registryAttemptId,
        jobId,
        createdAt: input.createdAt,
      })

      try {
        const payload = await fetchPublisherJson(env, "/internal/v0/publish-community-create", {
          registry_attempt_id: input.registryAttemptId,
          community_id: input.communityId,
          actor_user_id: input.actorUserId,
          namespace_verification_id: input.namespaceVerificationId,
          normalized_root_label: input.normalizedRootLabel,
          canonical_seed: input.canonicalSeed,
          created_at: input.createdAt,
        })

        const status = String(payload.status || "").trim()
        if (status === "published") {
          return input.repo.markCommunityRegistryPublicationSucceeded({
            communityId: input.communityId,
            registryAttemptId: input.registryAttemptId,
            jobId: publicationJob.job_id,
            actorUserId: input.actorUserId,
            resultRef: payload.result_ref == null ? null : String(payload.result_ref),
            createdAt: payload.registry_published_at == null ? input.createdAt : String(payload.registry_published_at),
            metadata: {
              mode: "publisher_http",
              table_refs: payload.table_refs ?? null,
            },
          })
        }

        const errorCode = String(payload.error_code || "registry_publication_request_failed")
        await input.repo.markCommunityRegistryPublicationFailed({
          communityId: input.communityId,
          registryAttemptId: input.registryAttemptId,
          jobId: publicationJob.job_id,
          actorUserId: input.actorUserId,
          errorCode,
          createdAt: input.createdAt,
          metadata: {
            mode: "publisher_http",
          },
        })
      } catch (error) {
        await input.repo.markCommunityRegistryPublicationFailed({
          communityId: input.communityId,
          registryAttemptId: input.registryAttemptId,
          jobId: publicationJob.job_id,
          actorUserId: input.actorUserId,
          errorCode: error instanceof Error && error.message ? error.message : "registry_publication_request_failed",
          createdAt: input.createdAt,
          metadata: {
            mode: "publisher_http",
          },
        }).catch(() => {})
      }

      throw internalError("Community registry publication failed")
    },
  }
}

export function getRegistryPublicationAdapter(env: Env): RegistryPublicationAdapter {
  if (publisherBaseUrl(env)) {
    if (!String(env.REGISTRY_PUBLISHER_AUTH_TOKEN || "").trim()) {
      throw badRequestError("REGISTRY_PUBLISHER_AUTH_TOKEN is required when REGISTRY_PUBLISHER_URL is configured")
    }
    return getHttpRegistryPublicationAdapter(env)
  }

  return {
    createCommunityCreateAttempt: createCommunityCreateAttemptLocalStub,
    publishCommunityCreate: publishCommunityCreateLocalStub,
  }
}
