const ALGORITHM = "AES-GCM";
const FORMAT_PREFIX = "v1";
const IV_BYTES = 12;

function hexToBytes(hex: string): Uint8Array {
  const bytes = new Uint8Array(hex.length / 2);
  for (let i = 0; i < hex.length; i += 2) {
    bytes[i / 2] = parseInt(hex.substring(i, i + 2), 16);
  }
  return bytes;
}

function bytesToHex(bytes: Uint8Array): string {
  return Array.from(bytes)
    .map((b) => b.toString(16).padStart(2, "0"))
    .join("");
}

function requireWrapKeyBytes(wrapKey: string): Uint8Array {
  const normalized = wrapKey.trim();
  if (!/^[0-9a-fA-F]{64}$/.test(normalized)) {
    throw new Error("TURSO_COMMUNITY_DB_WRAP_KEY must be 32 bytes encoded as hex");
  }
  return hexToBytes(normalized);
}

export async function encryptCommunityDbCredential(input: {
  plaintextToken: string;
  wrapKey: string;
}): Promise<string> {
  const plaintext = input.plaintextToken.trim();
  if (!plaintext) {
    throw new Error("Community DB plaintext token is required");
  }

  const key = await crypto.subtle.importKey(
    "raw",
    requireWrapKeyBytes(input.wrapKey).buffer as ArrayBuffer,
    { name: ALGORITHM },
    false,
    ["encrypt"],
  );

  const iv = crypto.getRandomValues(new Uint8Array(IV_BYTES));
  const encoded = new TextEncoder().encode(plaintext);

  const sealed = await crypto.subtle.encrypt(
    { name: ALGORITHM, iv: iv.buffer as ArrayBuffer },
    key,
    encoded,
  );

  const ciphertext = new Uint8Array(sealed.slice(0, sealed.byteLength - 16));
  const tag = new Uint8Array(sealed.slice(sealed.byteLength - 16));

  return `${FORMAT_PREFIX}:${bytesToHex(iv)}:${bytesToHex(tag)}:${bytesToHex(ciphertext)}`;
}

export async function decryptCommunityDbCredential(input: {
  encryptedToken: string;
  encryptionKeyVersion: number;
  wrapKey: string;
}): Promise<string> {
  if (!Number.isInteger(input.encryptionKeyVersion) || input.encryptionKeyVersion <= 0) {
    throw new Error("Community DB credential encryption key version is invalid");
  }

  const [format, ivHex, tagHex, ciphertextHex] = input.encryptedToken.trim().split(":");
  if (format !== FORMAT_PREFIX || !ivHex || !tagHex || !ciphertextHex) {
    throw new Error("Community DB credential ciphertext format is invalid");
  }

  const key = await crypto.subtle.importKey(
    "raw",
    requireWrapKeyBytes(input.wrapKey).buffer as ArrayBuffer,
    { name: ALGORITHM },
    false,
    ["decrypt"],
  );

  const iv = hexToBytes(ivHex);
  const tag = hexToBytes(tagHex);
  const ciphertext = hexToBytes(ciphertextHex);
  const sealed = new Uint8Array(ciphertext.length + tag.length);
  sealed.set(ciphertext, 0);
  sealed.set(tag, ciphertext.length);

  try {
    const plaintext = await crypto.subtle.decrypt(
      { name: ALGORITHM, iv: iv.buffer as ArrayBuffer },
      key,
      sealed.buffer as ArrayBuffer,
    );
    const decoded = new TextDecoder().decode(plaintext);
    if (!decoded.trim()) {
      throw new Error("empty plaintext");
    }
    return decoded;
  } catch {
    throw new Error("Community DB credential ciphertext could not be decrypted");
  }
}
