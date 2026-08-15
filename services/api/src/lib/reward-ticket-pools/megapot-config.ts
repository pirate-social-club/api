import { getAddress } from "ethers"

import type { Env } from "../../env"
import { providerUnavailable } from "../errors"

export type MegapotEnvironment = "mainnet" | "staging" | "testnet"

type ContractPin = Readonly<{
  address: string
  codeHash: string
}>

export type MegapotDeployment = Readonly<{
  environment: MegapotEnvironment
  chainId: 8453 | 84532
  usdc: ContractPin & Readonly<{ implementation: ContractPin }>
  jackpot: ContractPin
  randomTicketBuyer: ContractPin
  ticketNft: ContractPin
}>

// Addresses are from the archived Megapot ABI index. Runtime bytecode hashes
// were independently sampled from the canonical Base chains on 2026-08-13.
// Any deployment or bytecode change intentionally fails closed until reviewed.
export const MEGAPOT_DEPLOYMENTS: Readonly<Record<MegapotEnvironment, MegapotDeployment>> = {
  mainnet: {
    environment: "mainnet",
    chainId: 8453,
    usdc: {
      address: "0x833589fCD6eDb6E08f4c7C32D4f71b54bdA02913",
      codeHash: "0xa6705a10bb756b5dea144591118be77d7af0c3eee3bf2dfe2583dcb0364fefab",
      implementation: {
        address: "0x2Ce6311ddAE708829bc0784C967b7d77D19FD779",
        codeHash: "0x11b75a237997ab8328f65b2d5a55c10f0346d0a175741ed42ddf4f2c66b9e873",
      },
    },
    jackpot: {
      address: "0x3bAe643002069dBCbcd62B1A4eb4C4A397d042a2",
      codeHash: "0x597f3a8e9360fbfc2e623243507ee9e8a66609003078ffc33d9013cb0607002d",
    },
    randomTicketBuyer: {
      address: "0xb9560b43b91dE2c1DaF5dfbb76b2CFcDaFc13aBd",
      codeHash: "0x1c5ecec97afaf4b06b0065207dda04d6c0131fe84841b55e948302ebbe8ae136",
    },
    ticketNft: {
      address: "0x48FfE35AbB9f4780a4f1775C2Ce1c46185b366e4",
      codeHash: "0xf08234474c8484705b2e855d9602b6e229359839fc7bad67c9157a9d5dd53ca8",
    },
  },
  staging: {
    environment: "staging",
    chainId: 8453,
    usdc: {
      address: "0x833589fCD6eDb6E08f4c7C32D4f71b54bdA02913",
      codeHash: "0xa6705a10bb756b5dea144591118be77d7af0c3eee3bf2dfe2583dcb0364fefab",
      implementation: {
        address: "0x2Ce6311ddAE708829bc0784C967b7d77D19FD779",
        codeHash: "0x11b75a237997ab8328f65b2d5a55c10f0346d0a175741ed42ddf4f2c66b9e873",
      },
    },
    jackpot: {
      address: "0xCd43b692e005A69aB066F62e92551D5EFD8B69B6",
      codeHash: "0x8d3104deb8a3fb663c67f8d4a2da43a15aaf5ad8b0e1d303ceed09f582dd4bc9",
    },
    randomTicketBuyer: {
      address: "0x4D55EE33D22b1C5a62FfF84D80dDf8b07bFf5a1a",
      codeHash: "0xc595ea4fecc996e4eb86b4d3e04a6ede5148cf93982b54b9682e6249d57a513e",
    },
    ticketNft: {
      address: "0x60890F14cE35C404bDA8316e5128d86791F2c6Fa",
      codeHash: "0x6daf81715ef15e7826304e817e723d56b2dcf58b53048505f0960d1e9d466698",
    },
  },
  testnet: {
    environment: "testnet",
    chainId: 84532,
    usdc: {
      address: "0x036CbD53842c5426634e7929541eC2318f3dCF7e",
      codeHash: "0xedc5281a85c0efecd49999a1ef668390c59b88702f2d4a07029d7f5d63059d6c",
      implementation: {
        address: "0xd74cc5d436923b8ba2c179b4bCA2841D8A52C5B5",
        codeHash: "0x1254951e5483b882fd5def9452f58fe786eb3380c0bf9bb2744fa21a0a97a16c",
      },
    },
    jackpot: {
      address: "0x465dA3c859f193A3807386387bEE941B2A4c3279",
      codeHash: "0x8d3104deb8a3fb663c67f8d4a2da43a15aaf5ad8b0e1d303ceed09f582dd4bc9",
    },
    randomTicketBuyer: {
      address: "0x53c04e7e5044B28Ea8A4F9c4b26E3Ac1aeb63746",
      codeHash: "0xa73c4d54a3a55610a981add3bf716c2d7b792e17f81d08cf50ff4a9fa197fd24",
    },
    ticketNft: {
      address: "0x45084829ac63f9dC6a3D4981A46FA896f9180ECd",
      codeHash: "0x01d40360e044308705eab6583bceda55707a959233cfe44d37a11cdcebada37a",
    },
  },
}

