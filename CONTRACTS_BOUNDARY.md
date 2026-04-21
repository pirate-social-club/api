# Contracts Boundary

## Purpose

This file explains why generated API contracts in `pirate-api` cannot currently be fully enforced by `pirate-api` CI alone.

## Current Setup

Generated contracts live here:

- `services/contracts/src/index.ts`

The generator script lives outside this repo boundary:

- `../specs/api/scripts/generate-api-contracts.ts`

The generator reads schema and route inputs from:

- `../specs/api/src/**`

## Current Implication

`pirate-api` GitHub Actions runs inside the `pirate-api` repo checkout.

That checkout does not inherently include:

- `../specs/api/scripts/**`
- `../specs/api/src/**`

Because of that:

- `pirate-api` CI can typecheck generated contracts
- `pirate-api` CI cannot reliably regenerate contracts from source-of-truth specs unless those specs are also present in the CI checkout
- a complete freshness check is only possible in a workspace that contains both `pirate-api` and `specs`

## Local Freshness Check

For local and shared-workspace verification, `services/contracts` now provides:

```bash
cd /home/t42/Documents/pirate-v2/pirate-api/services/contracts
rtk bun run check:fresh
```

This:

- runs the shared generator from `../specs/api`
- writes to a temporary output path
- compares the temporary output with `services/contracts/src/index.ts`
- fails if the generated contracts are stale

## What CI Can Enforce Today

Inside `pirate-api` CI, the repo can currently enforce:

- `services/contracts` typecheck
- generated contracts freshness when the sibling `specs/api` checkout is present
- API and CLI typecheck/test flows that consume the generated contracts

## What CI Still Cannot Enforce Alone

Until repo boundaries change, `pirate-api` CI cannot, by itself:

- watch `specs/api/**` as a trigger source
- regenerate contracts from the upstream spec source
- prove generated freshness from source-of-truth inputs

The workflow includes a conditional freshness step. It runs `rtk bun run check:fresh` when `../../../specs/api/scripts/generate-api-contracts.ts` exists and skips when `pirate-api` is checked out by itself.

## Long-Term Fix Options

One of these needs to happen:

1. Move the contract source-of-truth into the `pirate-api` repo.
2. Mirror the needed `specs/api` inputs into `pirate-api`.
3. Run contract freshness checks from a parent/workspace CI that checks out both repos.
4. Publish versioned API spec artifacts that `pirate-api` CI can consume deterministically.

## Rule For Contributors

If you change API spec inputs under `specs/api`, also run:

```bash
cd /home/t42/Documents/pirate-v2/pirate-api/services/contracts
rtk bun run generate
rtk bun run check:fresh
```

and commit the resulting `services/contracts/src/index.ts` update in `pirate-api`.
