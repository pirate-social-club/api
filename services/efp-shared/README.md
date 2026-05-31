# EFP Shared

Shared EFP follow-list helpers used by the web app and API-adjacent tooling.

Keep this package limited to deterministic, runtime-safe EFP primitives:

- EFP contract ABIs for account metadata, list registry, list records, and list minting
- address normalization
- follow/unfollow list operation encoding
- primary-list mint storage-location encoding
- transaction-plan builders for follow writes
- sponsored follow intent helpers

Do not add API clients, wallet signing, persistence, or environment-specific configuration here. Callers should own RPC clients, signer selection, and transaction submission.

```bash
rtk bun run check
```
