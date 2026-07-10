import { getAddress } from "ethers"
import type { PublicProfileResolution } from "../auth/repositories"
import { badRequestError, notFoundError } from "../errors"
import type { Client, QueryResultRow } from "../sql-client"
import { requiredNumber, requiredString, rowValue, stringOrNull } from "../sql-row"
import { unixSeconds } from "../../serializers/time"

type WalletIdentityPublicName = {
  id: string
  label: string
  label_normalized: string
  status: "active"
  owner_kind: "wallet"
  owner_wallet_address: string
  chain_ref: string
  price_paid_cents: number
  currency: "USD"
  issued_at: number
  expires_at: number | null
  pirate_user_id: string | null
}

export type WalletIdentityResponse =
  | {
    object: "wallet_identity"
    chain_ref: string
    wallet_address: string
    display_label: string | null
    public_names: WalletIdentityPublicName[]
  }
  | {
    object: "wallet_identity_redirect"
    chain_ref: string
    wallet_address: string
    profile: string
      profile_handle: string
    }

export type NormalizedWalletIdentityInput = ReturnType<typeof normalizeWalletIdentityInput>

export function normalizeWalletIdentityInput(input: {
  chainRef: string
  walletAddress: string
}): { chainRef: string; walletAddress: string } {
  const chainRef = input.chainRef.trim()
  if (chainRef !== "eip155" && !/^eip155:\d+$/u.test(chainRef)) {
    throw badRequestError("chain_ref is unsupported")
  }

  try {
    return {
      chainRef,
      walletAddress: getAddress(input.walletAddress.trim()).toLowerCase(),
    }
  } catch {
    throw badRequestError("wallet_address is invalid")
  }
}

function serializePublicName(row: QueryResultRow): WalletIdentityPublicName {
  return {
    id: requiredString(row, "pirate_name_registration_id"),
    label: requiredString(row, "label_display"),
    label_normalized: requiredString(row, "label_normalized"),
    status: "active",
    owner_kind: "wallet",
    owner_wallet_address: requiredString(row, "owner_wallet_address_normalized"),
    chain_ref: requiredString(row, "chain_ref"),
    price_paid_cents: requiredNumber(row, "price_paid_cents"),
    currency: "USD",
    issued_at: unixSeconds(requiredString(row, "issued_at")),
    expires_at: stringOrNull(rowValue(row, "expires_at")) ? unixSeconds(requiredString(row, "expires_at")) : null,
    pirate_user_id: stringOrNull(rowValue(row, "pirate_user_id")),
  }
}

async function listWalletPublicNames(input: {
  client: Client
  chainRef: string
  walletAddress: string
}): Promise<WalletIdentityPublicName[]> {
  const result = await input.client.execute({
    sql: `
      SELECT
        pirate_name_registration_id,
        label_display,
        label_normalized,
        owner_wallet_address_normalized,
        chain_ref,
        price_paid_cents,
        issued_at,
        expires_at,
        pirate_user_id
      FROM pirate_name_registrations
      WHERE owner_kind = 'wallet'
        AND status = 'active'
        AND owner_wallet_address_normalized = ?1
        AND chain_ref = ?2
      ORDER BY issued_at ASC, label_normalized ASC
    `,
    args: [input.walletAddress, input.chainRef],
  })
  return result.rows.map(serializePublicName)
}

export async function resolveWalletIdentity(input: NormalizedWalletIdentityInput & {
  client: Client
  profileResolution: PublicProfileResolution | null
}): Promise<WalletIdentityResponse> {
  if (input.profileResolution) {
    return {
      object: "wallet_identity_redirect",
      chain_ref: input.chainRef,
      wallet_address: input.walletAddress,
      profile: input.profileResolution.profile.id,
      profile_handle: input.profileResolution.resolved_handle_label,
    }
  }

  const publicNames = await listWalletPublicNames({
    client: input.client,
    chainRef: input.chainRef,
    walletAddress: input.walletAddress,
  })
  if (publicNames.length === 0) {
    throw notFoundError("Wallet identity not found")
  }

  return {
    object: "wallet_identity",
    chain_ref: input.chainRef,
    wallet_address: input.walletAddress,
    display_label: publicNames[0]?.label ?? null,
    public_names: publicNames,
  }
}
