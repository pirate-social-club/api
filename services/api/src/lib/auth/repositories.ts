import { globalSingleton } from "../db-helpers"
import { internalError } from "../errors"
import { envFlag, isLocalEnvironment } from "../helpers"
import { getControlPlaneClient, isPostgresControlPlaneUrl } from "../runtime-deps"
import type {
  Env,
  GlobalHandlePaidClaimRequest,
  GlobalHandle,
  HandleUpgradeQuote,
  Job,
  OnboardingStatus,
  Profile,
  RedditImportSummary,
  RedditVerification,
  UpstreamIdentity,
  User,
  WalletAttachmentSummary,
} from "../../types"
import type { SessionSnapshot } from "./auth-db-rows"
import { requireControlPlaneDbUrl } from "./auth-db-query-helpers"
import { DatabaseIdentityRepository } from "./db-identity-repository"
import { DatabaseProfileRepository, type UpdateProfileInput } from "./db-profile-repository"
import { MemoryOnboardingStatusRepository } from "./dev/memory-onboarding-status-repository"
import { MemoryProfileRepository } from "./dev/memory-profile-repository"
import { MemorySessionRepository } from "./dev/memory-session-repository"
import { MemoryUserRepository } from "./dev/memory-user-repository"
import { DatabaseRedditOnboardingRepository } from "../onboarding/db-reddit-onboarding-repository"
import { MemoryRedditOnboardingRepository } from "./dev/memory-reddit-onboarding-repository"

export type { UpdateProfileInput }

export type PublicProfileResolution = {
  profile: Profile
  requested_handle_label: string
  resolved_handle_label: string
  is_canonical: boolean
  created_communities: Array<{
    community: string
    display_name: string
    route_slug: string | null
    created: number
  }>
}

export type WalletAttachmentRecord = WalletAttachmentSummary & {
  user_id: string
  status: string
}

export interface SessionRepository {
  exchangeIdentity(identity: UpstreamIdentity): Promise<SessionSnapshot>
  close?(): void | Promise<void>
}

export interface UserRepository {
  getUserById(userId: string): Promise<User | null>
  getWalletAttachmentsByUserId(userId: string): Promise<WalletAttachmentSummary[]>
  getWalletAttachmentById(walletAttachmentId: string): Promise<WalletAttachmentRecord | null>
  close?(): void | Promise<void>
}

export interface OnboardingStatusRepository {
  getOnboardingStatusByUserId(userId: string): Promise<OnboardingStatus | null>
  dismissOnboarding(userId: string): Promise<OnboardingStatus | null>
  close?(): void | Promise<void>
}

export interface ProfileRepository {
  getProfileByUserId(userId: string): Promise<Profile | null>
  listProfilesByUserIds?(userIds: string[]): Promise<Map<string, Profile>>
  resolvePublicProfileByHandle(handleLabel: string): Promise<PublicProfileResolution | null>
  resolvePublicProfileByWalletAddress(walletAddress: string): Promise<PublicProfileResolution | null>
  updateXmtpInboxId(userId: string, xmtpInboxId: string | null): Promise<Profile | null>
  updateProfile(userId: string, input: UpdateProfileInput): Promise<Profile | null>
  renameGlobalHandle(userId: string, desiredLabel: string): Promise<GlobalHandle | null>
  claimRedditGlobalHandle(userId: string, desiredLabel: string): Promise<GlobalHandle | null>
  quoteGlobalHandleUpgrade(userId: string, desiredLabel: string): Promise<HandleUpgradeQuote | null>
  claimPaidGlobalHandle(userId: string, body: GlobalHandlePaidClaimRequest): Promise<GlobalHandle | null>
  syncLinkedHandles(userId: string): Promise<Profile | null>
  setPrimaryPublicHandle(userId: string, linkedHandleId: string | null): Promise<Profile | null>
  close?(): void | Promise<void>
}

export interface RedditOnboardingRepository {
  startOrCheckRedditVerification(input: {
    env: Env
    userId: string
    redditUsername: string
  }): Promise<RedditVerification>
  startRedditSnapshotImport(input: {
    env: Env
    userId: string
    redditUsername: string
  }): Promise<{ job: Job }>
  getLatestRedditImportSummary(userId: string): Promise<RedditImportSummary | null>
  close?(): void | Promise<void>
}

type DatabaseRepositoryBundle = {
  identity: DatabaseIdentityRepository
  profile: DatabaseProfileRepository
  redditOnboarding: DatabaseRedditOnboardingRepository
}

type MemoryRepositoryBundle = {
  session: MemorySessionRepository
  user: MemoryUserRepository
  onboardingStatus: MemoryOnboardingStatusRepository
  profile: MemoryProfileRepository
  redditOnboarding: MemoryRedditOnboardingRepository
}

function getDatabaseRepositoryBundle(env: Env): DatabaseRepositoryBundle {
  const url = requireControlPlaneDbUrl(env)
  const buildBundle = (): DatabaseRepositoryBundle => {
    const client = getControlPlaneClient(env)
    return {
      identity: new DatabaseIdentityRepository(client),
      profile: new DatabaseProfileRepository(client, env),
      redditOnboarding: new DatabaseRedditOnboardingRepository(client),
    }
  }

  if (isPostgresControlPlaneUrl(url)) {
    return buildBundle()
  }

  const cacheKey = `bundle:${url}`
  return globalSingleton("controlPlaneRepositoryBundle", cacheKey, buildBundle)
}

function getMemoryRepositoryBundle(): MemoryRepositoryBundle {
  return globalSingleton("memoryRepositoryBundle", "singleton", () => ({
    session: new MemorySessionRepository(),
    user: new MemoryUserRepository(),
    onboardingStatus: new MemoryOnboardingStatusRepository(),
    profile: new MemoryProfileRepository(),
    redditOnboarding: new MemoryRedditOnboardingRepository(),
  }))
}

function usingMemoryStore(env: Env): boolean {
  if (!envFlag(env.DEV_MEMORY_STORE_ENABLED, false)) {
    return false
  }
  if (!isLocalEnvironment(env.ENVIRONMENT)) {
    throw internalError("DEV_MEMORY_STORE_ENABLED is only allowed in local environments")
  }
  return true
}

export function getSessionRepository(env: Env): SessionRepository {
  if (usingMemoryStore(env)) {
    return getMemoryRepositoryBundle().session
  }
  return getDatabaseRepositoryBundle(env).identity
}

export function getUserRepository(env: Env): UserRepository {
  if (usingMemoryStore(env)) {
    return getMemoryRepositoryBundle().user
  }
  return getDatabaseRepositoryBundle(env).identity
}

export function getOnboardingStatusRepository(env: Env): OnboardingStatusRepository {
  if (usingMemoryStore(env)) {
    return getMemoryRepositoryBundle().onboardingStatus
  }
  return getDatabaseRepositoryBundle(env).identity
}

export function getProfileRepository(env: Env): ProfileRepository {
  if (usingMemoryStore(env)) {
    return getMemoryRepositoryBundle().profile
  }
  return getDatabaseRepositoryBundle(env).profile
}

export function getRedditOnboardingRepository(env: Env): RedditOnboardingRepository {
  if (usingMemoryStore(env)) {
    return getMemoryRepositoryBundle().redditOnboarding
  }
  return getDatabaseRepositoryBundle(env).redditOnboarding
}
