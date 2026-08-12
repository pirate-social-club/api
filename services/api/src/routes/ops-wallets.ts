import { formatEther, formatUnits } from "ethers"
import { Hono, type Context } from "hono"
import { authenticateAdminAccessOnly, type AuthenticatedEnv } from "../lib/auth-middleware"
import { ADMIN_OPERATIONS_MANAGE_SCOPE } from "../lib/operator-credential-auth"
import { getRuntimeWalletFundingStatuses } from "../lib/ops-alerts/runtime-wallet-funding-watchdog"
import { getStoryRuntimeSignerBalances } from "../lib/story/story-runtime-funding"
import { resolveEnforcedFloorWei, resolveStorySignerExplorerUrl } from "../lib/story/story-runtime-funding-watchdog"
import { resolveStoryChainId } from "../lib/story/story-runtime-config"
import { getControlPlaneClient } from "../lib/runtime-deps"
import { listFundingReceiptsForRefundReview } from "../lib/communities/commerce/observed-funding-receipts"
import {
  operatorSigningCoordinatorName,
  type OperatorSigningCoordinatorDO,
} from "../lib/communities/bookings/operator-signing-coordinator-do"
import {
  resolveRewardsSettlementChainId,
  resolveRewardsSettlementOperatorAddress,
} from "../lib/communities/bookings/booking-chain-config"

const opsWallets = new Hono<AuthenticatedEnv>()

opsWallets.get("/rewards-settlement-diagnostics", async (c) => {
  if (!await requireOpsAdmin(c)) return c.json({ error: "unauthorized" }, 401)
  const coordinatorRef = String(c.req.query("coordinator_ref") ?? "").trim()
  let parsed: unknown
  try {
    parsed = JSON.parse(coordinatorRef)
  } catch {
    return c.json({ error: "invalid_coordinator_ref" }, 400)
  }
  if (
    !Array.isArray(parsed)
    || parsed.length !== 2
    || (parsed[0] !== "reward_payout" && parsed[0] !== "reward_funding_refund")
    || typeof parsed[1] !== "string"
    || parsed[1].length < 1
    || parsed[1].length > 500
  ) {
    return c.json({ error: "invalid_coordinator_ref" }, 400)
  }
  const namespace = c.env.OPERATOR_SIGNING_COORDINATOR as DurableObjectNamespace<OperatorSigningCoordinatorDO> | undefined
  if (!namespace) return c.json({ error: "coordinator_unavailable" }, 503)
  const stub = namespace.getByName(operatorSigningCoordinatorName(
    resolveRewardsSettlementOperatorAddress(c.env),
    resolveRewardsSettlementChainId(c.env),
    "rewards",
  ))
  const result = await stub.lookupByKey(coordinatorRef)
  if (!result) return c.json({ error: "not_found" }, 404)
  return c.json({
    coordinator_ref: result.idempotencyKey,
    state: result.state,
    nonce: result.nonce,
    attempt_count: result.attemptCount ?? null,
    transaction_present: Boolean(result.txHash),
    transaction_hash: result.txHash ?? null,
    preparation_failure: result.preparationFailure ?? null,
    settlement_failure: result.settlementFailure ?? null,
  }, 200, {
    "cache-control": "private, no-store",
  })
})

opsWallets.get("/funding-refund-reviews", async (c) => {
  if (!await requireOpsAdmin(c)) return c.json({ error: "unauthorized" }, 401)
  const requestedLimit = Number.parseInt(c.req.query("limit") ?? "50", 10)
  const client = getControlPlaneClient(c.env)
  try {
    const items = await listFundingReceiptsForRefundReview({
      client,
      limit: Number.isFinite(requestedLimit) ? requestedLimit : 50,
    })
    return c.json({ items })
  } finally {
    client.close?.()
  }
})

function requireOpsAdmin(c: Context<AuthenticatedEnv>) {
  return authenticateAdminAccessOnly({
    env: c.env,
    authorization: c.req.header("authorization"),
    legacyToken: c.req.header("x-admin-token"),
    requiredScope: ADMIN_OPERATIONS_MANAGE_SCOPE,
  })
}

type WalletReport = {
  wallet: string
  address: `0x${string}`
  chain_id: number
  explorer_url: string | null
  native: { symbol: string; balance: string; floor: string; ok: boolean } | null
  usdc: { balance: string; floor: string; ok: boolean } | null
  error?: string
}

// One place to see every operator wallet the backend controls: the four Story
// runtime signers (checked against the same enforced floors the registration
// path asserts) plus every wallet the runtime funding watchdog covers.
opsWallets.get("/wallets", async (c) => {
  if (!await requireOpsAdmin(c)) {
    return c.json({ error: "unauthorized" }, 401)
  }

  const wallets: WalletReport[] = []
  const storyChainId = resolveStoryChainId(c.env)

  try {
    const balances = await getStoryRuntimeSignerBalances(c.env)
    for (const signer of balances) {
      const floorWei = resolveEnforcedFloorWei(c.env, signer.name)
      wallets.push({
        wallet: signer.name,
        address: signer.address,
        chain_id: storyChainId,
        explorer_url: resolveStorySignerExplorerUrl(storyChainId, signer.address),
        native: {
          symbol: "IP",
          balance: formatEther(signer.balanceWei),
          floor: formatEther(floorWei),
          ok: signer.balanceWei >= floorWei,
        },
        usdc: null,
      })
    }
  } catch (error) {
    wallets.push({
      wallet: "story-runtime-signers",
      address: "0x0000000000000000000000000000000000000000",
      chain_id: storyChainId,
      explorer_url: null,
      native: null,
      usdc: null,
      error: error instanceof Error ? error.message : String(error),
    })
  }

  const statuses = await getRuntimeWalletFundingStatuses(c.env)
  for (const status of statuses) {
    wallets.push({
      wallet: status.wallet,
      address: status.address,
      chain_id: status.chainId,
      explorer_url: status.explorerUrl,
      native: status.native
        ? {
            symbol: status.native.symbol,
            balance: formatEther(status.native.balanceWei),
            floor: formatEther(status.native.floorWei),
            ok: status.native.ok,
          }
        : null,
      usdc: status.token
        ? {
            balance: formatUnits(status.token.balanceAtomic, 6),
            floor: formatUnits(status.token.floorAtomic, 6),
            ok: status.token.ok,
          }
        : null,
      ...(status.error ? { error: status.error } : {}),
    })
  }

  return c.json({
    ok: wallets.every((wallet) => !wallet.error && (wallet.native?.ok ?? true) && (wallet.usdc?.ok ?? true)),
    wallets,
  })
})

export default opsWallets
