# Runbook: reward settlement signer

The rewards settlement signer is the campaign treasury: one dedicated Base wallet receives campaign funding and signs reward cash-outs and custody refunds. Its funded balance is the payout and refund blast radius. Campaign funding must remain disabled until the runtime proves that the installed private key controls the versioned treasury/operator address and that campaign and settlement chain/token configuration match.

## Secret boundary

Only `PIRATE_REWARDS_SETTLEMENT_OPERATOR_PRIVATE_KEY` is secret. Keep it in both:

- Infisical `/services/api` as the source of truth.
- The matching environment Worker's encrypted secret binding as the runtime copy.

Keep the operator address, RPC URL, chain ID, USDC token address, and token-override flag in `wrangler.jsonc`. Never pass the private key through command arguments, shell variables, shell history, terminal output, or a temporary file.

The Infisical CLI cannot accept `secrets set` values through stdin. Do not use its `NAME=value` or `--file` forms for this key. Generate the wallet with a trusted EVM-capable key generator, enter it directly into the masked Infisical UI field, and clear any clipboard used during that handoff. Never expose it to an agent.

## 1. Create the environment key in Infisical

In the Pirate project, the target environment, `/services/api` path:

1. Generate a fresh 32-byte EVM private key with a trusted wallet/key-management tool.
2. Create `PIRATE_REWARDS_SETTLEMENT_OPERATOR_PRIVATE_KEY` and enter the value directly into its masked field.
3. Clear any clipboard used for the handoff. Do not paste the key into a terminal, transcript, issue, or chat, and do not download or reuse it.

The operator performing this step must be authorized to change that environment's secrets. An agent must not automate the browser or inspect the value.

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

Use `--env prod` for the production key; never derive a production address from the staging environment.

Add the returned address and public chain configuration to the target environment in `wrangler.jsonc`. The campaign treasury and settlement operator must be the same address; the campaign and settlement chain and token must also match:

```jsonc
"PIRATE_REWARDS_SETTLEMENT_OPERATOR_ADDRESS": "0x...",
"PIRATE_REWARDS_SETTLEMENT_RPC_URL": "https://sepolia.base.org",
"PIRATE_REWARDS_SETTLEMENT_CHAIN_ID": "84532",
"PIRATE_REWARDS_SETTLEMENT_USDC_TOKEN_ADDRESS": "0x036CbD53842c5426634e7929541eC2318f3dCF7e",
"PIRATE_REWARDS_SETTLEMENT_ALLOW_TOKEN_OVERRIDE": "false",
"REWARDS_CAMPAIGN_TREASURY_ADDRESS": "0x...",
"REWARDS_CAMPAIGN_CHAIN_ID": "84532",
"REWARDS_CAMPAIGN_USDC_TOKEN_ADDRESS": "0x036CbD53842c5426634e7929541eC2318f3dCF7e"
```

Land and review that configuration before installing the runtime secret. The signing path independently rejects a key whose derived address differs from the configured address.

## 3. Stream the secret into the Worker

From `services/api`, inject the Infisical value into the provisioning process. The process validates it against the reviewed address, removes it from the child environment, and streams it to `wrangler secret put` over stdin:

```bash
printf '\n' | rtk infisical user switch >/dev/null
rtk infisical run --project-config-dir ../../../core --env staging --path /services/api -- \
  rtk env INFISICAL_ENVIRONMENT=staging bun run provision:reward-settlement-signer -- sync-worker-secret \
    --environment staging \
    --expected-address 0x...
```

Confirm only the secret name, never its value:

```bash
rtk bunx wrangler secret list --env staging
```

For production, use the production Infisical environment and the explicit confirmation guard:

```bash
printf '\n' | rtk infisical user switch >/dev/null
rtk infisical run --project-config-dir ../../../core --env prod --path /services/api -- \
  rtk env INFISICAL_ENVIRONMENT=prod bun run provision:reward-settlement-signer -- sync-worker-secret \
    --environment production \
    --expected-address 0x... \
    --confirm-production
rtk bunx wrangler secret list --env production
```

Do not enable campaign funding merely because the secret name is present. Deploy the public configuration with campaigns dark first and verify that `/reward_campaign_capabilities` remains disabled. It may report enabled only after the matching secret is installed and the coordinated flag release is deployed.

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
4. Keep production dark until the production checks below pass.

## 6. Production enablement

Production enablement is a coordinated release, not a staged campaign/accrual/payout rollout:

1. Install and validate the production signer secret using the guarded procedure above.
2. Confirm the campaign treasury, settlement operator, campaign chain, settlement chain, campaign token, and settlement token are identical in their respective pairs.
3. Fund the wallet with bounded native gas and approved USDC headroom.
4. Verify there are no unexpected `refund_pending` or `funding_confirming` effects.
5. In one reviewed release, set `REWARDS_CAMPAIGNS_ENABLED=true`, `REWARDS_ACCRUAL_ENABLED=true`, `REWARDS_PAYOUTS_ENABLED=true`, and `REWARDS_REFUNDS_ENABLED=true`.
6. Confirm authenticated capabilities report `enabled:true`, then run the bounded pilot.

`REWARDS_REFUNDS_ENABLED` is an independent custody-recovery switch. Leave it true when campaign creation or ordinary payouts are disabled unless the signer itself is suspected compromised. This allows already-owed refunds to drain during a campaign kill-switch event.

## Wallet rotation invariant

Before changing the treasury/operator key, address, chain, or token, prove all of the following in the control-plane database:

- zero `reward_campaign_funding_effects` rows with `status = 'refund_pending'`;
- zero rows with `status = 'confirming'`;
- zero unexpired rows with `status = 'quoted'`.

Disable new campaign funding before taking this snapshot and keep it disabled until the new wallet is ready. A pending effect remains bound to its persisted custody wallet and asset. If rotation happens prematurely, restore the old campaign and settlement configuration plus its Worker secret long enough to drain the old effects; do not use the new wallet to imitate an old-wallet refund.

## Production enablement invariant

Never enable campaign creation by itself. A production change that sets
`REWARDS_CAMPAIGNS_ENABLED=true` must set both `REWARDS_ACCRUAL_ENABLED=true`
and `REWARDS_PAYOUTS_ENABLED=true` in the same reviewed release. If either the
accrual or payout rail is not ready, leave campaign creation disabled. The
runtime configuration resolver and the checked-in environment test enforce the
same implication: campaigns imply accrual and payouts.
