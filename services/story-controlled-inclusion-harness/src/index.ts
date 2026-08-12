import { DurableObject } from "cloudflare:workers";
import { getAddress } from "ethers/address";
import { keccak256 } from "ethers/crypto";
import { Transaction } from "ethers/transaction";
import {
	assertReplacementTransaction,
	pendingTransaction,
} from "./transaction-model";

type DrillState =
	| "armed"
	| "original_held"
	| "replacement_forwarded"
	| "completed"
	| "aborted";

type JsonRpcRequest = {
	id?: string | number | null;
	jsonrpc?: string;
	method?: string;
	params?: unknown[];
};

type JsonRpcResponse = {
	id: string | number | null;
	jsonrpc: "2.0";
	result?: unknown;
	error?: { code: number; message: string; data?: unknown };
};

type ArmInput = {
	incidentRef: string;
	chainId: number;
	signerAddress: string;
};

type CandidateRow = {
	generation: number;
	transaction_hash: string;
	signed_transaction: string | null;
	nonce: number;
	signer_address: string;
	target_address: string | null;
	value_wei: string;
	calldata: string;
	gas_limit: string;
	max_fee_per_gas: string;
	max_priority_fee_per_gas: string;
	disposition: string;
	created_at: string;
	forwarded_at: string | null;
};

type DrillRow = {
	incident_ref: string;
	state: DrillState;
	chain_id: number;
	signer_address: string;
	created_at: string;
	updated_at: string;
	aborted_at: string | null;
};

const MAX_BODY_BYTES = 1_000_000;
const ALLOWED_RPC_METHODS = new Set([
	"eth_blockNumber",
	"eth_call",
	"eth_chainId",
	"eth_estimateGas",
	"eth_feeHistory",
	"eth_gasPrice",
	"eth_getBalance",
	"eth_getBlockByNumber",
	"eth_getTransactionByHash",
	"eth_getTransactionCount",
	"eth_getTransactionReceipt",
	"eth_maxPriorityFeePerGas",
	"eth_sendRawTransaction",
]);

function jsonRpcError(
	id: JsonRpcRequest["id"],
	code: number,
	message: string,
	data?: unknown,
): JsonRpcResponse {
	return {
		jsonrpc: "2.0",
		id: id ?? null,
		error: { code, message, ...(data === undefined ? {} : { data }) },
	};
}

function normalizeIncidentRef(value: unknown): string {
	const ref = String(value || "").trim();
	if (!/^[a-zA-Z0-9][a-zA-Z0-9:_-]{7,127}$/.test(ref))
		throw new Error("incident_ref_invalid");
	return ref;
}

function normalizeSigner(value: unknown): string {
	try {
		return getAddress(String(value || ""));
	} catch {
		throw new Error("signer_address_invalid");
	}
}

function parseChainId(value: unknown): number {
	const chainId = Number(value);
	if (!Number.isSafeInteger(chainId) || chainId <= 0)
		throw new Error("chain_id_invalid");
	return chainId;
}

async function secretMatches(
	actual: string | null,
	expected: string | undefined,
): Promise<boolean> {
	const left = new TextEncoder().encode(actual || "");
	const right = new TextEncoder().encode(String(expected || ""));
	const [leftHash, rightHash] = await Promise.all([
		crypto.subtle.digest("SHA-256", left),
		crypto.subtle.digest("SHA-256", right),
	]);
	const a = new Uint8Array(leftHash);
	const b = new Uint8Array(rightHash);
	let difference = left.length ^ right.length;
	for (let index = 0; index < a.length; index += 1)
		difference |= (a[index] ?? 0) ^ (b[index] ?? 0);
	return difference === 0 && right.length >= 32;
}

function bearer(request: Request): string | null {
	const value = request.headers.get("authorization") || "";
	return value.startsWith("Bearer ")
		? value.slice("Bearer ".length).trim()
		: null;
}

