import { Interface, Wallet, getAddress } from "ethers";

function fail(message, details = {}) {
  throw new Error(`${message}${Object.keys(details).length ? ` ${JSON.stringify(details)}` : ""}`);
}

function requireHex(value, field, bytesExact = null) {
  if (typeof value !== "string" || !/^0x[0-9a-fA-F]*$/.test(value)) {
    fail("invalid_hex", { field });
  }
  if (value.length % 2 !== 0) {
    fail("invalid_hex_length", { field });
  }
  if (bytesExact != null && (value.length - 2) / 2 !== bytesExact) {
    fail("invalid_hex_size", { field, expectedBytes: bytesExact });
  }
  return value.toLowerCase();
}

function requireAddress(value, field) {
  try {
    return getAddress(String(value || "")).toLowerCase();
  } catch {
    fail("invalid_address", { field });
  }
}

function requireUintString(value, field) {
  const normalized = String(value ?? "").trim();
  if (!/^\d+$/.test(normalized)) {
    fail("invalid_uint", { field });
  }
  return normalized;
}

function normalizePrivateKey(value) {
  if (typeof value === "string") {
    const withPrefix = value.trim().startsWith("0x") ? value.trim() : `0x${value.trim()}`;
    if (!/^0x[0-9a-fA-F]{64}$/.test(withPrefix)) {
      fail("invalid_private_key_string");
    }
    return withPrefix.toLowerCase();
  }
  if (value instanceof Uint8Array) {
    if (value.length !== 32) {
      fail("invalid_private_key_bytes");
    }
    return `0x${Array.from(value).map((b) => b.toString(16).padStart(2, "0")).join("")}`;
  }
  fail("unsupported_private_key_type", { actualType: typeof value });
}

function resolveGetPrivateKey() {
  if (typeof Lit?.Actions?.getPrivateKey === "function") {
    return Lit.Actions.getPrivateKey.bind(Lit.Actions);
  }
  if (typeof LitActions?.getPrivateKey === "function") {
    return LitActions.getPrivateKey.bind(LitActions);
  }
  fail("get_private_key_unavailable");
}

function resolveJsParams(firstArg) {
  const rootParams = (firstArg && typeof firstArg === "object" ? firstArg : null)
    || globalThis.jsParams
    || globalThis.js_params
    || globalThis.params
    || {};
  const params = rootParams && typeof rootParams === "object" ? rootParams : {};
  return params.jsParams && typeof params.jsParams === "object"
    ? { ...params.jsParams, ...params }
    : params;
}

async function resolveExpectedPrivateKey(expectedSignerAddress) {
  const getPrivateKey = resolveGetPrivateKey();
  const attempts = [
    { label: "pkpId", payload: { pkpId: expectedSignerAddress } },
    { label: "pkpAddress", payload: { pkpAddress: expectedSignerAddress } },
  ];
  const failures = [];
  for (const attempt of attempts) {
    try {
      const privateKey = normalizePrivateKey(await getPrivateKey(attempt.payload));
      const signerAddress = requireAddress(new Wallet(privateKey).address, "pkpAddress");
      if (signerAddress === expectedSignerAddress) {
        return privateKey;
      }
      failures.push({ label: attempt.label, signerAddress });
    } catch (error) {
      failures.push({
        label: attempt.label,
        error: error instanceof Error ? error.message : String(error),
      });
    }
  }
  fail("pkp_private_key_resolution_failed", { expected: expectedSignerAddress, attempts: failures });
}

const ABI = [
  "function settlePurchase(bytes32 purchaseRef, address buyer, uint256 tokenId, address payoutRecipient)",
];

const ABI_IFACE = new Interface(ABI);
const ZERO_ADDRESS = "0x0000000000000000000000000000000000000000";

export async function main(firstArg) {
  const params = resolveJsParams(firstArg);
  const unsignedTx = params.unsignedTx || {};
  const expectedSignerAddress = requireAddress(params.expectedSignerAddress, "expectedSignerAddress");

  const txTo = requireAddress(unsignedTx.to, "unsignedTx.to");
  const txData = requireHex(String(unsignedTx.data || ""), "unsignedTx.data");
  const txValue = BigInt(requireUintString(unsignedTx.value ?? "0", "unsignedTx.value"));
  const txChainId = Number(unsignedTx.chainId);
  const txType = Number(unsignedTx.type ?? 2);
  const gasLimit = BigInt(requireUintString(unsignedTx.gasLimit ?? "0", "unsignedTx.gasLimit"));
  const maxFeePerGas = BigInt(requireUintString(unsignedTx.maxFeePerGas ?? "0", "unsignedTx.maxFeePerGas"));
  const maxPriorityFeePerGas = BigInt(requireUintString(unsignedTx.maxPriorityFeePerGas ?? "0", "unsignedTx.maxPriorityFeePerGas"));
  if (!Number.isInteger(txChainId) || txChainId !== 1315) {
    fail("tx_chain_id_mismatch", { txChainId, expected: 1315 });
  }
  if (!Number.isInteger(txType) || txType !== 2) {
    fail("tx_type_mismatch", { txType, expected: 2 });
  }
  if (txValue <= 0n) {
    fail("tx_value_not_positive", { txValue: txValue.toString() });
  }
  if (gasLimit <= 0n || maxFeePerGas <= 0n || maxPriorityFeePerGas <= 0n) {
    fail("tx_fee_or_gas_invalid");
  }
  if (maxPriorityFeePerGas > maxFeePerGas) {
    fail("tx_fee_priority_exceeds_max");
  }
  if (txData.slice(0, 10).toLowerCase() !== "0x187c706a") {
    fail("selector_mismatch", { selector: txData.slice(0, 10), expected: "0x187c706a" });
  }

  let decoded;
  try {
    decoded = ABI_IFACE.decodeFunctionData("settlePurchase", txData);
  } catch {
    fail("calldata_decode_failed");
  }
  const purchaseRef = requireHex(decoded[0], "purchaseRef", 32);
  const buyer = requireAddress(decoded[1], "buyer");
  const tokenId = BigInt(requireUintString(decoded[2], "tokenId"));
  const payoutRecipient = requireAddress(decoded[3], "payoutRecipient");
  if (purchaseRef === "0x".padEnd(66, "0")) {
    fail("purchase_ref_zero");
  }
  if (buyer === ZERO_ADDRESS) {
    fail("buyer_zero");
  }
  if (tokenId <= 0n) {
    fail("token_id_zero");
  }
  if (payoutRecipient === ZERO_ADDRESS) {
    fail("payout_recipient_zero");
  }

  const privateKey = await resolveExpectedPrivateKey(expectedSignerAddress);
  const wallet = new Wallet(privateKey);
  const signerAddress = requireAddress(wallet.address, "wallet.address");
  if (signerAddress !== expectedSignerAddress) {
    fail("pkp_address_mismatch", { signerAddress, expected: expectedSignerAddress });
  }

  const signedTx = await wallet.signTransaction({
    type: txType,
    chainId: txChainId,
    nonce: Number(unsignedTx.nonce ?? 0),
    to: txTo,
    value: txValue,
    data: txData,
    gasLimit,
    maxFeePerGas,
    maxPriorityFeePerGas,
  });

  return JSON.stringify({
    ok: true,
    action: "story-settlement-settle-purchase-v1",
    signerAddress,
    serializedTx: signedTx,
  });
}
