import { exchangeMemoryIdentity } from "./memory-auth-store"
import type { UpstreamIdentity } from "../../../types"
import type { SessionSnapshot } from "../auth-db-rows"

export class MemorySessionRepository {
  async exchangeIdentity(identity: UpstreamIdentity): Promise<SessionSnapshot> {
    return await exchangeMemoryIdentity(identity)
  }
}
