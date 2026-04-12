import { Wallet, Signature, getAddress } from "ethers";

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

  fail("pkp_private_key_resolution_failed", {
    expected: expectedSignerAddress,
    attempts: failures,
  });
}

export async function main(firstArg) {
  const params = resolveJsParams(firstArg);
  const digest = requireHex(String(params.digest || ""), "digest", 32);
  const expectedSignerAddress = requireAddress(params.expectedSignerAddress, "expectedSignerAddress");
  const privateKey = await resolveExpectedPrivateKey(expectedSignerAddress);
  const wallet = new Wallet(privateKey);
  const signerAddress = requireAddress(wallet.address, "wallet.address");
  if (signerAddress !== expectedSignerAddress) {
    fail("pkp_address_mismatch", { signerAddress, expected: expectedSignerAddress });
  }

  const signature = Signature.from(wallet.signingKey.sign(digest)).serialized;
  return JSON.stringify({
    ok: true,
    action: "story-access-controller-sign-access-proof-v1",
    signerAddress,
    signature,
  });
}
