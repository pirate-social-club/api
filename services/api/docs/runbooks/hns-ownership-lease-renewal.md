# HNS ownership lease renewal

Use this operation only for an inactive HNS root that is still attached to an
active community and whose accepted ownership lease has expired or is nearing
expiry. It renews ownership evidence without provisioning DNS, rotating keys,
or writing a zone.

The operation compares the exact TXT value stored on the accepted namespace
verification session with the parent-chain TXT returned by the verifier's
read-only `verify-txt-public` operation.

- Exact TXT plus trusted parent-chain and expiry evidence: eligible for a
  fixed 30-day lease from the observation time.
- No TXT values: indeterminate, with no state change.
- One or more TXT values but no exact stored value: definitive negative. With
  `--apply`, the ownership verification stays or becomes stale and its
  capabilities remain withheld.

The command refuses activated or hard-denied roots. A successful renewal is
idempotent for 24 hours and records the lease policy, previous expiry, new
expiry, operator actor, and reason in the audit log.

## Dry run

Run from `services/api`:

```bash
rtk env infisical run \
  --project-config-dir /home/t42/Documents/pirate-workspace/core \
  --env prod \
  --path /services/api \
  -- rtk bun run admin:hns-ownership-lease-renew \
  --root ROOT \
  --actor operator_hns \
  --reason "targeted pre-activation ownership renewal" \
  --verifier-base-url https://verifier.pirate.sc/hns
```

Require `outcome: "renewable"` before applying. Never apply an
`indeterminate` result, and investigate a `definitive_negative` result before
allowing the command to persist it.

## Apply

Repeat the reviewed command with `--apply`:

```bash
rtk env infisical run \
  --project-config-dir /home/t42/Documents/pirate-workspace/core \
  --env prod \
  --path /services/api \
  -- rtk bun run admin:hns-ownership-lease-renew \
  --root ROOT \
  --actor operator_hns \
  --reason "targeted pre-activation ownership renewal" \
  --verifier-base-url https://verifier.pirate.sc/hns \
  --apply
```

The expected success is `outcome: "renewed"` and `applied: true`. A second
invocation within the idempotency window returns `already_current` and does
not call the verifier or extend the lease again.