export type MegapotRuntimeConfig = Readonly<{
  deployment: MegapotDeployment
  rpcUrl: string
  purchaseSafetyMarginSeconds: number
  minimumConfirmations: number
  custodyAddress: string
  purchaseOperatorAddress: string
  platformRevenueAddress: string
  purchaseEscrowAddress: string
  commitmentRegistryAddress: string
  claimModuleAddress: string
  purchaseEscrowCodeHash: string
  commitmentRegistryCodeHash: string
  claimModuleCodeHash: string
}>

function isEnabled(value: string | undefined): boolean {
  return String(value ?? "").trim().toLowerCase() === "true"
}

function requiredAddress(value: string | undefined, key: string): string {
  try {
    return getAddress(String(value ?? "").trim())
  } catch {
    throw providerUnavailable(`Reward ticket configuration ${key} is invalid`, { key }, false)
  }
}

function requiredPositiveInteger(value: string | undefined, key: string): number {
  const parsed = Number(String(value ?? "").trim())
  if (!Number.isSafeInteger(parsed) || parsed <= 0) {
    throw providerUnavailable(`Reward ticket configuration ${key} is invalid`, { key }, false)
  }
  return parsed
}

function requiredCodeHash(value: string | undefined, key: string): string {
  const normalized = String(value ?? "").trim().toLowerCase()
  if (!/^0x[0-9a-f]{64}$/u.test(normalized)) {
    throw providerUnavailable(`Reward ticket configuration ${key} is invalid`, { key }, false)
  }
  return normalized
}

