import { describe, expect, test } from "bun:test";
import { Transaction } from "ethers/transaction";
import { Wallet } from "ethers/wallet";
import {
	assertReplacementTransaction,
	pendingTransaction,
} from "./transaction-model";

const wallet = new Wallet(
	"0x59c6995e998f97a5a0044966f0945389dc9e86dae88c7a8412f4603b6b78690d",
);
const target = "0x1111111111111111111111111111111111111111";

async function signed(
	overrides: Partial<{
		nonce: number;
		to: string;
		value: bigint;
		data: string;
		gasLimit: bigint;
		maxFeePerGas: bigint;
		maxPriorityFeePerGas: bigint;
	}> = {},
): Promise<Transaction> {
	return Transaction.from(
		await wallet.signTransaction({
			type: 2,
			chainId: 1315,
			nonce: 7,
			to: target,
			value: 3n,
			data: "0x1234",
			gasLimit: 90_000n,
			maxFeePerGas: 10n,
			maxPriorityFeePerGas: 5n,
			...overrides,
		}),
	);
}

describe("controlled inclusion transaction model", () => {
	test("accepts only a fee-only replacement of the exact call", async () => {
		const replacement = await signed({
			maxFeePerGas: 12n,
			maxPriorityFeePerGas: 6n,
		});
		expect(() =>
			assertReplacementTransaction(
				{
					nonce: 7,
					signerAddress: wallet.address,
					targetAddress: target,
					valueWei: "3",
					calldata: "0x1234",
					gasLimit: "90000",
					maxFeePerGas: "10",
					maxPriorityFeePerGas: "5",
				},
				replacement,
			),
		).not.toThrow();
	});

	test("rejects call drift and non-increasing fee fields", async () => {
		const identity = {
			nonce: 7,
			signerAddress: wallet.address,
			targetAddress: target,
			valueWei: "3",
			calldata: "0x1234",
			gasLimit: "90000",
			maxFeePerGas: "10",
			maxPriorityFeePerGas: "5",
		};
		const drifted = await signed({
			value: 4n,
			maxFeePerGas: 12n,
			maxPriorityFeePerGas: 6n,
		});
		const underpriced = await signed({
			maxFeePerGas: 11n,
			maxPriorityFeePerGas: 5n,
		});
		expect(() => assertReplacementTransaction(identity, drifted)).toThrow(
			"replacement_call_identity_mismatch",
		);
		expect(() => assertReplacementTransaction(identity, underpriced)).toThrow(
			"replacement_fee_not_higher",
		);
	});

	test("serializes the held original as a pending JSON-RPC transaction", async () => {
		const transaction = await signed();
		if (!transaction.hash) throw new Error("signed transaction hash missing");
		expect(pendingTransaction(transaction, transaction.hash)).toMatchObject({
			hash: transaction.hash,
			nonce: "0x07",
			blockHash: null,
			blockNumber: null,
			transactionIndex: null,
			from: wallet.address,
			input: "0x1234",
			maxFeePerGas: "0x0a",
			maxPriorityFeePerGas: "0x05",
		});
	});
});
