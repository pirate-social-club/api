import { eligibilityFailed } from "../../errors"
import type { Env } from "../../../env"
import { evaluateErc721ContractSupport } from "../community-token-gates"
import { flattenGatePolicyAtoms } from "./gate-summary"
import type { GatePolicy } from "./gate-types"

export async function assertGatePolicyContractsValid(input: {
  env: Env
  policy: GatePolicy | null | undefined
}): Promise<void> {
  const erc721Contracts = Array.from(new Set(
    flattenGatePolicyAtoms(input.policy ?? null)
      .filter((atom) => atom.type === "erc721_holding")
      .map((atom) => atom.contract_address),
  ))

  for (const contractAddress of erc721Contracts) {
    const result = await evaluateErc721ContractSupport({
      contractAddress,
      env: input.env,
    })
    if (result.unavailable) {
      throw eligibilityFailed("erc721_holding contract could not be validated. Check RPC availability and confirm the contract supports ERC-165/ERC-721.")
    }
    if (!result.supported) {
      throw eligibilityFailed("erc721_holding gate contract must support ERC-721")
    }
  }
}
