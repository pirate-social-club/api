import { exposeMemoryWalletAttachments, getMemoryRecordByUserId, getMemoryWalletAttachmentById } from "./memory-auth-store"
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
}
