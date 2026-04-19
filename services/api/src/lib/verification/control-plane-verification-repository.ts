import type { Client } from "../sql-client"
import { globalSingleton } from "../db-helpers"
import { getControlPlaneCacheKey, getControlPlaneClient } from "../runtime-deps"
import {
  startVerificationSession,
  getVerificationSession,
  completeVerificationSession,
} from "./control-plane-verification-session-service"
import {
  startNamespaceVerificationSession,
  getNamespaceVerificationSession,
  completeNamespaceVerificationSession,
  getNamespaceVerification,
} from "./control-plane-namespace-verification-service"
import type {
  Env,
  NamespaceVerification,
  NamespaceVerificationSession,
  RequestedVerificationCapability,
  VerificationIntent,
  VerificationSession,
} from "../../types"

export * from "./control-plane-verification-shared"
export * from "./control-plane-verification-session-service"
export * from "./control-plane-namespace-verification-service"

export interface VerificationRepository {
  startVerificationSession(input: {
    userId: string
    provider: "self" | "very"
    requestedCapabilities?: RequestedVerificationCapability[] | null
    walletAttachmentId?: string | null
    verificationIntent?: VerificationIntent | null
    policyId?: string | null
  }): Promise<VerificationSession>
  getVerificationSession(verificationSessionId: string, userId: string): Promise<VerificationSession | null>
  completeVerificationSession(input: {
    verificationSessionId: string
    userId: string
    attestationId?: string | null
    proof?: string | null
    proofHash?: string | null
    providerPayloadRef?: string | null
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
    signaturePayload?: Record<string, unknown> | null
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
    requestedCapabilities?: RequestedVerificationCapability[] | null
    walletAttachmentId?: string | null
    verificationIntent?: VerificationIntent | null
    policyId?: string | null
  }): Promise<VerificationSession> {
    return startVerificationSession(this.client, this.env, input)
  }

  async getVerificationSession(verificationSessionId: string, userId: string): Promise<VerificationSession | null> {
    return getVerificationSession(this.client, verificationSessionId, userId)
  }

  async completeVerificationSession(input: {
    verificationSessionId: string
    userId: string
    attestationId?: string | null
    proof?: string | null
    proofHash?: string | null
    providerPayloadRef?: string | null
  }): Promise<VerificationSession | null> {
    return completeVerificationSession(this.client, this.env, input)
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
    return getNamespaceVerificationSession(this.client, this.env, namespaceVerificationSessionId, userId)
  }

  async completeNamespaceVerificationSession(input: {
    namespaceVerificationSessionId: string
    userId: string
    restartChallenge?: boolean | null
    signaturePayload?: Record<string, unknown> | null
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
    String(env.VERY_API_KEY || ""),
    String(env.VERY_APP_ID || ""),
    String(env.HNS_VERIFIER_BASE_URL || ""),
    String(env.HNS_VERIFIER_AUTH_TOKEN || ""),
    String(env.ENVIRONMENT || ""),
  ].join("|")

  return globalSingleton("controlPlaneVerificationRepository", cacheKey, () =>
    new ControlPlaneVerificationRepository(client, env),
  )
}
