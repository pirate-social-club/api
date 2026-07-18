import { getAddress } from "ethers/address";
import type { Transaction } from "ethers/transaction";
import { toBeHex } from "ethers/utils";

export type OriginalCandidateIdentity = {
	nonce: number;
	signerAddress: string;
	targetAddress: string | null;
	valueWei: string;
	calldata: string;
	gasLimit: string;
	maxFeePerGas: string;
	maxPriorityFeePerGas: string;
};

export function assertReplacementTransaction(
	original: OriginalCandidateIdentity,
	replacement: Transaction,
): void {
	if (
		!replacement.from ||
		replacement.nonce !== original.nonce ||
		getAddress(replacement.from) !== original.signerAddress ||
		(replacement.to ? getAddress(replacement.to) : null) !==
			original.targetAddress ||
		replacement.value.toString() !== original.valueWei ||
		replacement.data.toLowerCase() !== original.calldata.toLowerCase() ||
		replacement.gasLimit.toString() !== original.gasLimit
	)
		throw new Error("replacement_call_identity_mismatch");
	if (
		(replacement.maxFeePerGas ?? 0n) <= BigInt(original.maxFeePerGas) ||
		(replacement.maxPriorityFeePerGas ?? 0n) <=
			BigInt(original.maxPriorityFeePerGas)
	)
		throw new Error("replacement_fee_not_higher");
}

export function pendingTransaction(
	transaction: Transaction,
	hash: string,
): Record<string, unknown> {
	return {
		hash,
		nonce: toBeHex(transaction.nonce),
		blockHash: null,
		blockNumber: null,
		transactionIndex: null,
		from: transaction.from,
		to: transaction.to,
		value: toBeHex(transaction.value),
		gas: toBeHex(transaction.gasLimit),
		gasPrice: toBeHex(transaction.maxFeePerGas ?? 0n),
		maxFeePerGas: toBeHex(transaction.maxFeePerGas ?? 0n),
		maxPriorityFeePerGas: toBeHex(transaction.maxPriorityFeePerGas ?? 0n),
		input: transaction.data,
		type: "0x2",
		chainId: toBeHex(transaction.chainId),
		accessList: transaction.accessList ?? [],
		v: toBeHex(transaction.signature?.v ?? 0),
		r: transaction.signature?.r ?? "0x0",
		s: transaction.signature?.s ?? "0x0",
	};
}
