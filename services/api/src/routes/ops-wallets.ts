import { formatEther, formatUnits } from "ethers"
import { Hono, type Context } from "hono"
import { authenticateAdminTokenOnly, type AuthenticatedEnv } from "../lib/auth-middleware"
import { getRuntimeWalletFundingStatuses } from "../lib/ops-alerts/runtime-wallet-funding-watchdog"
import { getStoryRuntimeSignerBalances } from "../lib/story/story-runtime-funding"
import { resolveEnforcedFloorWei, resolveStorySignerExplorerUrl } from "../lib/story/story-runtime-funding-watchdog"
import { resolveStoryChainId } from "../lib/story/story-runtime-config"
import { getControlPlaneClient } from "../lib/runtime-deps"
import { listFundingReceiptsForRefundReview } from "../lib/communities/commerce/observed-funding-receipts"

const opsWallets = new Hono<AuthenticatedEnv>()

opsWallets.get("/funding-refund-reviews", async (c) => {
  if (!requireOpsAdmin(c)) return c.json({ error: "unauthorized" }, 401)
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
  return authenticateAdminTokenOnly({
    env: c.env,
    token: c.req.header("x-admin-token"),
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
  if (!requireOpsAdmin(c)) {
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
