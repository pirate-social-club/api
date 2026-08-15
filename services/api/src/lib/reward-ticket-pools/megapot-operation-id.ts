import { keccak256, toUtf8Bytes } from "ethers"

export function normalizeMegapotOperationId(operationId: string): string {
  if (!operationId.trim()) throw new Error("reward_ticket_operation_id_invalid")
  return /^0x[0-9a-fA-F]{64}$/u.test(operationId)
    ? operationId
    : keccak256(toUtf8Bytes(operationId))
}
