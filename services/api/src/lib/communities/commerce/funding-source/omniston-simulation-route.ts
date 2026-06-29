import type { Env } from "../../../../env"
import { badRequestError, notFoundError } from "../../../errors"
import type { CommunityRepository } from "../../db-community-repository"
import type { SpendIntentRow } from "./spend-intent"
import type { SimulatedOmnistonRoute } from "./omniston-simulation-resolver"

type MiniAppVerifier = (args: {
  env: Env
  communityId: string
  initData: string
}) => Promise<{ id: string }> | { id: string }

type CommonRouteDeps = {
  omnistonSimulationEnabled: boolean
  getCommunityRepository: (env: Env) => CommunityRepository
  resolveCommunityId: (
    repo: CommunityRepository,
    identifier: string,
  ) => Promise<string | null>
  verifyMiniAppUser: MiniAppVerifier
}

export type StartSimulatedOmnistonRouteDeps = CommonRouteDeps & {
  runStart: (input: {
    env: Env
    communityRepository: CommunityRepository
    spendIntentId: string
    now: string
    authorize?: (intent: SpendIntentRow) => void | Promise<void>
  }) => Promise<SpendIntentRow>
}

export type ConfirmSimulatedOmnistonRouteDeps = CommonRouteDeps & {
  runConfirm: (input: {
    env: Env
    communityRepository: CommunityRepository
    spendIntentId: string
    routeRef: string
    minBaseUsdcAtomic: string
    simulatedRoute: SimulatedOmnistonRoute | null
    now: string
    authorize?: (intent: SpendIntentRow) => void | Promise<void>
  }) => Promise<SpendIntentRow>
}

export type SimulatedOmnistonResponse = {
  intentId: string
  status: SpendIntentRow["status"]
  routeRef?: string | null
  purchaseComplete: false
  fundsMoved: false
}

function bodyString(body: Record<string, unknown>, key: string): string {
  return typeof body[key] === "string" ? body[key].trim() : ""
}

function bodyObject(body: Record<string, unknown>, key: string): Record<string, unknown> | null {
  const value = body[key]
  return value && typeof value === "object" && !Array.isArray(value)
    ? value as Record<string, unknown>
    : null
}

function parseSimulatedRoute(value: Record<string, unknown> | null): SimulatedOmnistonRoute | null {
  if (!value) return null
  const status = bodyString(value, "status")
  if (
    status !== "cancelled"
    && status !== "delivered"
    && status !== "failed"
    && status !== "pending"
    && status !== "underdelivered"
  ) {
    throw badRequestError("simulated_route.status is required")
  }
  const routeRef = bodyString(value, "route_ref")
  if (!routeRef) {
    throw badRequestError("simulated_route.route_ref is required")
  }
  return {
    routeRef,
    sourceTxRef: bodyString(value, "source_tx_ref") || null,
    sourcePayload: bodyString(value, "source_payload") || null,
    destinationTxRef: bodyString(value, "destination_tx_ref") || null,
    deliveredBaseUsdcAtomic: bodyString(value, "delivered_base_usdc_atomic") || null,
    status,
  }
}

async function resolveAuthedIntentScope(
  input: { env: Env; body: Record<string, unknown> },
  deps: CommonRouteDeps,
): Promise<{
  communityRepository: CommunityRepository
  communityId: string
  spendIntentId: string
  telegramUserId: string
}> {
  if (!deps.omnistonSimulationEnabled) {
    throw notFoundError("Not found")
  }

  const communityIdentifier = bodyString(input.body, "community_id")
  const initData = bodyString(input.body, "init_data")
  const spendIntentId = bodyString(input.body, "spend_intent_id")
  if (!communityIdentifier || !initData || !spendIntentId) {
    throw badRequestError("community_id, init_data, and spend_intent_id are required")
  }

  const communityRepository = deps.getCommunityRepository(input.env)
  const communityId = await deps.resolveCommunityId(communityRepository, communityIdentifier)
  if (!communityId) {
    throw badRequestError("Community was not found")
  }
  const telegramUser = await deps.verifyMiniAppUser({ env: input.env, communityId, initData })
  return { communityRepository, communityId, spendIntentId, telegramUserId: telegramUser.id }
}

function authorizeSimulationIntent(input: {
  communityId: string
  telegramUserId: string
}): (intent: SpendIntentRow) => void {
  return (loaded) => {
    if (loaded.telegram_user_id !== input.telegramUserId || loaded.community_id !== input.communityId) {
      throw notFoundError("Spend intent not found")
    }
  }
}

export async function handleStartSimulatedOmnistonFunding(
  input: { env: Env; body: unknown; now: string },
  deps: StartSimulatedOmnistonRouteDeps,
): Promise<SimulatedOmnistonResponse> {
  const body = input.body && typeof input.body === "object" ? input.body as Record<string, unknown> : {}
  const scope = await resolveAuthedIntentScope({ env: input.env, body }, deps)
  const intent = await deps.runStart({
    env: input.env,
    communityRepository: scope.communityRepository,
    spendIntentId: scope.spendIntentId,
    now: input.now,
    authorize: authorizeSimulationIntent(scope),
  })
  return {
    intentId: intent.spend_intent_id,
    status: intent.status,
    purchaseComplete: false,
    fundsMoved: false,
  }
}

export async function handleConfirmSimulatedOmnistonFunding(
  input: { env: Env; body: unknown; now: string },
  deps: ConfirmSimulatedOmnistonRouteDeps,
): Promise<SimulatedOmnistonResponse> {
  const body = input.body && typeof input.body === "object" ? input.body as Record<string, unknown> : {}
  const scope = await resolveAuthedIntentScope({ env: input.env, body }, deps)
  const routeRef = bodyString(body, "route_ref")
  const minBaseUsdcAtomic = bodyString(body, "min_base_usdc_atomic")
  if (!routeRef || !minBaseUsdcAtomic) {
    throw badRequestError("route_ref and min_base_usdc_atomic are required")
  }
  const intent = await deps.runConfirm({
    env: input.env,
    communityRepository: scope.communityRepository,
    spendIntentId: scope.spendIntentId,
    routeRef,
    minBaseUsdcAtomic,
    simulatedRoute: parseSimulatedRoute(bodyObject(body, "simulated_route")),
    now: input.now,
    authorize: authorizeSimulationIntent(scope),
  })
  return {
    intentId: intent.spend_intent_id,
    status: intent.status,
    routeRef,
    purchaseComplete: false,
    fundsMoved: false,
  }
}
