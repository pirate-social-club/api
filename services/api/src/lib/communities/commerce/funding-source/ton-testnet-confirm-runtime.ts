import { getControlPlaneClient, withRequestControlPlaneClients } from "../../../runtime-deps"
import { badRequestError } from "../../../errors"
import type { Env } from "../../../../env"
import type { CommunityDatabaseBindingRepository } from "../../db-community-repository"
import { confirmTonTestnetFunding } from "./ton-testnet-confirm"
import type { TonTestnetClient, TonTestnetTx } from "./ton-testnet-resolver"
import type { SpendIntentRow } from "./spend-intent"

type TonTestnetRuntimeEnv = {
  PIRATE_TON_TESTNET_RECIPIENT?: string
  PIRATE_TON_TESTNET_API_BASE?: string
  PIRATE_TON_TESTNET_API_KEY?: string
  PIRATE_TON_TESTNET_MIN_AMOUNT_NANO?: string
}

function pick(record: unknown, key: string): unknown {
  return record && typeof record === "object" ? (record as Record<string, unknown>)[key] : undefined
}

// Pure parse of a toncenter v3 GET /transactions response into our minimal TonTestnetTx. Field
// paths are per toncenter v3 docs: top-level { transactions: [...] }, in_msg.destination,
// in_msg.value (nanotons), and a text comment at in_msg.message_content.decoded.comment ONLY when
// decoded.type === "text_comment". Returns null on any shape mismatch so the resolver stays
// "pending" rather than confirming anything wrong. Exported for fixture-driven regression tests.
//
// STILL UNVALIDATED against a live response — replace/augment the test fixture with a real capture
// (see the curl in the regression test) and adjust here if the live shape differs.
export function parseToncenterTransaction(body: unknown, txHash: string): TonTestnetTx | null {
  const transactions = pick(body, "transactions")
  const tx = Array.isArray(transactions) ? transactions[0] : null
  const inMsg = pick(tx, "in_msg")
  const toAddress = pick(inMsg, "destination")
  if (typeof toAddress !== "string" || !toAddress) {
    return null
  }
  const value = pick(inMsg, "value")
  const amountNano = typeof value === "string" ? value : typeof value === "number" ? String(value) : "0"
  const decoded = pick(pick(inMsg, "message_content"), "decoded")
  const isTextComment = pick(decoded, "type") === "text_comment"
  const comment = pick(decoded, "comment")
  const payload = isTextComment && typeof comment === "string" ? comment : null
  return { hash: txHash, toAddress, amountNano, payload }
}

// Real TON testnet observation client. Returns null when the tx is not found or the shape does
// not match, so the resolver treats it as pending. Dev-only; never produces a canonical ref.
export function createToncenterTonTestnetClient(config: {
  apiBase: string
  apiKey?: string
}): TonTestnetClient {
  return {
    getTransaction: async (txHash: string): Promise<TonTestnetTx | null> => {
      const url = new URL("/api/v3/transactions", config.apiBase)
      url.searchParams.set("hash", txHash)
      url.searchParams.set("limit", "1")
      const response = await fetch(url, {
        headers: config.apiKey ? { "X-API-Key": config.apiKey } : {},
      })
      if (!response.ok) {
        return null
      }
      const body = (await response.json().catch(() => null)) as unknown
      return parseToncenterTransaction(body, txHash)
    },
  }
}

export async function runConfirmTonTestnetFunding(input: {
  env: Env
  communityRepository: CommunityDatabaseBindingRepository
  spendIntentId: string
  tonTxHash: string
  now: string
  authorize?: (intent: SpendIntentRow) => void | Promise<void>
}): Promise<SpendIntentRow> {
  const env = input.env as TonTestnetRuntimeEnv
  const expectedRecipient = env.PIRATE_TON_TESTNET_RECIPIENT?.trim()
  const apiBase = env.PIRATE_TON_TESTNET_API_BASE?.trim()
  if (!expectedRecipient || !apiBase) {
    throw badRequestError(
      "TON testnet is not configured (PIRATE_TON_TESTNET_RECIPIENT / PIRATE_TON_TESTNET_API_BASE)",
    )
  }
  const tonClient = createToncenterTonTestnetClient({
    apiBase,
    apiKey: env.PIRATE_TON_TESTNET_API_KEY?.trim(),
  })

  return await withRequestControlPlaneClients(async () => {
    const controlPlaneClient = getControlPlaneClient(input.env)
    return await confirmTonTestnetFunding(
      {
        controlPlaneClient,
        spendIntentId: input.spendIntentId,
        tonTxHash: input.tonTxHash,
        expectedRecipient,
        minAmountNano: env.PIRATE_TON_TESTNET_MIN_AMOUNT_NANO?.trim() ?? null,
        now: input.now,
        authorize: input.authorize,
      },
      { tonClient },
    )
  })
}
