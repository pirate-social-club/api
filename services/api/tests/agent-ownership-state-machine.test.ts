import { describe, expect, test } from "bun:test"
import {
  assertAgentOwnershipRecordStateTransition,
  assertAgentOwnershipSessionStatusTransition,
  assertUserAgentStatusTransition,
} from "../src/lib/agents/agent-ownership-state-machine"

describe("agent ownership state machine", () => {
  test("allows the current session lifecycle transitions used by the runtime", () => {
    expect(() => assertAgentOwnershipSessionStatusTransition(null, "awaiting_owner")).not.toThrow()
    expect(() => assertAgentOwnershipSessionStatusTransition("awaiting_owner", "proof_submitted")).not.toThrow()
    expect(() => assertAgentOwnershipSessionStatusTransition("awaiting_owner", "verified")).not.toThrow()
    expect(() => assertAgentOwnershipSessionStatusTransition("proof_submitted", "verified")).not.toThrow()
    expect(() => assertAgentOwnershipSessionStatusTransition("awaiting_owner", "failed")).not.toThrow()
    expect(() => assertAgentOwnershipSessionStatusTransition("awaiting_owner", "expired")).not.toThrow()
  })

  test("rejects invalid session shortcuts", () => {
    expect(() => assertAgentOwnershipSessionStatusTransition("failed", "verified")).toThrow(
      "agent_ownership_sessions.status cannot transition from failed to verified",
    )
    expect(() => assertAgentOwnershipSessionStatusTransition("verified", "proof_submitted")).toThrow(
      "agent_ownership_sessions.status cannot transition from verified to proof_submitted",
    )
  })

  test("allows current ownership record and user-agent creation states", () => {
    expect(() => assertAgentOwnershipRecordStateTransition(null, "verified")).not.toThrow()
    expect(() => assertUserAgentStatusTransition(null, "active")).not.toThrow()
  })

  test("rejects invalid ownership record and user-agent transitions", () => {
    expect(() => assertAgentOwnershipRecordStateTransition("expired", "verified")).toThrow(
      "agent_ownership_records.ownership_state cannot transition from expired to verified",
    )
    expect(() => assertUserAgentStatusTransition("revoked", "active")).toThrow(
      "user_agents.status cannot transition from revoked to active",
    )
  })
})