async function boundedJson(request: Request): Promise<unknown> {
	const contentLength = Number(request.headers.get("content-length") || "0");
	if (contentLength > MAX_BODY_BYTES) throw new Error("body_too_large");
	const bytes = await request.arrayBuffer();
	if (bytes.byteLength > MAX_BODY_BYTES) throw new Error("body_too_large");
	return JSON.parse(new TextDecoder().decode(bytes));
}

export class ControlledInclusionDrill extends DurableObject<Env> {
	constructor(ctx: DurableObjectState, env: Env) {
		super(ctx, env);
		ctx.blockConcurrencyWhile(async () => {
			this.ctx.storage.sql.exec(`
        CREATE TABLE IF NOT EXISTS drill (
          singleton INTEGER PRIMARY KEY CHECK (singleton = 1),
          incident_ref TEXT NOT NULL,
          state TEXT NOT NULL,
          chain_id INTEGER NOT NULL,
          signer_address TEXT NOT NULL,
          created_at TEXT NOT NULL,
          updated_at TEXT NOT NULL,
          aborted_at TEXT
        );
        CREATE TABLE IF NOT EXISTS candidates (
          generation INTEGER PRIMARY KEY,
          transaction_hash TEXT NOT NULL UNIQUE,
          signed_transaction TEXT,
          nonce INTEGER NOT NULL,
          signer_address TEXT NOT NULL,
          target_address TEXT,
          value_wei TEXT NOT NULL,
          calldata TEXT NOT NULL,
          gas_limit TEXT NOT NULL,
          max_fee_per_gas TEXT NOT NULL,
          max_priority_fee_per_gas TEXT NOT NULL,
          disposition TEXT NOT NULL,
          created_at TEXT NOT NULL,
          forwarded_at TEXT
        );
      `);
		});
	}

	arm(input: ArmInput): { state: DrillState } {
		const existing = this.drill();
		if (existing) {
			if (
				existing.incident_ref !== input.incidentRef ||
				existing.chain_id !== input.chainId ||
				existing.signer_address !== input.signerAddress
			)
				throw new Error("drill_already_armed_for_another_domain");
			return { state: existing.state };
		}
		const now = new Date().toISOString();
		this.ctx.storage.sql.exec(
			"INSERT INTO drill (singleton, incident_ref, state, chain_id, signer_address, created_at, updated_at, aborted_at) VALUES (1, ?, 'armed', ?, ?, ?, ?, NULL)",
			input.incidentRef,
			input.chainId,
			input.signerAddress,
			now,
			now,
		);
		return { state: "armed" };
	}

	evidence(): {
		drill: DrillRow | null;
		candidates: CandidateRow[];
		signedBytesPresent: number;
	} {
		const drill = this.drill();
		const candidates = this.ctx.storage.sql
			.exec<CandidateRow>("SELECT * FROM candidates ORDER BY generation")
			.toArray();
		return {
			drill,
			candidates,
			signedBytesPresent: candidates.filter(
				(candidate) => candidate.signed_transaction !== null,
			).length,
		};
	}

	abort(): { state: "aborted"; signedBytesPresent: number } {
		const drill = this.requireDrill();
		if (
			drill.state === "replacement_forwarded" ||
			drill.state === "completed"
		) {
			throw new Error("drill_cannot_abort_after_replacement_forwarded");
		}
		const now = new Date().toISOString();
		this.ctx.storage.sql.exec(
			"UPDATE candidates SET signed_transaction = NULL WHERE signed_transaction IS NOT NULL",
		);
		this.ctx.storage.sql.exec(
			"UPDATE drill SET state = 'aborted', updated_at = ?, aborted_at = ? WHERE singleton = 1",
			now,
			now,
		);
		return {
			state: "aborted",
			signedBytesPresent: this.evidence().signedBytesPresent,
		};
	}

