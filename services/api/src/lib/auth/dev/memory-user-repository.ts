import { exposeMemoryWalletAttachments, getMemoryRecordByUserId, getMemoryWalletAttachmentById, getPrimaryWalletAddress } from "./memory-auth-store"
import { badRequestError, notFoundError } from "../../errors"
import { nowIso } from "../../helpers"
import type { User, WalletAttachmentSummary } from "../../../types"

export class MemoryUserRepository {
  async getUserById(userId: string): Promise<User | null> {
    return getMemoryRecordByUserId(userId)?.user ?? null
  }

  async getWalletAttachmentsByUserId(userId: string): Promise<WalletAttachmentSummary[]> {
    return exposeMemoryWalletAttachments(getMemoryRecordByUserId(userId)?.walletAttachments ?? [])
  }

  async getWalletAttachmentById(walletAttachmentId: string): Promise<(WalletAttachmentSummary & { user_id: string; status: string }) | null> {
    return getMemoryWalletAttachmentById(walletAttachmentId)
  }

  async setIdentityWallet(userId: string, walletAttachmentId: string): Promise<User | null> {
    if (!walletAttachmentId.trim()) {
      throw badRequestError("A valid wallet_attachment_id is required")
    }
    const record = getMemoryRecordByUserId(userId)
    if (!record) {
      return null
    }
    const target = record.walletAttachments.find((attachment) => attachment.wallet_attachment_id === walletAttachmentId)
    if (!target) {
      throw notFoundError("Wallet attachment not found")
    }

    const updatedAt = nowIso()
    for (const attachment of record.walletAttachments) {
      attachment.is_primary = attachment.wallet_attachment_id === target.wallet_attachment_id
    }
    record.user.primary_wallet_attachment_id = target.wallet_attachment_id
    record.user.updated_at = updatedAt
    record.profile.primary_wallet_address = getPrimaryWalletAddress(record)
    record.profile.updated_at = updatedAt
    return record.user
  }
}
