# Story controlled-inclusion harness

Staging-only fault-injection Worker for the Story settlement fee-replacement drill. It is not a general JSON-RPC proxy and must never be deployed for production traffic.

## Safety model

- Registration continues to use `STORY_RPC_URL`; only coordinator traffic may use this Worker through `STORY_COORDINATOR_RPC_URL`.
- RPC and control credentials are distinct secrets of at least 32 bytes.
- Only the coordinator's required read methods and `eth_sendRawTransaction` are accepted.
- The first valid transaction for an armed signer/chain domain is durably persisted and reported pending but never forwarded.
- A replacement must preserve signer, nonce, target, value, calldata, and gas limit while increasing both EIP-1559 fee fields.
- Replacement bytes are persisted before the upstream broadcast is attempted. Ambiguous sends become successful only after the replacement hash is observable upstream.
- Completion requires an upstream receipt for the replacement hash. Sealing then removes all signed bytes while retaining both hashes and the audit record.
- Aborting before replacement broadcast scrubs all signed bytes. Aborting after a replacement was forwarded is prohibited.

## Drill lifecycle

1. Complete registration, listing, quote creation, and buyer funding using the ordinary Aeneid RPC.
2. Deploy this Worker to staging and set distinct `RPC_AUTH_TOKEN` and `CONTROL_AUTH_TOKEN` secrets.
3. Arm a fresh incident through `POST /control/arm` with the expected chain and coordinator signer.
4. Configure the API's `STORY_COORDINATOR_RPC_URL` to `/rpc/<incident-ref>` and set the matching `STORY_COORDINATOR_RPC_AUTH_TOKEN`.
5. Submit settlement. Inspect `/control/evidence` and prove generation zero is held and positively pending.
6. Request the bounded fee replacement through the API's scoped operator route.
7. Prove both hashes were durable before generation one was forwarded, then let the coordinator finish.
8. Call `/control/complete` only after the replacement receipt exists; capture final evidence and call `/control/seal`.
9. Remove both API override secrets and both harness secrets, disable scoped admission, and verify `signedBytesPresent` was zero before deleting access.

Every control endpoint requires the control bearer credential. The JSON-RPC endpoint requires the separate RPC bearer credential. Secret values must be supplied through Wrangler's interactive or file-based secret commands and must never appear in shell arguments or logs.
