import { buildLocalCommunityDbUrl } from "../community-local-db"
import type { LocalCommunitySnapshot } from "../community-local-db"
import type {
  CommunityProvisioningMode,
  InitialCommunityDatabaseBinding,
} from "../community-repository-types"
import {
  bootstrapCommunityLocalSnapshot,
  buildPendingCommunityDatabaseUrl,
  buildProvisionOperatorBootstrapPayload,
  resolveCommunityDbRoot,
  resolveCommunityProvisionGroupLocation,
} from "../create/repository"
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

export function resolveCommunityProvisioningBackend(env: Env): CommunityProvisioningBackend {
  return isCommunityProvisionOperatorConfigured(env)
    ? tursoOperatorProvisioningBackend
    : localDevProvisioningBackend
}
