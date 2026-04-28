import { getMemoryRecordByUserId } from "./memory-auth-store"
import type { User, WalletAttachmentSummary } from "../../../types"

export class MemoryUserRepository {
  async getUserById(userId: string): Promise<User | null> {
    return getMemoryRecordByUserId(userId)?.user ?? null
  }

  async getWalletAttachmentsByUserId(userId: string): Promise<WalletAttachmentSummary[]> {
    return getMemoryRecordByUserId(userId)?.walletAttachments ?? []
  }
}
