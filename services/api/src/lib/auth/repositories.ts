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
import type { SessionSnapshot } from "./control-plane-auth-rows"
import { requireControlPlaneDbUrl } from "./control-plane-auth-queries"
import { ControlPlaneIdentityRepository } from "./control-plane-identity-repository"
import { ControlPlaneProfileRepository, type UpdateProfileInput } from "./control-plane-profile-repository"
import { MemoryAuthRepository } from "./memory-auth-repository"
import { ControlPlaneRedditOnboardingRepository } from "../onboarding/control-plane-reddit-onboarding-repository"

export type { UpdateProfileInput }

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
  updateProfile(userId: string, input: UpdateProfileInput): Promise<Profile | null>
  renameGlobalHandle(userId: string, desiredLabel: string): Promise<GlobalHandle | null>
  quoteGlobalHandleUpgrade(userId: string, desiredLabel: string): Promise<HandleUpgradeQuote | null>
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

type ControlPlaneRepositoryBundle = {
  identity: ControlPlaneIdentityRepository
  profile: ControlPlaneProfileRepository
  redditOnboarding: ControlPlaneRedditOnboardingRepository
}

function getControlPlaneRepositoryBundle(env: Env): ControlPlaneRepositoryBundle {
  const url = requireControlPlaneDbUrl(env)
  const authToken = String(env.TURSO_CONTROL_PLANE_AUTH_TOKEN || "").trim()
  const cacheKey = `bundle:${url}|${authToken}`

  return globalSingleton("controlPlaneRepositoryBundle", cacheKey, () => {
    const client = getControlPlaneClient(env)
    return {
      identity: new ControlPlaneIdentityRepository(client),
      profile: new ControlPlaneProfileRepository(client),
      redditOnboarding: new ControlPlaneRedditOnboardingRepository(client),
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
  return getControlPlaneRepositoryBundle(env).identity
}

export function getUserRepository(env: Env): UserRepository {
  if (usingMemoryStore(env)) {
    return getMemoryAuthRepository()
  }
  return getControlPlaneRepositoryBundle(env).identity
}

export function getOnboardingStatusRepository(env: Env): OnboardingStatusRepository {
  if (usingMemoryStore(env)) {
    return getMemoryAuthRepository()
  }
  return getControlPlaneRepositoryBundle(env).identity
}

export function getProfileRepository(env: Env): ProfileRepository {
  if (usingMemoryStore(env)) {
    return getMemoryAuthRepository()
  }
  return getControlPlaneRepositoryBundle(env).profile
}

export function getRedditOnboardingRepository(env: Env): RedditOnboardingRepository {
  if (usingMemoryStore(env)) {
    return getMemoryAuthRepository()
  }
  return getControlPlaneRepositoryBundle(env).redditOnboarding
}