	async complete(): Promise<{ state: "completed"; winnerHash: string }> {
		const drill = this.requireDrill();
		if (drill.state === "completed") {
			const winner = this.candidate(1);
			if (!winner) throw new Error("replacement_candidate_missing");
			return { state: "completed", winnerHash: winner.transaction_hash };
		}
		if (drill.state !== "replacement_forwarded")
			throw new Error("replacement_not_forwarded");
		const winner = this.candidate(1);
		if (!winner) throw new Error("replacement_candidate_missing");
		const receipt = await this.forward({
			jsonrpc: "2.0",
			id: "completion-receipt",
			method: "eth_getTransactionReceipt",
			params: [winner.transaction_hash],
		});
		if (receipt.error || !receipt.result)
			throw new Error("replacement_receipt_not_observed");
		this.transition("replacement_forwarded", "completed");
		return { state: "completed", winnerHash: winner.transaction_hash };
	}

	seal(): { state: "completed"; signedBytesPresent: number } {
		const drill = this.requireDrill();
		if (drill.state !== "completed") throw new Error("drill_not_completed");
		this.ctx.storage.sql.exec(
			"UPDATE candidates SET signed_transaction = NULL WHERE signed_transaction IS NOT NULL",
		);
		return {
			state: "completed",
			signedBytesPresent: this.evidence().signedBytesPresent,
		};
	}

	async handleRpc(request: JsonRpcRequest): Promise<JsonRpcResponse> {
		const id = request.id ?? null;
		const method = String(request.method || "");
		const params = Array.isArray(request.params) ? request.params : [];
		try {
			if (!ALLOWED_RPC_METHODS.has(method))
				throw new Error("rpc_method_not_allowed");
			if (method === "eth_sendRawTransaction")
				return await this.sendRaw(id, params);
			if (
				method === "eth_getTransactionByHash" ||
				method === "eth_getTransactionReceipt"
			) {
				const held = this.candidateByHash(String(params[0] || ""));
				if (held?.disposition === "held") {
					if (method === "eth_getTransactionReceipt")
						return { jsonrpc: "2.0", id, result: null };
					if (!held.signed_transaction)
						return jsonRpcError(
							id,
							-32000,
							"held transaction bytes were scrubbed",
						);
					return {
						jsonrpc: "2.0",
						id,
						result: pendingTransaction(
							Transaction.from(held.signed_transaction),
							held.transaction_hash,
						),
					};
				}
			}
			return await this.forward({ ...request, id, jsonrpc: "2.0" });
		} catch (error) {
			return jsonRpcError(
				id,
				-32000,
				error instanceof Error ? error.message : "controlled inclusion failure",
			);
		}
	}

	private async sendRaw(
		id: string | number | null,
		params: unknown[],
	): Promise<JsonRpcResponse> {
		const drill = this.requireDrill();
		if (drill.state === "aborted" || drill.state === "completed")
			throw new Error(`drill_${drill.state}`);
		const signedTransaction = String(params[0] || "");
		const transaction = Transaction.from(signedTransaction);
		if (
			!transaction.from ||
			getAddress(transaction.from) !== drill.signer_address
		)
			throw new Error("transaction_signer_mismatch");
		if (Number(transaction.chainId) !== drill.chain_id)
			throw new Error("transaction_chain_id_mismatch");
		if (transaction.type !== 2) throw new Error("transaction_type_not_eip1559");
		const hash = keccak256(signedTransaction);
		const existing = this.candidateByHash(hash);
		if (existing) {
			if (
				existing.generation === 1 &&
				existing.disposition === "persisted_before_forward"
			) {
				return await this.forwardPersistedReplacement(id, existing);
			}
			return { jsonrpc: "2.0", id, result: hash };
		}

		const original = this.candidate(0);
		if (!original) {
			if (drill.state !== "armed") throw new Error("original_not_admissible");
			this.insertCandidate(0, transaction, signedTransaction, hash, "held");
			this.transition("armed", "original_held");
			return { jsonrpc: "2.0", id, result: hash };
		}
		if (drill.state !== "original_held")
			throw new Error("replacement_not_admissible");
		assertReplacementTransaction(
			{
				nonce: original.nonce,
				signerAddress: original.signer_address,
				targetAddress: original.target_address,
				valueWei: original.value_wei,
				calldata: original.calldata,
				gasLimit: original.gas_limit,
				maxFeePerGas: original.max_fee_per_gas,
				maxPriorityFeePerGas: original.max_priority_fee_per_gas,
			},
			transaction,
		);
		this.insertCandidate(
			1,
			transaction,
			signedTransaction,
			hash,
			"persisted_before_forward",
		);
		const persisted = this.candidate(1);
		if (!persisted)
			throw new Error("replacement_candidate_missing_after_insert");
		return await this.forwardPersistedReplacement(id, persisted);
	}

