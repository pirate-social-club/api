import { globalSingleton } from "../db-helpers"
import { getControlPlaneCacheKey, getControlPlaneClient, isPostgresControlPlaneUrl } from "../runtime-deps"
import type { Env } from "../../env"
import type {
  AgentDelegatedCredential,
  AgentChallenge,
  AgentHandle,
  AgentOwnershipPairing,
  AgentOwnershipPairingClaimResult,
  AgentOwnershipSession,
  PublicAgentResolution,
  UserAgent,
  UserAgentListResponse,
} from "./types"
import {
  claimAgentOwnershipPairingCode,
  claimUserAgentHandle,
  completeAgentOwnershipSessionWithConnectionToken,
  createAgentOwnershipPairingCode,
  completeAgentOwnershipSessionFromCallback,
  completeAgentOwnershipSession,
  getAgentOwnershipSession,
  getUserAgentHandle,
  getUserAgent,
  issueAgentDelegatedCredential,
  issueAgentDelegatedCredentialWithConnectionToken,
  listUserAgents,
  refreshAgentDelegatedCredential,
  refreshAgentDelegatedCredentialWithConnectionToken,
  resolvePublicAgentByHandle,
  seedUserAgentForAdmin,
  startAgentOwnershipSession,
  updateUserAgentDisplayName,
  verifyAgentDelegatedAccessToken,
} from "./agent-ownership-service"
import type { Client } from "../sql-client"

interface AgentOwnershipRepository {
  createAgentOwnershipPairingCode(input: {
    userId: string
  }): Promise<AgentOwnershipPairing>
  claimAgentOwnershipPairingCode(input: {
    pairingCode: string
    agentChallenge: AgentChallenge
  }): Promise<AgentOwnershipPairingClaimResult>
  startAgentOwnershipSession(input: {
    userId: string
    sessionKind: AgentOwnershipSession["session_kind"]
    ownershipProvider: AgentOwnershipSession["ownership_provider"]
    agentId?: string | null
    displayName?: string | null
    policyId?: string | null
    agentChallenge: AgentChallenge
  }): Promise<AgentOwnershipSession>
  getAgentOwnershipSession(agentOwnershipSessionId: string, userId: string): Promise<AgentOwnershipSession | null>
  completeAgentOwnershipSession(input: {
    agentOwnershipSessionId: string
    userId: string
    providerPayloadRef?: string | null
  }): Promise<AgentOwnershipSession | null>
  completeAgentOwnershipSessionWithConnectionToken(input: {
    agentOwnershipSessionId: string
    connectionToken: string
    providerPayloadRef?: string | null
  }): Promise<AgentOwnershipSession | null>
  completeAgentOwnershipSessionFromCallback(input: {
    agentOwnershipSessionId: string
    provider: AgentOwnershipSession["ownership_provider"] | null
    attestationId?: string | null
    proofHash?: string | null
    payload?: Record<string, unknown> | null
    callbackSecret: string | null
  }): Promise<AgentOwnershipSession | null>
  listUserAgents(userId: string, input: { cursor?: string | null; limit: number }): Promise<UserAgentListResponse>
  getUserAgent(agentId: string, userId: string): Promise<UserAgent | null>
  updateUserAgentDisplayName(input: {
    agentId: string
    userId: string
    displayName: string
  }): Promise<UserAgent | null>
  getUserAgentHandle(input: {
    agentId: string
    userId: string
  }): Promise<AgentHandle | null>
  claimUserAgentHandle(input: {
    agentId: string
    userId: string
    desiredLabel: string
  }): Promise<AgentHandle | null>
  seedUserAgentForAdmin(input: {
    userId: string
    displayName: string
    desiredLabel?: string | null
  }): Promise<UserAgent>
  resolvePublicAgentByHandle(handleLabel: string): Promise<PublicAgentResolution | null>
  issueAgentDelegatedCredential(input: {
    agentId: string
    userId: string
    currentOwnershipRecordId?: string | null
  }): Promise<AgentDelegatedCredential>
  issueAgentDelegatedCredentialWithConnectionToken(input: {
    agentId: string
    connectionToken: string
    currentOwnershipRecordId?: string | null
  }): Promise<AgentDelegatedCredential>
  refreshAgentDelegatedCredential(input: {
    agentId: string
    userId: string
    refreshToken: string
  }): Promise<AgentDelegatedCredential>
  refreshAgentDelegatedCredentialWithConnectionToken(input: {
    agentId: string
    connectionToken: string
    refreshToken: string
  }): Promise<AgentDelegatedCredential>
  verifyAgentDelegatedAccessToken(input: {
    accessToken: string
  }): Promise<{
    userId: string
    agentId: string
    currentOwnershipRecordId: string
  }>
}

export class ControlPlaneAgentOwnershipRepository implements AgentOwnershipRepository {
  constructor(
    private readonly client: Client,
    private readonly env: Env,
  ) {}

  async createAgentOwnershipPairingCode(input: {
    userId: string
  }): Promise<AgentOwnershipPairing> {
    return createAgentOwnershipPairingCode(this.client, input)
  }

