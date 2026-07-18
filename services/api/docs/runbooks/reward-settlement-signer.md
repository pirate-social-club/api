# Runbook: reward settlement signer

The rewards settlement signer is a dedicated Base wallet used only for reward cash-outs. Its funded balance is the payout blast radius. Provision staging first; production remains unsupported by the helper until the staging money loop is accepted.

## Secret boundary

Only `PIRATE_REWARDS_SETTLEMENT_OPERATOR_PRIVATE_KEY` is secret. Keep it in both:

- Infisical `/services/api` as the source of truth.
- The staging Worker's encrypted secret binding as the runtime copy.

Keep the operator address, RPC URL, chain ID, USDC token address, and token-override flag in `wrangler.jsonc`. Never pass the private key through command arguments, shell variables, shell history, terminal output, or a temporary file.

The Infisical CLI cannot accept `secrets set` values through stdin. Do not use its `NAME=value` or `--file` forms for this key. Generate the wallet with a trusted EVM-capable key generator, enter it directly into the masked Infisical UI field, and clear any clipboard used during that handoff. Never expose it to an agent.

## 1. Create the staging key in Infisical

In the Pirate project, staging environment, `/services/api` path:

1. Generate a fresh 32-byte EVM private key with a trusted wallet/key-management tool.
2. Create `PIRATE_REWARDS_SETTLEMENT_OPERATOR_PRIVATE_KEY` and enter the value directly into its masked field.
3. Clear any clipboard used for the handoff. Do not paste the key into a terminal, transcript, issue, or chat, and do not download or reuse it.

The operator performing this step must be authorized to change staging secrets. An agent must not automate the browser or inspect the value.

## 2. Derive and version the public configuration

Switch to the Pirate Infisical profile immediately before injection:

```bash
printf '\n' | rtk infisical user switch >/dev/null
```

Derive only the public address:

```bash
rtk infisical run --project-config-dir ../../../core --env staging --path /services/api -- \
  rtk bun run provision:reward-settlement-signer -- derive-address
```

Add the returned address and the public Base Sepolia configuration to the staging `vars` in `wrangler.jsonc`:

```jsonc
"PIRATE_REWARDS_SETTLEMENT_OPERATOR_ADDRESS": "0x...",
"PIRATE_REWARDS_SETTLEMENT_RPC_URL": "https://sepolia.base.org",
"PIRATE_REWARDS_SETTLEMENT_CHAIN_ID": "84532",
"PIRATE_REWARDS_SETTLEMENT_USDC_TOKEN_ADDRESS": "0x036CbD53842c5426634e7929541eC2318f3dCF7e",
"PIRATE_REWARDS_SETTLEMENT_ALLOW_TOKEN_OVERRIDE": "false"
```

Land and review that configuration before installing the runtime secret. The signing path independently rejects a key whose derived address differs from the configured address.

## 3. Stream the secret into the staging Worker

From `services/api`, inject the Infisical value into the provisioning process. The process validates it against the reviewed address, removes it from the child environment, and streams it to `wrangler secret put` over stdin:

```bash
printf '\n' | rtk infisical user switch >/dev/null
rtk infisical run --project-config-dir ../../../core --env staging --path /services/api -- \
  rtk bun run provision:reward-settlement-signer -- sync-worker-secret \
    --environment staging \
    --expected-address 0x...
```

Confirm only the secret name, never its value:

```bash
rtk bunx wrangler secret list --env staging
```

## 4. Fund with a bounded testnet balance

Funding is a separate operator action. Send only the amount approved for the staging acceptance loop:

- Base Sepolia ETH sufficient for the planned payout transactions plus modest retry headroom.
- Base Sepolia USDC no greater than the approved test campaign budget.

Verify the destination is the reviewed `PIRATE_REWARDS_SETTLEMENT_OPERATOR_ADDRESS`, the chain ID is `84532`, and the token is the versioned USDC address before sending. Record transaction hashes and resulting public balances. Never fund from another runtime signer.

## 5. Run and clean up the acceptance loop

Use the existing `scripts/staging-reward-identity.ts` seed and cleanup modes; do not create a second identity path. Run the complete funding, activation, qualification, deduplication, exhaustion, cash-out, and confirmed-payout loop while reward flags remain dark for ordinary traffic.

Afterward:

1. Clean up the seeded identity from its mode-0600 snapshot.
2. Reconcile the campaign and payout ledger with the on-chain transaction hashes.
3. Leave unused funds bounded or sweep them through an explicitly reviewed operator action.
4. Do not enable production from this runbook.

## Production enablement invariant

Never enable campaign creation by itself. A production change that sets
`REWARDS_CAMPAIGNS_ENABLED=true` must set both `REWARDS_ACCRUAL_ENABLED=true`
and `REWARDS_PAYOUTS_ENABLED=true` in the same reviewed release. If either the
accrual or payout rail is not ready, leave campaign creation disabled. The
runtime configuration resolver and the checked-in environment test enforce the
same implication: campaigns imply accrual and payouts.
