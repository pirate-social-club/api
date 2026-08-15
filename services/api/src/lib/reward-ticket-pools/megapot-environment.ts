import { getAddress } from "ethers"

import { providerUnavailable } from "../errors"
import type { MegapotChainReader, MegapotStartupSnapshot } from "./megapot-chain-reader"
import { createMegapotChainReader } from "./megapot-chain-reader"
import type { MegapotRuntimeConfig } from "./megapot-config"

export type VerifiedMegapotEnvironment = Readonly<{
  config: MegapotRuntimeConfig
  observedBlockNumber: number
  observedBlockHash: string
}>

function sameAddress(left: string, right: string): boolean {
  try {
    return getAddress(left) === getAddress(right)
  } catch {
    return false
  }
}

function mismatch(reason: string): never {
  throw providerUnavailable("Megapot deployment verification failed", { reason }, false)
}

export function assertMegapotStartupSnapshot(
  config: MegapotRuntimeConfig,
  snapshot: MegapotStartupSnapshot,
): void {
  const { deployment } = config
  if (snapshot.chainId !== deployment.chainId) mismatch("chain_id_mismatch")

  const expectedHashes = {
    usdc: deployment.usdc.codeHash,
    usdcImplementation: deployment.usdc.implementation.codeHash,
    jackpot: deployment.jackpot.codeHash,
    randomTicketBuyer: deployment.randomTicketBuyer.codeHash,
    ticketNft: deployment.ticketNft.codeHash,
    purchaseEscrow: config.purchaseEscrowCodeHash,
    commitmentRegistry: config.commitmentRegistryCodeHash,
    claimModule: config.claimModuleCodeHash,
  }
  for (const [key, expected] of Object.entries(expectedHashes)) {
    const observed = snapshot.codeHashes[key as keyof typeof snapshot.codeHashes]
    if (observed.toLowerCase() !== expected.toLowerCase()) mismatch(`${key}_code_hash_mismatch`)
  }

  if (!sameAddress(snapshot.links.randomBuyerJackpot, deployment.jackpot.address)) {
    mismatch("random_buyer_jackpot_mismatch")
  }
  if (!sameAddress(snapshot.links.randomBuyerUsdc, deployment.usdc.address)) {
    mismatch("random_buyer_usdc_mismatch")
  }
  if (!sameAddress(snapshot.links.jackpotUsdc, deployment.usdc.address)) {
    mismatch("jackpot_usdc_mismatch")
  }
  if (!sameAddress(snapshot.links.jackpotTicketNft, deployment.ticketNft.address)) {
    mismatch("jackpot_ticket_nft_mismatch")
  }
  if (!sameAddress(snapshot.links.ticketNftJackpot, deployment.jackpot.address)) {
    mismatch("ticket_nft_jackpot_mismatch")
  }
  if (!sameAddress(snapshot.links.usdcImplementation, deployment.usdc.implementation.address)) {
    mismatch("usdc_implementation_mismatch")
  }
}

export async function verifyMegapotEnvironmentAtStartup(input: {
  config: MegapotRuntimeConfig
  reader?: MegapotChainReader
}): Promise<VerifiedMegapotEnvironment> {
  const reader = input.reader ?? createMegapotChainReader(input.config)
  let snapshot: MegapotStartupSnapshot
  try {
    snapshot = await reader.readStartupSnapshot()
  } catch {
    throw providerUnavailable("Megapot deployment verification could not read chain state", null, true)
  }
  assertMegapotStartupSnapshot(input.config, snapshot)
  return {
    config: input.config,
    observedBlockNumber: snapshot.block.number,
    observedBlockHash: snapshot.block.hash,
  }
}
