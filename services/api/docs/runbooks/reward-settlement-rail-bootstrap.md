# Reward settlement rail bootstrap

Binds one settlement rail per environment in the control-plane registry
(core migration 0236: `reward_settlement_rails`). A rail is the
environment-specific custody binding — backend, treasury, vault where
applicable, operator, policy version — for one admitted settlement asset.
The registry-authority rollout (see
`docs/erc20-multi-asset-reward-settlement.md` and the core spec) requires
exactly one active rail per environment and asset before
`REWARDS_SETTLEMENT_REGISTRY_AUTHORITY_ENABLED` may ever be turned on.

The API role holds SELECT alone on the registry tables. This procedure runs
with an admin/migrator credential; it is the only sanctioned mutation path
besides migrations.

## Script properties

`scripts/bootstrap-reward-settlement-rail.ts` is:

- **Transactional** — asset admission check, conflict check, insert, and
  read-back happen in one transaction; every read takes `FOR UPDATE`.
- **Idempotent** — an existing active rail with the identical binding is
  reported as `already_bound` and nothing is written.
- **Conflict-refusing** — an existing active rail with a *different* binding
  aborts with `conflicting_active_rail`. Rebinding is a deliberate two-step
  operator action (retire the old row, then bootstrap), never automatic.
- **Dry-run capable** — `--dry-run` performs every check inside the
  transaction and rolls back, reporting `dry_run_would_insert` or
  `dry_run_already_bound`.
- **Credential-redacting** — the database URL is read from an environment
  variable named by `--database-url-env`; output only ever contains
  `host/path`, never credentials.
- **Evidence-producing** — on insert it reads the row back from PostgreSQL
  and prints that stored binding as JSON, not an echo of the input.

It also refuses to bind an asset that is missing from
`reward_settlement_assets` or whose status is not `admitted`.

## Preconditions (per environment)

1. Core migration 0236 is ledger-applied in the target environment's
   control-plane database; verify the schema attestation ledger entry and
   checksum for the deployed core pin before running.
2. Resolve the expected binding from the environment's deployed
   configuration — these must be the values the Worker actually runs with:
   - backend: `PIRATE_REWARDS_SETTLEMENT_BACKEND`
   - treasury: `REWARDS_CAMPAIGN_TREASURY_ADDRESS`
   - operator: the configured settlement signer's address
   - vault: `REWARDS_TREASURY_VAULT_ADDRESS` (vault backends only)
   - chain/token: `REWARDS_CAMPAIGN_CHAIN_ID` /
     `REWARDS_CAMPAIGN_USDC_TOKEN_ADDRESS`
3. Obtain the admin database URL from the environment's secret store into a
   shell variable; never paste it on a command line.

## Procedure

Run from `services/api`. Staging first; production only after the staging
rail has been verified by the shadow diagnostics.

```bash
export REWARD_RAIL_BOOTSTRAP_DATABASE_URL="<admin url from the secret store>"

bun scripts/bootstrap-reward-settlement-rail.ts \
  --database-url-env REWARD_RAIL_BOOTSTRAP_DATABASE_URL \
  --environment staging \
  --backend eoa_vault \
  --chain-id 84532 \
  --token-address 0x036cbd53842c5426634e7929541ec2318f3dcf7e \
  --treasury-address <REWARDS_CAMPAIGN_TREASURY_ADDRESS> \
  --vault-address <REWARDS_TREASURY_VAULT_ADDRESS> \
  --operator-address <settlement signer address> \
  --dry-run
```

1. Review the dry-run output: the plan must match the deployed configuration
   field for field.
2. Re-run without `--dry-run`.
3. Archive the emitted JSON (the read-back binding, database target, and
   timestamp) as the environment's rail-bootstrap evidence, following the
   existing fixture-audit conventions.
4. After a Worker containing the registry reader (api `b79297f3` or later)
   is deployed, confirm the shadow diagnostics report `outcome: "match"`
   with a zero mismatch map for the environment.

## Failure modes

| Error | Meaning | Action |
| --- | --- | --- |
| `asset_missing` | chain/token pair is not in `reward_settlement_assets` | wrong token or 0236 not applied; stop |
| `asset_not_admitted` | asset is suspended or retired | do not bind; follow the lifecycle runway in the core spec |
| `conflicting_active_rail` | an active rail with different custody exists | investigate; retire the old rail deliberately before rebinding |
| `invalid_input` | argument failed validation | fix the argument; nothing was written |

A conflict or validation failure never leaves partial state: the transaction
is rolled back before the error is printed.
