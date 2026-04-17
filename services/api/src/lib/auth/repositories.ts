import { globalSingleton } from "../db-helpers"
import { internalError } from "../errors"
import { envFlag, isLocalEnvironment } from "../helpers"
import { getControlPlaneClient } from "../runtime-deps"
import type {
  Env,
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
import { requireControlPlaneDbUrl } from "./auth-db-queries"
import { DatabaseIdentityRepository } from "./db-identity-repository"
import { DatabaseProfileRepository, type UpdateProfileInput } from "./db-profile-repository"
import { MemoryAuthRepository } from "./memory-auth-repository"
import { DatabaseRedditOnboardingRepository } from "../onboarding/db-reddit-onboarding-repository"

export type { UpdateProfileInput }

export type PublicProfileResolution = {
  profile: Profile
  requested_handle_label: string
  resolved_handle_label: string
  is_canonical: boolean
}

export interface SessionRepository {
  exchangeIdentity(identity: UpstreamIdentity): Promise<SessionSnapshot>
}

export interface UserRepository {
  getUserById(userId: string): Promise<User | null>
  getWalletAttachmentsByUserId(userId: string): Promise<WalletAttachmentSummary[]>
}

export interface OnboardingStatusRepository {
  getOnboardingStatusByUserId(userId: string): Promise<OnboardingStatus | null>
}

export interface ProfileRepository {
  getProfileByUserId(userId: string): Promise<Profile | null>
  resolvePublicProfileByHandle(handleLabel: string): Promise<PublicProfileResolution | null>
  updateProfile(userId: string, input: UpdateProfileInput): Promise<Profile | null>
  renameGlobalHandle(userId: string, desiredLabel: string): Promise<GlobalHandle | null>
  quoteGlobalHandleUpgrade(userId: string, desiredLabel: string): Promise<HandleUpgradeQuote | null>
  syncLinkedHandles(userId: string): Promise<Profile | null>
  setPrimaryPublicHandle(userId: string, linkedHandleId: string | null): Promise<Profile | null>
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
}

type DatabaseRepositoryBundle = {
  identity: DatabaseIdentityRepository
  profile: DatabaseProfileRepository
  redditOnboarding: DatabaseRedditOnboardingRepository
}

function getDatabaseRepositoryBundle(env: Env): DatabaseRepositoryBundle {
  const url = requireControlPlaneDbUrl(env)
  const cacheKey = `bundle:${url}`

  return globalSingleton("controlPlaneRepositoryBundle", cacheKey, () => {
    const client = getControlPlaneClient(env)
    return {
      identity: new DatabaseIdentityRepository(client),
      profile: new DatabaseProfileRepository(client, env),
      redditOnboarding: new DatabaseRedditOnboardingRepository(client),
    }
  })
}

function getMemoryAuthRepository(): MemoryAuthRepository {
  return globalSingleton("memoryAuthRepository", "singleton", () => new MemoryAuthRepository())
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
    return getMemoryAuthRepository()
  }
  return getDatabaseRepositoryBundle(env).identity
}

export function getUserRepository(env: Env): UserRepository {
  if (usingMemoryStore(env)) {
    return getMemoryAuthRepository()
  }
  return getDatabaseRepositoryBundle(env).identity
}

export function getOnboardingStatusRepository(env: Env): OnboardingStatusRepository {
  if (usingMemoryStore(env)) {
    return getMemoryAuthRepository()
  }
  return getDatabaseRepositoryBundle(env).identity
}

export function getProfileRepository(env: Env): ProfileRepository {
  if (usingMemoryStore(env)) {
    return getMemoryAuthRepository()
  }
  return getDatabaseRepositoryBundle(env).profile
}

export function getRedditOnboardingRepository(env: Env): RedditOnboardingRepository {
  if (usingMemoryStore(env)) {
    return getMemoryAuthRepository()
  }
  return getDatabaseRepositoryBundle(env).redditOnboarding
}
