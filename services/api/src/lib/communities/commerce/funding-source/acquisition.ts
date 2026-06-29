import { badRequestError } from "../../../errors"
import type { FundingAcquisition, FundingSourceAcquireInput } from "./types"

// Omniston/TON acquisition is greenfield (no TON SDK in this slice). It is injected so the
// state-machine boundaries can be pinned before any cross-chain code lands.
export type OmnistonAcquisitionResolver = (
  input: FundingSourceAcquireInput,
) => Promise<FundingAcquisition>

let omnistonResolver: OmnistonAcquisitionResolver | null = null

export function setOmnistonAcquisitionResolverForTests(
  resolver: OmnistonAcquisitionResolver | null,
): void {
  omnistonResolver = resolver
}

export async function acquireFunding(
  input: FundingSourceAcquireInput,
): Promise<FundingAcquisition> {
  if (input.provider === "pirate_checkout") {
    // Thin adapter, no abstraction tax: the buyer already moved Base USDC, so the
    // caller-supplied funding_tx_ref *is* the acquisition. The canonical EVM log verifier
    // still re-verifies this ref downstream — acquisition never asserts a receipt.
    const ref = (input.fundingTxRef ?? "").trim()
    if (!ref) {
      throw badRequestError("pirate_checkout acquisition requires funding_tx_ref")
    }
    return {
      status: "confirmed",
      baseUsdcTxRef: ref,
      sourceCorrelation: { kind: "evm_direct", baseUsdcTxRef: ref },
    }
  }

  if (input.provider === "omniston_ton") {
    if (!omnistonResolver) {
      throw badRequestError("omniston_ton acquisition is not implemented")
    }
    return await omnistonResolver(input)
  }

  throw badRequestError(`Unsupported funding source provider: ${String(input.provider)}`)
}
