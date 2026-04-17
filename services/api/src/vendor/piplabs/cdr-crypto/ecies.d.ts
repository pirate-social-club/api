/**
 * Decrypt an encrypted partial decryption from a validator.
 *
 * Protocol (matching Go TEE sidecar):
 *   1. ECDH: sharedSecret = recipientPrivKey * ephemeralPubKey
 *   2. HKDF-SHA256(sharedSecret, info="dkg-tdh2-partial") → 32-byte AES key
 *   3. AES-256-GCM decrypt (nonce = first 12 bytes of encrypted data)
 */
export declare function decryptPartial(params: {
    /** AES-GCM encrypted partial (nonce || ciphertext || tag) */
    encryptedPartial: Uint8Array;
    /** Validator's ephemeral public key — uncompressed secp256k1 (65 bytes: 04 || x || y) */
    ephemeralPubKey: Uint8Array;
    /** Requester's secp256k1 private key (32 bytes) */
    recipientPrivKey: Uint8Array;
}): Promise<Uint8Array>;
/**
 * Encrypt data to a recipient's public key (test helper, mirrors validator behavior).
 * This function is NOT part of the public API — only used in tests.
 * The barrel export (index.ts) should NOT re-export this function.
 * Tests import it directly from the ecies.ts module.
 */
export declare function encryptForTest(plaintext: Uint8Array, recipientPubKey: Uint8Array): Promise<{
    ciphertext: Uint8Array;
    ephemeralPubKey: Uint8Array;
}>;
//# sourceMappingURL=ecies.d.ts.map