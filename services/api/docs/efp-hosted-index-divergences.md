# Verified EFP hosted-index divergences

Pirate independently indexes Ethereum Follow Protocol list operations from
Ethereum, Optimism, and Base. During validation we found effective follow edges
that the hosted EFP API omitted even though Base's canonical contract state says
the terminal operation is `add`.

The current evidence set contains 17 edges. Each entry records:

- the EFP list ID and followed address;
- the transaction hash of the terminal `add`;
- a direct `getAllListOps(slot)` check against `EFPListRecords`; and
- a successful receipt containing the matching `ListOp` event.

The evidence is maintained in
[`known-divergences.ts`](../src/lib/efp-indexer/known-divergences.ts). The verifier
does not trust Pirate's materialized projection or the hosted API: it reads
contract storage and transaction receipts directly from Base.

## Reproduce

From `services/api`, provide any Base mainnet RPC endpoint that supports
`eth_call` and transaction receipts, then run:

```bash
BASE_MAINNET_RPC_URL="https://your-base-rpc.example" \
  bun run efp:verify-known-divergences
```

The command prints one JSON object per verified edge and exits non-zero if a
terminal operation, slot, receipt, or event no longer matches the recorded
evidence. Addresses and transaction hashes are public chain data; no Pirate
credentials or database access are required.

## Scope

This is a reproducible correctness finding about particular hosted-index
results, not a claim that every disagreement favors Pirate. New disagreements
remain failures until independently resolved against chain state. Known entries
are also rechecked so a resolved divergence is observable rather than hidden by
a permanent allowlist.
