import type { Client } from "../sql-client"
import { globalSingleton } from "../db-helpers"
import { getControlPlaneCacheKey, getControlPlaneClient, isPostgresControlPlaneUrl } from "../runtime-deps"
import {
  startVerificationSession,
  getVerificationSession,
  recordVeryBridgeSession,
  completeVerificationSession,
  completeSelfVerificationCallback,
} from "./verification-session-service"
import {
  startNamespaceVerificationSession,
  getNamespaceVerificationSession,
  completeNamespaceVerificationSession,
  getNamespaceVerification,
} from "./namespace-verification-service"
import type {
  Env,
  NamespaceVerification,
  NamespaceVerificationSession,
  RequestedVerificationCapability,
  VerificationRequirement,
  VerificationIntent,
  VerificationSession,
} from "../../types"

type VerificationProviderMode = "qr_deeplink" | "widget" | "native_sdk"

export * from "./verification-shared"
export * from "./verification-session-service"
export * from "./namespace-verification-service"

export interface VerificationRepository {
  startVerificationSession(input: {
    userId: string
    provider: "self" | "very"
    providerMode?: VerificationProviderMode | null
    requestedCapabilities?: RequestedVerificationCapability[] | null
    verificationRequirements?: VerificationRequirement[] | null
    walletAttachmentId?: string | null
    verificationIntent?: VerificationIntent | null
    policyId?: string | null
    publicOrigin?: string | null
  }): Promise<VerificationSession>
  getVerificationSession(verificationSessionId: string, userId: string): Promise<VerificationSession | null>
  recordVeryBridgeSession(input: {
    verificationSessionId: string
    userId: string
    providerSessionId: string
  }): Promise<boolean | null>
  completeVerificationSession(input: {
    verificationSessionId: string
    userId: string
    attestationId?: string | null
    proof?: unknown
    proofHash?: string | null
    providerPayloadRef?: unknown
  }): Promise<VerificationSession | null>
  completeSelfVerificationCallback(input: {
    verificationSessionId: string
    payload: Record<string, unknown>
  }): Promise<VerificationSession | null>
  startNamespaceVerificationSession(input: {
    userId: string
    family: "hns" | "spaces"
    rootLabel: string
  }): Promise<NamespaceVerificationSession>
  getNamespaceVerificationSession(
    namespaceVerificationSessionId: string,
    userId: string,
  ): Promise<NamespaceVerificationSession | null>
  completeNamespaceVerificationSession(input: {
    namespaceVerificationSessionId: string
    userId: string
    restartChallenge?: boolean | null
  }): Promise<NamespaceVerificationSession | null>
  getNamespaceVerification(namespaceVerificationId: string, userId: string): Promise<NamespaceVerification | null>
}

export class ControlPlaneVerificationRepository implements VerificationRepository {
  constructor(
    private readonly client: Client,
    private readonly env: Env,
  ) {}

  async startVerificationSession(input: {
    userId: string
    provider: "self" | "very"
    providerMode?: VerificationProviderMode | null
    requestedCapabilities?: RequestedVerificationCapability[] | null
    verificationRequirements?: VerificationRequirement[] | null
    walletAttachmentId?: string | null
    verificationIntent?: VerificationIntent | null
    policyId?: string | null
    publicOrigin?: string | null
  }): Promise<VerificationSession> {
    return startVerificationSession(this.client, this.env, input)
  }

  async getVerificationSession(verificationSessionId: string, userId: string): Promise<VerificationSession | null> {
    return getVerificationSession(this.client, verificationSessionId, userId)
  }

  async recordVeryBridgeSession(input: {
    verificationSessionId: string
    userId: string
    providerSessionId: string
  }): Promise<boolean | null> {
    return recordVeryBridgeSession(this.client, input)
  }

  async completeVerificationSession(input: {
    verificationSessionId: string
    userId: string
    attestationId?: string | null
    proof?: unknown
    proofHash?: string | null
    providerPayloadRef?: unknown
  }): Promise<VerificationSession | null> {
    return completeVerificationSession(this.client, this.env, input)
  }

  async completeSelfVerificationCallback(input: {
    verificationSessionId: string
    payload: Record<string, unknown>
  }): Promise<VerificationSession | null> {
    return completeSelfVerificationCallback(this.client, this.env, input)
  }

  async startNamespaceVerificationSession(input: {
    userId: string
    family: "hns" | "spaces"
    rootLabel: string
  }): Promise<NamespaceVerificationSession> {
    return startNamespaceVerificationSession(this.client, this.env, input)
  }

  async getNamespaceVerificationSession(
    namespaceVerificationSessionId: string,
    userId: string,
  ): Promise<NamespaceVerificationSession | null> {
    return getNamespaceVerificationSession(this.client, namespaceVerificationSessionId, userId)
  }

  async completeNamespaceVerificationSession(input: {
    namespaceVerificationSessionId: string
    userId: string
    restartChallenge?: boolean | null
  }): Promise<NamespaceVerificationSession | null> {
    return completeNamespaceVerificationSession(this.client, this.env, input)
  }

  async getNamespaceVerification(namespaceVerificationId: string, userId: string): Promise<NamespaceVerification | null> {
    return getNamespaceVerification(this.client, namespaceVerificationId, userId)
  }
}

export function getControlPlaneVerificationRepository(env: Env): ControlPlaneVerificationRepository {
  const client = getControlPlaneClient(env)
  const cacheKey = [
    getControlPlaneCacheKey(env),
    String(env.VERY_API_URL || ""),
    String(env.VERY_VERIFY_URL || ""),
    String(env.VERY_APP_ID || ""),
    String(env.PIRATE_API_PUBLIC_ORIGIN || ""),
    String(env.HNS_VERIFIER_BASE_URL || ""),
    String(env.HNS_VERIFIER_AUTH_TOKEN || ""),
    String(env.ENVIRONMENT || ""),
  ].join("|")

  if (isPostgresControlPlaneUrl(getControlPlaneCacheKey(env))) {
    return new ControlPlaneVerificationRepository(client, env)
  }

  return globalSingleton("controlPlaneVerificationRepository", cacheKey, () =>
    new ControlPlaneVerificationRepository(client, env),
  )
}
