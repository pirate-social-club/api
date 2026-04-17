/**
 * Verify a partial decryption signature produced by the story-kernel TEE.
 *
 * Reproduces the kernel's signing protocol:
 * 1. RLP encode [Round, Ciphertext, EncryptedPartial, EphemeralPubKey, PubShare]
 * 2. Keccak256 hash the encoded bytes
 * 3. Recover the secp256k1 public key from the signature
 * 4. Compare the recovered address with the expected address derived from commPubKey
 *
 * @returns true if the signature is valid and was produced by the holder of commPubKey
 */
export declare function verifyPartialSignature(params: {
    round: number;
    ciphertext: Uint8Array;
    encryptedPartial: Uint8Array;
    ephemeralPubKey: Uint8Array;
    pubShare: Uint8Array;
    /** 65-byte secp256k1 signature (r || s || v), where v is 27 or 28 */
    signature: Uint8Array;
    /** 64-byte uncompressed public key (without 0x04 prefix) from DKG Registered event */
    commPubKey: Uint8Array;
}): boolean;
//# sourceMappingURL=signature.d.ts.map