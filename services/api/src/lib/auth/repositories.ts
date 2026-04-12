import { internalError } from "../errors"
import { envFlag, isLocalEnvironment } from "../helpers"
import { createControlPlaneDbClient, requireControlPlaneDatabaseUrl } from "../control-plane-db"
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
  listUsersByIds(userIds: string[]): Promise<User[]>
  getWalletAttachmentsByUserId(userId: string): Promise<WalletAttachmentSummary[]>
}

export interface OnboardingStatusRepository {
  getOnboardingStatusByUserId(userId: string): Promise<OnboardingStatus | null>
}

export interface ProfileRepository {
  getProfileByUserId(userId: string): Promise<Profile | null>
  updateProfile(userId: string, input: UpdateProfileInput): Promise<Profile | null>
  renameGlobalHandle(userId: string, desiredLabel: string, issuanceSource?: string): Promise<GlobalHandle | null>
  quoteGlobalHandleUpgrade(userId: string, desiredLabel: string): Promise<HandleUpgradeQuote | null>
  checkGlobalHandleAvailability(userId: string, label: string): Promise<{
    label: string
    status: "available" | "taken" | "reserved" | "invalid"
    suggestion?: { label: string; source: "variation" | "generated" }
  }>
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
  processQueuedRedditSnapshotImport(input: {
    env: Env
    userId: string
    jobId: string
  }): Promise<boolean>
  drainRedditSnapshotImportJobs(input: {
    env: Env
    maxJobs: number
    staleAfterSeconds: number
  }): Promise<{ recoveredCount: number; drainedCount: number }>
  getLatestRedditImportSummary(userId: string): Promise<RedditImportSummary | null>
}

type ControlPlaneRepositoryBundle = {
  identity: ControlPlaneIdentityRepository
  profile: ControlPlaneProfileRepository
  redditOnboarding: ControlPlaneRedditOnboardingRepository
}

const globalScope = globalThis as typeof globalThis & {
  __pirateControlPlaneRepositoryBundle?: ControlPlaneRepositoryBundle
  __pirateControlPlaneClientKey?: string
  __pirateMemoryAuthRepository?: MemoryAuthRepository
}

function getControlPlaneRepositoryBundle(env: Env): ControlPlaneRepositoryBundle {
  const cacheKey = requireControlPlaneDatabaseUrl(env)

  if (
    globalScope.__pirateControlPlaneRepositoryBundle
    && globalScope.__pirateControlPlaneClientKey === cacheKey
  ) {
    return globalScope.__pirateControlPlaneRepositoryBundle
  }

  const client = createControlPlaneDbClient(env)
  const bundle = {
    identity: new ControlPlaneIdentityRepository(client),
    profile: new ControlPlaneProfileRepository(client),
    redditOnboarding: new ControlPlaneRedditOnboardingRepository(client),
  }
  globalScope.__pirateControlPlaneRepositoryBundle = bundle
  globalScope.__pirateControlPlaneClientKey = cacheKey
  return bundle
}

function getMemoryAuthRepository(): MemoryAuthRepository {
  if (!globalScope.__pirateMemoryAuthRepository) {
    globalScope.__pirateMemoryAuthRepository = new MemoryAuthRepository()
  }
  return globalScope.__pirateMemoryAuthRepository
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