	private async forwardPersistedReplacement(
		id: string | number | null,
		candidate: CandidateRow,
	): Promise<JsonRpcResponse> {
		if (!candidate.signed_transaction)
			throw new Error("replacement_signed_bytes_missing");
		const response = await this.forward({
			jsonrpc: "2.0",
			id,
			method: "eth_sendRawTransaction",
			params: [candidate.signed_transaction],
		});
		if (response.error) {
			const observation = await this.forward({
				jsonrpc: "2.0",
				id: `replacement-observation-${String(id)}`,
				method: "eth_getTransactionByHash",
				params: [candidate.transaction_hash],
			});
			if (observation.error || !observation.result) return response;
			response.error = undefined;
			response.result = candidate.transaction_hash;
		}
		if (
			String(response.result || "").toLowerCase() !==
			candidate.transaction_hash.toLowerCase()
		) {
			throw new Error("upstream_replacement_hash_mismatch");
		}
		const now = new Date().toISOString();
		this.ctx.storage.sql.exec(
			"UPDATE candidates SET disposition = 'forwarded', forwarded_at = ? WHERE generation = 1 AND disposition = 'persisted_before_forward'",
			now,
		);
		this.transition("original_held", "replacement_forwarded");
		return response;
	}

	private insertCandidate(
		generation: number,
		transaction: Transaction,
		signedTransaction: string,
		hash: string,
		disposition: string,
	): void {
		if (!transaction.from) throw new Error("transaction_signer_missing");
		const now = new Date().toISOString();
		this.ctx.storage.sql.exec(
			`INSERT INTO candidates (
        generation, transaction_hash, signed_transaction, nonce, signer_address, target_address,
        value_wei, calldata, gas_limit, max_fee_per_gas, max_priority_fee_per_gas,
        disposition, created_at, forwarded_at
      ) VALUES (?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, NULL)`,
			generation,
			hash,
			signedTransaction,
			transaction.nonce,
			getAddress(transaction.from),
			transaction.to ? getAddress(transaction.to) : null,
			transaction.value.toString(),
			transaction.data,
			transaction.gasLimit.toString(),
			(transaction.maxFeePerGas ?? 0n).toString(),
			(transaction.maxPriorityFeePerGas ?? 0n).toString(),
			disposition,
			now,
		);
	}

	private async forward(request: JsonRpcRequest): Promise<JsonRpcResponse> {
		const response = await fetch(this.env.UPSTREAM_RPC_URL, {
			method: "POST",
			headers: { "content-type": "application/json" },
			body: JSON.stringify(request),
		});
		if (!response.ok) throw new Error(`upstream_http_${response.status}`);
		const contentLength = Number(response.headers.get("content-length") || "0");
		if (contentLength > MAX_BODY_BYTES)
			throw new Error("upstream_body_too_large");
		const bytes = await response.arrayBuffer();
		if (bytes.byteLength > MAX_BODY_BYTES)
			throw new Error("upstream_body_too_large");
		return JSON.parse(new TextDecoder().decode(bytes)) as JsonRpcResponse;
	}

	private drill(): DrillRow | null {
		return (
			this.ctx.storage.sql
				.exec<DrillRow>("SELECT * FROM drill WHERE singleton = 1")
				.toArray()[0] ?? null
		);
	}

	private requireDrill(): DrillRow {
		const drill = this.drill();
		if (!drill) throw new Error("drill_not_armed");
		return drill;
	}

	private candidate(generation: number): CandidateRow | null {
		return (
			this.ctx.storage.sql
				.exec<CandidateRow>(
					"SELECT * FROM candidates WHERE generation = ?",
					generation,
				)
				.toArray()[0] ?? null
		);
	}

