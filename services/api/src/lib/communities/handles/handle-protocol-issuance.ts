import type { CommunityHandleClaimRequest } from "../../../types"
import type { UserRepository, WalletAttachmentRecord } from "../../auth/repositories"
import { parseBitcoinAddress, type ParsedBitcoinAddress } from "../../bitcoin/bitcoin-address"
import { eligibilityFailed, HttpError, notFoundError } from "../../errors"
import { makeId } from "../../helpers"
import type { Client, Transaction } from "../../sql-client"
import {
  type HandleClaimSettings,
  type NamespacePolicyRow,
  namespaceSupportsSpacesSubspace,
  protocolIssuanceRequired,
} from "./handle-policy-service"

function parentSpaceFromNamespaceLabel(normalizedLabel: string): string {
  const bareLabel = normalizedLabel.startsWith("@") ? normalizedLabel.slice(1) : normalizedLabel
  return `@${bareLabel}`
}

function protocolSnameForHandle(labelNormalized: string, parentSpace: string): string {
  return `${labelNormalized}@${parentSpace.startsWith("@") ? parentSpace.slice(1) : parentSpace}`
}

export function requireProtocolIssuanceSupport(
  policy: Pick<NamespacePolicyRow, "display_label" | "normalized_label" | "route_family">,
  settings: HandleClaimSettings,
): boolean {
  if (!protocolIssuanceRequired(settings)) {
    return false
  }
  if (!namespaceSupportsSpacesSubspace(policy)) {
    throw eligibilityFailed("Protocol-issued names require a Spaces namespace")
  }
  throw eligibilityFailed("Protocol-issued community names are temporarily unavailable")
}

export function findTaprootProtocolOwnerWallet(
  wallets: Array<Pick<WalletAttachmentRecord, "chain_namespace" | "wallet_address" | "wallet_attachment">>,
): { wallet: Pick<WalletAttachmentRecord, "chain_namespace" | "wallet_address" | "wallet_attachment">; parsed: ParsedBitcoinAddress } | null {
  for (const wallet of wallets) {
    if (!wallet.chain_namespace.startsWith("bip122:")) {
      continue
    }
    const parsed = parseBitcoinAddress(wallet.wallet_address)
    if (parsed?.kind === "p2tr") {
      return { wallet, parsed }
    }
  }
  return null
}

export async function requireProtocolOwnerWalletForClaim(input: {
  body: CommunityHandleClaimRequest
  userId: string
  userRepository: UserRepository
}): Promise<{ walletAttachmentId: string; scriptPubkeyHex: string }> {
  const submittedWalletAttachment = input.body.protocol_owner_wallet_attachment?.trim()
  if (!submittedWalletAttachment) {
    throw new HttpError(400, "bad_request", "protocol_owner_wallet_attachment is required for protocol-issued names", false, {
      protocol_owner_wallet_attachment: "missing",
    })
  }

  const wallet = await input.userRepository.getWalletAttachmentById(submittedWalletAttachment)
  if (!wallet) {
    throw notFoundError("protocol_owner_wallet_attachment was not found")
  }
  if (wallet.user_id !== input.userId) {
    throw eligibilityFailed("protocol_owner_wallet_attachment belongs to a different user", {
      protocol_owner_wallet_attachment: "wrong_user",
    })
  }
  if (wallet.status !== "active") {
    throw eligibilityFailed("protocol_owner_wallet_attachment is not active", {
      protocol_owner_wallet_attachment: "not_active",
    })
  }
  if (!wallet.chain_namespace.startsWith("bip122:")) {
    throw eligibilityFailed("protocol_owner_wallet_attachment must be a Bitcoin wallet", {
      protocol_owner_wallet_attachment: "wrong_chain",
      chain_namespace: wallet.chain_namespace,
    })
  }

  const parsed = parseBitcoinAddress(wallet.wallet_address)
  if (!parsed) {
    throw eligibilityFailed("protocol_owner_wallet_attachment has an invalid Bitcoin address", {
      protocol_owner_wallet_attachment: "invalid_bitcoin_address",
    })
  }
  if (parsed.kind !== "p2tr") {
    throw eligibilityFailed("protocol_owner_wallet_attachment must be a Bitcoin Taproot wallet", {
      protocol_owner_wallet_attachment: "not_taproot",
      bitcoin_address_kind: parsed.kind,
    })
  }

  return {
    walletAttachmentId: wallet.wallet_attachment,
    scriptPubkeyHex: parsed.scriptPubkeyHex,
  }
}

export async function createProtocolIssuanceForHandle(input: {
  executor: Client | Transaction
  communityId: string
  namespaceId: string
  namespaceNormalizedLabel: string
  communityHandleId: string
  labelNormalized: string
  scriptPubkeyHex: string
  now: string
}): Promise<void> {
  const parentSpace = parentSpaceFromNamespaceLabel(input.namespaceNormalizedLabel)
  const sname = protocolSnameForHandle(input.labelNormalized, parentSpace)
  await input.executor.execute({
    sql: `
      INSERT INTO community_handle_protocol_issuances (
        community_handle_protocol_issuance_id,
        community_handle_id,
        protocol_issuance_batch_id,
        community_id,
        namespace_id,
        public_status,
        parent_space,
        sname,
        script_pubkey_hex,
        cert_ref,
        certificate_payload_ref,
        error_code,
        error_message,
        created_at,
        updated_at,
        issued_at
      ) VALUES (
        ?1,
        ?2,
        NULL,
        ?3,
        ?4,
        'issuing',
        ?5,
        ?6,
        ?7,
        NULL,
        NULL,
        NULL,
        NULL,
        ?8,
        ?8,
        NULL
      )
    `,
    args: [
      makeId("chpi"),
      input.communityHandleId,
      input.communityId,
      input.namespaceId,
      parentSpace,
      sname,
      input.scriptPubkeyHex,
      input.now,
    ],
  })
}
