import type { Env } from "../../env";
import { badRequestError } from "../errors";
import { assertPrivateKeyMatchesExpectedAddress } from "../evm-signer";
import { normalizeDirectSignerPrivateKey } from "../story/story-direct-signer";

const BASE_MAINNET_CHAIN_ID = 8453;
const BASE_SEPOLIA_CHAIN_ID = 84532;
const BASE_MAINNET_USDC = "0x833589fcd6edb6e08f4c7c32d4f71b54bda02913";
const BASE_SEPOLIA_USDC = "0x036cbd53842c5426634e7929541ec2318f3dcf7e";
const EVM_ADDRESS_RE = /^0x[a-fA-F0-9]{40}$/u;

// Only chains we have vetted (funding, operator custody, canonical USDC) may settle real value. A typo
// or a stray env value must never silently point settlement at an unknown chain. Base mainnet stays in
// the allowlist because going live is a deliberate config act (fund operator + set explicit RPC), not
// something to guard against here — the guard exists to reject the UNKNOWN, not to gate mainnet.
const ALLOWED_CHAIN_IDS: ReadonlySet<number> = new Set([BASE_SEPOLIA_CHAIN_ID, BASE_MAINNET_CHAIN_ID]);

// Canonical USDC per allowlisted chain. An explicit token override is honored ONLY when it matches the
// canonical address, unless PIRATE_BOOKING_SETTLEMENT_ALLOW_TOKEN_OVERRIDE=true is set to consciously
// opt out of the pin (e.g. a test token). This prevents a misconfigured token address from moving value
// in the wrong denomination.
const CANONICAL_USDC_BY_CHAIN: ReadonlyMap<number, string> = new Map([
  [BASE_MAINNET_CHAIN_ID, BASE_MAINNET_USDC],
  [BASE_SEPOLIA_CHAIN_ID, BASE_SEPOLIA_USDC],
]);

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
  const chainId = readRequiredPositiveInt(env.PIRATE_BOOKING_SETTLEMENT_CHAIN_ID, "PIRATE_BOOKING_SETTLEMENT_CHAIN_ID");
  if (!ALLOWED_CHAIN_IDS.has(chainId)) {
    throw badRequestError(`PIRATE_BOOKING_SETTLEMENT_CHAIN_ID ${chainId} is not an allowlisted booking settlement chain`);
  }
  return chainId;
}

export function resolveBookingSettlementUsdcTokenAddress(env: Env): string {
  const chainId = resolveBookingSettlementChainId(env);
  const canonical = CANONICAL_USDC_BY_CHAIN.get(chainId) ?? null;

  const overrideRaw = String(env.PIRATE_BOOKING_SETTLEMENT_USDC_TOKEN_ADDRESS || "").trim();
  if (overrideRaw) {
    const override = normalizeAddress(overrideRaw, "PIRATE_BOOKING_SETTLEMENT_USDC_TOKEN_ADDRESS");
    const overrideAllowed = String(env.PIRATE_BOOKING_SETTLEMENT_ALLOW_TOKEN_OVERRIDE || "").trim().toLowerCase() === "true";
    if (canonical && override !== canonical && !overrideAllowed) {
      throw badRequestError("PIRATE_BOOKING_SETTLEMENT_USDC_TOKEN_ADDRESS does not match the canonical USDC for this chain");
    }
    return override;
  }

  if (canonical) return canonical;

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
  const expected = normalizeAddress(env.PIRATE_BOOKING_SETTLEMENT_OPERATOR_ADDRESS, "PIRATE_BOOKING_SETTLEMENT_OPERATOR_ADDRESS");
  const privateKey = normalizeDirectSignerPrivateKey(String(env.PIRATE_BOOKING_SETTLEMENT_OPERATOR_PRIVATE_KEY || "").trim());
  if (privateKey) {
    assertPrivateKeyMatchesExpectedAddress({
      privateKey,
      expectedAddress: expected,
      expectedField: "PIRATE_BOOKING_SETTLEMENT_OPERATOR_ADDRESS",
    });
  }
  return expected;
}

export function resolveBookingSettlementOperatorPrivateKey(env: Env): string {
  const privateKey = normalizeDirectSignerPrivateKey(String(env.PIRATE_BOOKING_SETTLEMENT_OPERATOR_PRIVATE_KEY || "").trim());
  if (!privateKey) throw badRequestError("PIRATE_BOOKING_SETTLEMENT_OPERATOR_PRIVATE_KEY is invalid");
  return privateKey;
}