	private candidateByHash(hash: string): CandidateRow | null {
		return (
			this.ctx.storage.sql
				.exec<CandidateRow>(
					"SELECT * FROM candidates WHERE lower(transaction_hash) = lower(?)",
					hash,
				)
				.toArray()[0] ?? null
		);
	}

	private transition(from: DrillState, to: DrillState): void {
		const result = this.ctx.storage.sql.exec(
			"UPDATE drill SET state = ?, updated_at = ? WHERE singleton = 1 AND state = ?",
			to,
			new Date().toISOString(),
			from,
		);
		if (result.rowsWritten !== 1) throw new Error("drill_state_conflict");
	}
}

function drillStub(
	env: Env,
	incidentRef: string,
): DurableObjectStub<ControlledInclusionDrill> {
	if (!env.DRILLS) throw new Error("drills_binding_missing");
	return env.DRILLS.getByName(incidentRef);
}

async function authorized(
	request: Request,
	expected: string | undefined,
): Promise<boolean> {
	return await secretMatches(bearer(request), expected);
}

export default {
	async fetch(request: Request, env: Env): Promise<Response> {
		const url = new URL(request.url);
		try {
			if (env.ENVIRONMENT !== "staging") {
				return Response.json({ error: "not_found" }, { status: 404 });
			}
			if (
				!env.RPC_AUTH_TOKEN ||
				!env.CONTROL_AUTH_TOKEN ||
				env.RPC_AUTH_TOKEN === env.CONTROL_AUTH_TOKEN
			) {
				return Response.json(
					{ error: "harness_credentials_invalid" },
					{ status: 503 },
				);
			}
			if (url.pathname.startsWith("/rpc/")) {
				if (request.method !== "POST") {
					return Response.json(
						{ error: "method_not_allowed" },
						{ status: 405 },
					);
				}
				if (!(await authorized(request, env.RPC_AUTH_TOKEN)))
					return Response.json({ error: "unauthorized" }, { status: 401 });
				const incidentRef = normalizeIncidentRef(
					decodeURIComponent(url.pathname.slice("/rpc/".length)),
				);
				const body = await boundedJson(request);
				if (Array.isArray(body)) {
					const responses: JsonRpcResponse[] = [];
					for (const item of body)
						responses.push(
							await drillStub(env, incidentRef).handleRpc(
								item as JsonRpcRequest,
							),
						);
					return Response.json(responses);
				}
				return Response.json(
					await drillStub(env, incidentRef).handleRpc(body as JsonRpcRequest),
				);
			}
			if (!url.pathname.startsWith("/control/"))
				return Response.json({ error: "not_found" }, { status: 404 });
			if (!(await authorized(request, env.CONTROL_AUTH_TOKEN)))
				return Response.json({ error: "unauthorized" }, { status: 401 });
			if (url.pathname === "/control/arm" && request.method === "POST") {
				const body = (await boundedJson(request)) as Partial<ArmInput>;
				const input = {
					incidentRef: normalizeIncidentRef(body.incidentRef),
					chainId: parseChainId(body.chainId),
					signerAddress: normalizeSigner(body.signerAddress),
				};
				return Response.json(
					await drillStub(env, input.incidentRef).arm(input),
				);
			}
			const incidentRef = normalizeIncidentRef(
				url.searchParams.get("incident_ref"),
			);
			if (url.pathname === "/control/evidence" && request.method === "GET") {
				return Response.json(await drillStub(env, incidentRef).evidence());
			}
			if (url.pathname === "/control/abort" && request.method === "POST") {
				return Response.json(await drillStub(env, incidentRef).abort());
			}
			if (url.pathname === "/control/complete" && request.method === "POST") {
				return Response.json(await drillStub(env, incidentRef).complete());
			}
			if (url.pathname === "/control/seal" && request.method === "POST") {
				return Response.json(await drillStub(env, incidentRef).seal());
			}
			return Response.json({ error: "not_found" }, { status: 404 });
		} catch (error) {
			return Response.json(
				{ error: error instanceof Error ? error.message : "internal_error" },
				{ status: 400 },
			);
		}
	},
};