export function resolveMegapotRuntimeConfig(env: Env): MegapotRuntimeConfig {
  const environment = String(env.REWARD_TICKET_MEGAPOT_ENVIRONMENT ?? "").trim()
  if (!(environment in MEGAPOT_DEPLOYMENTS)) {
    throw providerUnavailable(
      "Reward ticket Megapot environment is invalid",
      { key: "REWARD_TICKET_MEGAPOT_ENVIRONMENT" },
      false,
    )
  }
  if (String(env.ENVIRONMENT ?? "").trim().toLowerCase() === "production" && environment !== "mainnet") {
    throw providerUnavailable("Production reward tickets require Megapot mainnet", null, false)
  }

  const deployment = MEGAPOT_DEPLOYMENTS[environment as MegapotEnvironment]
  const configuredRpcUrl = String(env.REWARD_TICKET_MEGAPOT_RPC_URL ?? "").trim()
  const fallbackRpcUrl = deployment.chainId === 8453
    ? String(env.BASE_MAINNET_RPC_URL ?? "").trim()
    : String(env.BASE_SEPOLIA_RPC_URL ?? "").trim()
  const rpcUrl = configuredRpcUrl || fallbackRpcUrl
  if (!/^https:\/\//iu.test(rpcUrl)) {
    throw providerUnavailable(
      "Reward ticket Megapot RPC URL is invalid",
      { key: "REWARD_TICKET_MEGAPOT_RPC_URL" },
      false,
    )
  }

  const custodyAddress = requiredAddress(env.REWARD_TICKET_CUSTODY_ADDRESS, "REWARD_TICKET_CUSTODY_ADDRESS")
  const purchaseOperatorAddress = requiredAddress(
    env.REWARD_TICKET_PURCHASE_OPERATOR_ADDRESS,
    "REWARD_TICKET_PURCHASE_OPERATOR_ADDRESS",
  )
  const platformRevenueAddress = requiredAddress(
    env.REWARD_TICKET_PLATFORM_REVENUE_ADDRESS,
    "REWARD_TICKET_PLATFORM_REVENUE_ADDRESS",
  )
  const purchaseEscrowAddress = requiredAddress(
    env.REWARD_TICKET_PURCHASE_ESCROW_ADDRESS,
    "REWARD_TICKET_PURCHASE_ESCROW_ADDRESS",
  )
  const commitmentRegistryAddress = requiredAddress(
    env.REWARD_TICKET_COMMITMENT_REGISTRY_ADDRESS,
    "REWARD_TICKET_COMMITMENT_REGISTRY_ADDRESS",
  )
  const claimModuleAddress = requiredAddress(
    env.REWARD_TICKET_CLAIM_MODULE_ADDRESS,
    "REWARD_TICKET_CLAIM_MODULE_ADDRESS",
  )
  const purchaseEscrowCodeHash = requiredCodeHash(
    env.REWARD_TICKET_PURCHASE_ESCROW_CODE_HASH,
    "REWARD_TICKET_PURCHASE_ESCROW_CODE_HASH",
  )
  const commitmentRegistryCodeHash = requiredCodeHash(
    env.REWARD_TICKET_COMMITMENT_REGISTRY_CODE_HASH,
    "REWARD_TICKET_COMMITMENT_REGISTRY_CODE_HASH",
  )
  const claimModuleCodeHash = requiredCodeHash(
    env.REWARD_TICKET_CLAIM_MODULE_CODE_HASH,
    "REWARD_TICKET_CLAIM_MODULE_CODE_HASH",
  )
  const distinctAddresses = new Set([
    custodyAddress,
    purchaseOperatorAddress,
    platformRevenueAddress,
    purchaseEscrowAddress,
    commitmentRegistryAddress,
    claimModuleAddress,
  ].map((address) => address.toLowerCase()))
  if (distinctAddresses.size !== 6) {
    throw providerUnavailable(
      "Reward ticket operational and control addresses must be distinct",
      null,
      false,
    )
  }
  const protocolAddresses = new Set([
    deployment.usdc.address,
    deployment.usdc.implementation.address,
    deployment.jackpot.address,
    deployment.randomTicketBuyer.address,
    deployment.ticketNft.address,
  ].map((address) => address.toLowerCase()))
  if ([
    custodyAddress,
    purchaseOperatorAddress,
    platformRevenueAddress,
    purchaseEscrowAddress,
    commitmentRegistryAddress,
    claimModuleAddress,
  ]
    .some((address) => protocolAddresses.has(address.toLowerCase()))) {
    throw providerUnavailable("Reward ticket operational roles cannot be protocol contracts", null, false)
  }

  return {
    deployment,
    rpcUrl,
    purchaseSafetyMarginSeconds: requiredPositiveInteger(
      env.REWARD_TICKET_PURCHASE_SAFETY_MARGIN_SECONDS,
      "REWARD_TICKET_PURCHASE_SAFETY_MARGIN_SECONDS",
    ),
    minimumConfirmations: requiredPositiveInteger(
      env.REWARD_TICKET_FINALITY_CONFIRMATIONS,
      "REWARD_TICKET_FINALITY_CONFIRMATIONS",
    ),
    custodyAddress,
    purchaseOperatorAddress,
    platformRevenueAddress,
    purchaseEscrowAddress,
    commitmentRegistryAddress,
    claimModuleAddress,
    purchaseEscrowCodeHash,
    commitmentRegistryCodeHash,
    claimModuleCodeHash,
  }
}

export function resolveOptionalMegapotRuntimeConfig(env: Env): MegapotRuntimeConfig | null {
  return isEnabled(env.REWARD_TICKET_POOLS_ENABLED) ? resolveMegapotRuntimeConfig(env) : null
}
