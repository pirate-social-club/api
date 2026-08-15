# Megapot staging secrets: Infisical OIDC binding

This is the one-time administrator setup for unattended Base Sepolia cycles.
It is deliberately limited to the staging environment. Mainnet is not an
allowed target for this identity.

## Infisical layout

Use the existing API secrets project (project slug: `pirate-api`) and create
the following environment/path:

| Field | Value |
| --- | --- |
| Environment | `staging` |
| Secret path | `/services/megapot-automation` |
| Access | read-only; no create, update, delete, or project-management permission |
| Allowed repository | `pirate-social-club/api` |
| Allowed GitHub environment | `staging` |

The path contains the signer and runtime values consumed by the cycle runner:

```text
MEGAPOT_CHAIN_ID=84532
MEGAPOT_RPC_URL
REWARD_TICKET_PURCHASE_OPERATOR_ADDRESS
REWARD_TICKET_PLATFORM_REVENUE_ADDRESS
REWARD_TICKET_CUSTODY_ADDRESS
REWARD_TICKET_PURCHASE_ESCROW_ADDRESS
REWARD_TICKET_COMMITMENT_REGISTRY_ADDRESS
REWARD_TICKET_CLAIM_MODULE_ADDRESS
REWARD_TICKET_PURCHASE_ESCROW_CODE_HASH
REWARD_TICKET_COMMITMENT_REGISTRY_CODE_HASH
REWARD_TICKET_CLAIM_MODULE_CODE_HASH
REWARD_TICKET_SIGNER_PRIVATE_KEY
```

`REWARD_TICKET_SIGNER_PRIVATE_KEY` exists only in Infisical. It must never be
written to a file, GitHub Actions artifact, log, cache, or deployment
manifest. Contract addresses and code hashes must match the merged Base
Sepolia manifest before a runner may sign.

## GitHub OIDC identity

Create one Infisical machine identity named `github-api-megapot-staging` and
bind its OIDC/JWT trust policy to:

```text
issuer:   https://token.actions.githubusercontent.com
audience: infisical
subject:  repo:pirate-social-club/api:environment:staging
```

Grant that identity read access only to project `pirate-api`, environment
`staging`, path `/services/megapot-automation`. Do not grant access to
`production`, any mainnet path, or sibling service paths. Require the GitHub
workflow to use `id-token: write` and the protected `staging` environment;
pull requests from forks must not be permitted to assume this identity.

## Operator checklist

The administrator must record the Infisical project ID, identity ID, and
environment/path IDs in the deployment evidence (IDs are intentionally not
committed here). The first scheduled run must log only the identity and path
metadata, never secret values, and must fail closed if any manifest address,
chain ID, or bytecode hash differs.
