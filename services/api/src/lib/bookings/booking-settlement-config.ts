import type { Env } from "../../env";
import { badRequestError } from "../errors";

const BASE_MAINNET_CHAIN_ID = 8453;
const BASE_SEPOLIA_CHAIN_ID = 84532;
const BASE_MAINNET_USDC = "0x833589fcd6edb6e08f4c7c32d4f71b54bda02913";
const BASE_SEPOLIA_USDC = "0x036cbd53842c5426634e7929541ec2318f3dcf7e";
const EVM_ADDRESS_RE = /^0x[a-fA-F0-9]{40}$/u;

function readRequiredPositiveInt(raw: string | undefined, name: string): number {
  const parsed = Number(String(raw || "").trim());
  if (!Number.isInteger(parsed) || parsed <= 0) {
    throw badRequestError(`${name} is required for booking settlement`);
  }
  return parsed;
}

function normalizeAddress(raw: string | undefined, name: string): string {
  const value = String(raw || "").trim();
  if (!EVM_ADDRESS_RE.test(value)) throw badRequestError(`${name} is required for booking settlement`);
  return value.toLowerCase();
}

export function resolveBookingSettlementChainId(env: Env): number {
  return readRequiredPositiveInt(env.PIRATE_BOOKING_SETTLEMENT_CHAIN_ID, "PIRATE_BOOKING_SETTLEMENT_CHAIN_ID");
}

export function resolveBookingSettlementUsdcTokenAddress(env: Env): string {
  if (String(env.PIRATE_BOOKING_SETTLEMENT_USDC_TOKEN_ADDRESS || "").trim()) {
    return normalizeAddress(env.PIRATE_BOOKING_SETTLEMENT_USDC_TOKEN_ADDRESS, "PIRATE_BOOKING_SETTLEMENT_USDC_TOKEN_ADDRESS");
  }

  const chainId = resolveBookingSettlementChainId(env);
  if (chainId === BASE_MAINNET_CHAIN_ID) return BASE_MAINNET_USDC;
  if (chainId === BASE_SEPOLIA_CHAIN_ID) return BASE_SEPOLIA_USDC;

  throw badRequestError("PIRATE_BOOKING_SETTLEMENT_USDC_TOKEN_ADDRESS is required for booking settlement");
}

export function resolveBookingSettlementRpcUrl(env: Env): string {
  const explicit = String(env.PIRATE_BOOKING_SETTLEMENT_RPC_URL || "").trim();
  if (explicit) return explicit;

  const chainId = resolveBookingSettlementChainId(env);
  if (chainId === BASE_MAINNET_CHAIN_ID) {
    const baseMainnetRpc = String(env.BASE_MAINNET_RPC_URL || "").trim();
    if (baseMainnetRpc) return baseMainnetRpc;
  }
  if (chainId === BASE_SEPOLIA_CHAIN_ID) {
    const baseSepoliaRpc = String(env.BASE_SEPOLIA_RPC_URL || "").trim();
    if (baseSepoliaRpc) return baseSepoliaRpc;
  }

  throw badRequestError("PIRATE_BOOKING_SETTLEMENT_RPC_URL is required for booking settlement");
}

export function resolveBookingSettlementOperatorAddress(env: Env): string {
  return normalizeAddress(env.PIRATE_BOOKING_SETTLEMENT_OPERATOR_ADDRESS, "PIRATE_BOOKING_SETTLEMENT_OPERATOR_ADDRESS");
}
