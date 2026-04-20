import { internalError } from "../errors"
import type {
  AgentOwnershipSessionStatus,
  AgentOwnershipState,
  UserAgentStatus,
} from "./types"

type StateMachine<State extends string> = {
  initial: readonly State[]
  transitions: Readonly<Record<State, readonly State[]>>
}

export const AGENT_OWNERSHIP_SESSION_STATUS_MACHINE = {
  initial: ["pending", "awaiting_owner"],
  transitions: {
    pending: ["awaiting_owner", "failed", "expired", "cancelled"],
    awaiting_owner: ["proof_submitted", "verified", "failed", "expired", "cancelled"],
    proof_submitted: ["verified", "failed", "expired", "cancelled"],
    verified: [],
    failed: [],
    expired: [],
    cancelled: [],
  },
} as const satisfies StateMachine<AgentOwnershipSessionStatus>

export const AGENT_OWNERSHIP_RECORD_STATE_MACHINE = {
  initial: ["pending", "verified"],
  transitions: {
    pending: ["verified"],
    verified: ["expired", "revoked", "transferred"],
    expired: [],
    revoked: [],
    transferred: [],
  },
} as const satisfies StateMachine<AgentOwnershipState>

export const USER_AGENT_STATUS_MACHINE = {
  initial: ["pending", "active"],
  transitions: {
    pending: ["active", "deregistered"],
    active: ["suspended", "revoked", "transferred", "deregistered"],
    suspended: ["active", "revoked", "deregistered"],
    revoked: [],
    transferred: [],
    deregistered: [],
  },
} as const satisfies StateMachine<UserAgentStatus>

function assertInitialStateAllowed<State extends string>(
  machineName: string,
  machine: StateMachine<State>,
  next: State,
): void {
  if (!machine.initial.includes(next)) {
    throw internalError(`${machineName} cannot be created in state ${next}`)
  }
}

function assertTransitionAllowed<State extends string>(
  machineName: string,
  machine: StateMachine<State>,
  current: State,
  next: State,
): void {
  if (current === next) {
    return
  }
  if (!machine.transitions[current].includes(next)) {
    throw internalError(`${machineName} cannot transition from ${current} to ${next}`)
  }
}

export function assertAgentOwnershipSessionStatusTransition(
  current: AgentOwnershipSessionStatus | null,
  next: AgentOwnershipSessionStatus,
): void {
  if (current == null) {
    assertInitialStateAllowed("agent_ownership_sessions.status", AGENT_OWNERSHIP_SESSION_STATUS_MACHINE, next)
    return
  }
  assertTransitionAllowed("agent_ownership_sessions.status", AGENT_OWNERSHIP_SESSION_STATUS_MACHINE, current, next)
}

export function assertAgentOwnershipRecordStateTransition(
  current: AgentOwnershipState | null,
  next: AgentOwnershipState,
): void {
  if (current == null) {
    assertInitialStateAllowed("agent_ownership_records.ownership_state", AGENT_OWNERSHIP_RECORD_STATE_MACHINE, next)
    return
  }
  assertTransitionAllowed("agent_ownership_records.ownership_state", AGENT_OWNERSHIP_RECORD_STATE_MACHINE, current, next)
}

export function assertUserAgentStatusTransition(
  current: UserAgentStatus | null,
  next: UserAgentStatus,
): void {
  if (current == null) {
    assertInitialStateAllowed("user_agents.status", USER_AGENT_STATUS_MACHINE, next)
    return
  }
  assertTransitionAllowed("user_agents.status", USER_AGENT_STATUS_MACHINE, current, next)
}
