export declare class CDRCryptoError extends Error {
    code: string;
    constructor(message: string, code: string);
}
export declare class WasmNotInitializedError extends CDRCryptoError {
    constructor();
}
export declare class InvalidCiphertextError extends CDRCryptoError {
    constructor(detail?: string);
}
export declare class InsufficientPartialsError extends CDRCryptoError {
    constructor(have: number, need: number);
}
//# sourceMappingURL=errors.d.ts.map