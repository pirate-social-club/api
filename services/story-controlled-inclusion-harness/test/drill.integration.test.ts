import { env, fetchMock } from "cloudflare:test";
import { afterAll, beforeAll, describe, expect, test } from "vitest";

const signerAddress = "0x70997970C51812dc3A010C7d01b50e0d17dc79C8";
const incidentRef = "m4-controlled-inclusion-test";
const original =
	"0x02f86782052309050a83015f9094111111111111111111111111111111111111111107821234c080a02f87dcb6b999c28c1d8e3c9312a8b8cf5e8c09d3e847a74672413ac14cb02491a066ee23cd8000f93137fc2ee29066e110fcdd7772231e096f7d7e5c0229dc2ae4";
const originalHash =
	"0x42b2a38c16294c8177bf12dffa38def5970e454bc6bd72cd5c1e549452b99004";
const replacement =
	"0x02f86782052309060c83015f9094111111111111111111111111111111111111111107821234c001a0e8fb7a69b1e6c44fb4e32efb412ae9adf27ad1172304b1901b319a2b63e4feb4a025e5001d844419332ca709521570bcd93b906661361458109a7166d7e5ec770b";
const replacementHash =
	"0x93d688b3ed3106677042f00acc05d0a3d3af1915a0bbf0d49a31067606234875";

beforeAll(() => {
	fetchMock.activate();
	fetchMock.disableNetConnect();
});

afterAll(() => fetchMock.deactivate());

describe("controlled inclusion Durable Object", () => {
	test("holds gen-0, persists gen-1 before forwarding, and seals bytes after receipt evidence", async () => {
		const stub = env.DRILLS.getByName(incidentRef);
		await stub.arm({ incidentRef, chainId: 1315, signerAddress });

		await expect(
			stub.handleRpc({
				jsonrpc: "2.0",
				id: 1,
				method: "eth_sendRawTransaction",
				params: [original],
			}),
		).resolves.toMatchObject({ result: originalHash });
		await expect(
			stub.handleRpc({
				jsonrpc: "2.0",
				id: 2,
				method: "eth_getTransactionByHash",
				params: [originalHash],
			}),
		).resolves.toMatchObject({
			result: { hash: originalHash, blockHash: null },
		});

		fetchMock
			.get("https://aeneid.test.invalid")
			.intercept({ path: "/", method: "POST" })
			.reply(
				200,
				JSON.stringify({ jsonrpc: "2.0", id: 3, result: replacementHash }),
			);
		await expect(
			stub.handleRpc({
				jsonrpc: "2.0",
				id: 3,
				method: "eth_sendRawTransaction",
				params: [replacement],
			}),
		).resolves.toMatchObject({ result: replacementHash });

		const beforeCompletion = await stub.evidence();
		expect(beforeCompletion.drill?.state).toBe("replacement_forwarded");
		expect(
			beforeCompletion.candidates.map(
				(candidate) => candidate.transaction_hash,
			),
		).toEqual([originalHash, replacementHash]);
		expect(beforeCompletion.signedBytesPresent).toBe(2);

		fetchMock
			.get("https://aeneid.test.invalid")
			.intercept({ path: "/", method: "POST" })
			.reply(
				200,
				JSON.stringify({
					jsonrpc: "2.0",
					id: "completion-receipt",
					result: { status: "0x1" },
				}),
			);
		await expect(stub.complete()).resolves.toEqual({
			state: "completed",
			winnerHash: replacementHash,
		});
		await expect(stub.seal()).resolves.toEqual({
			state: "completed",
			signedBytesPresent: 0,
		});
		expect(
			(await stub.evidence()).candidates.map(
				(candidate) => candidate.transaction_hash,
			),
		).toEqual([originalHash, replacementHash]);
	});

	test("recovers an ambiguous replacement send only from positive hash observation", async () => {
		const retryIncident = `${incidentRef}-ambiguous`;
		const stub = env.DRILLS.getByName(retryIncident);
		await stub.arm({
			incidentRef: retryIncident,
			chainId: 1315,
			signerAddress,
		});
		await stub.handleRpc({
			jsonrpc: "2.0",
			id: 10,
			method: "eth_sendRawTransaction",
			params: [original],
		});

		fetchMock
			.get("https://aeneid.test.invalid")
			.intercept({ path: "/", method: "POST" })
			.reply(
				200,
				JSON.stringify({
					jsonrpc: "2.0",
					id: 11,
					error: { code: -32000, message: "timeout" },
				}),
			);
		fetchMock
			.get("https://aeneid.test.invalid")
			.intercept({ path: "/", method: "POST" })
			.reply(
				200,
				JSON.stringify({
					jsonrpc: "2.0",
					id: "replacement-observation-11",
					result: { hash: replacementHash },
				}),
			);

		await expect(
			stub.handleRpc({
				jsonrpc: "2.0",
				id: 11,
				method: "eth_sendRawTransaction",
				params: [replacement],
			}),
		).resolves.toMatchObject({ result: replacementHash });
		expect((await stub.evidence()).drill?.state).toBe("replacement_forwarded");
	});
});