  async claimAgentOwnershipPairingCode(input: {
    pairingCode: string
    agentChallenge: AgentChallenge
  }): Promise<AgentOwnershipPairingClaimResult> {
    return claimAgentOwnershipPairingCode(this.client, this.env, input)
  }

  async startAgentOwnershipSession(input: {
    userId: string
    sessionKind: AgentOwnershipSession["session_kind"]
    ownershipProvider: AgentOwnershipSession["ownership_provider"]
    agentId?: string | null
    displayName?: string | null
    policyId?: string | null
    agentChallenge: AgentChallenge
  }): Promise<AgentOwnershipSession> {
    return startAgentOwnershipSession(this.client, this.env, input)
  }

  async getAgentOwnershipSession(agentOwnershipSessionId: string, userId: string): Promise<AgentOwnershipSession | null> {
    return getAgentOwnershipSession(this.client, agentOwnershipSessionId, userId)
  }

  async completeAgentOwnershipSession(input: {
    agentOwnershipSessionId: string
    userId: string
    providerPayloadRef?: string | null
  }): Promise<AgentOwnershipSession | null> {
    return completeAgentOwnershipSession(this.client, this.env, input)
  }

  async completeAgentOwnershipSessionWithConnectionToken(input: {
    agentOwnershipSessionId: string
    connectionToken: string
    providerPayloadRef?: string | null
  }): Promise<AgentOwnershipSession | null> {
    return completeAgentOwnershipSessionWithConnectionToken(this.client, this.env, input)
  }

  async completeAgentOwnershipSessionFromCallback(input: {
    agentOwnershipSessionId: string
    provider: AgentOwnershipSession["ownership_provider"] | null
    attestationId?: string | null
    proofHash?: string | null
    payload?: Record<string, unknown> | null
    callbackSecret: string | null
  }): Promise<AgentOwnershipSession | null> {
    return completeAgentOwnershipSessionFromCallback(this.client, this.env, input)
  }

  async listUserAgents(userId: string, input: { cursor?: string | null; limit: number }): Promise<UserAgentListResponse> {
    return listUserAgents(this.client, userId, input)
  }

  async getUserAgent(agentId: string, userId: string): Promise<UserAgent | null> {
    return getUserAgent(this.client, agentId, userId)
  }

  async updateUserAgentDisplayName(input: {
    agentId: string
    userId: string
    displayName: string
  }): Promise<UserAgent | null> {
    return updateUserAgentDisplayName(this.client, input)
  }

  async getUserAgentHandle(input: {
    agentId: string
    userId: string
  }): Promise<AgentHandle | null> {
    return getUserAgentHandle(this.client, input)
  }

  async claimUserAgentHandle(input: {
    agentId: string
    userId: string
    desiredLabel: string
  }): Promise<AgentHandle | null> {
    return claimUserAgentHandle(this.client, input)
  }

  async seedUserAgentForAdmin(input: {
    userId: string
    displayName: string
    desiredLabel?: string | null
  }): Promise<UserAgent> {
    return seedUserAgentForAdmin(this.client, input)
  }

  async resolvePublicAgentByHandle(handleLabel: string): Promise<PublicAgentResolution | null> {
    return resolvePublicAgentByHandle(this.client, handleLabel)
  }

  async issueAgentDelegatedCredential(input: {
    agentId: string
    userId: string
    currentOwnershipRecordId?: string | null
  }): Promise<AgentDelegatedCredential> {
    return issueAgentDelegatedCredential(this.client, input)
  }

  async issueAgentDelegatedCredentialWithConnectionToken(input: {
    agentId: string
    connectionToken: string
    currentOwnershipRecordId?: string | null
  }): Promise<AgentDelegatedCredential> {
    return issueAgentDelegatedCredentialWithConnectionToken(this.client, input)
  }

  async refreshAgentDelegatedCredential(input: {
    agentId: string
    userId: string
    refreshToken: string
  }): Promise<AgentDelegatedCredential> {
    return refreshAgentDelegatedCredential(this.client, input)
  }

  async refreshAgentDelegatedCredentialWithConnectionToken(input: {
    agentId: string
    connectionToken: string
    refreshToken: string
  }): Promise<AgentDelegatedCredential> {
    return refreshAgentDelegatedCredentialWithConnectionToken(this.client, input)
  }

  async verifyAgentDelegatedAccessToken(input: {
    accessToken: string
  }): Promise<{
    userId: string
    agentId: string
    currentOwnershipRecordId: string
  }> {
    return verifyAgentDelegatedAccessToken(this.client, input)
  }
}

export function getControlPlaneAgentOwnershipRepository(env: Env): ControlPlaneAgentOwnershipRepository {
  const client = getControlPlaneClient(env)
  const cacheKey = [
    getControlPlaneCacheKey(env),
    String(env.CLAWKEY_API_URL || ""),
    String(env.ENVIRONMENT || ""),
  ].join("|")

  if (isPostgresControlPlaneUrl(getControlPlaneCacheKey(env))) {
    return new ControlPlaneAgentOwnershipRepository(client, env)
  }

  return globalSingleton("controlPlaneAgentOwnershipRepository", cacheKey, () =>
    new ControlPlaneAgentOwnershipRepository(client, env),
  )
}
