# Paid Bookings Production Canary Runbook

This runbook is for the first real Base-mainnet paid-booking canary and the
subsequent settlement-cron enablement. The API runtime already supports paid
booking confirmation, Agora attendance, operator review, and settlement; this
procedure proves production funding and deployed configuration before unattended
settlement is enabled.

## Preconditions

- Production API schema and secrets are provisioned.
- `BOOKINGS_SETTLEMENT_CRON_ENABLED` is still false or absent in production.
- Run commands from `services/api` in the API repository.
- Use Infisical profile `habitant_barber905@simplelogin.com` for Pirate
  workspace secrets. Do not print secret values.
- Do not use the compromised historical booking wallet
  `0x1041BaBe94Db4C3168196B778cB7e0519c3775DD`.

Active production booking settlement operator:

```text
0xbBA024600cba5F375AfdCeC401f7dcCB3D515829
```

Base mainnet USDC:

```text
0x833589fCD6eDb6E08f4c7C32D4f71b54bdA02913
```

## Funding Requirements

Fund these wallets on Base mainnet before running the claim canary:

- Settlement operator `0xbBA024600cba5F375AfdCeC401f7dcCB3D515829`: ETH for
  payout/refund gas. `0.001 ETH` is enough for the canary with margin.
- Buyer wallet: ETH for the USDC transfer gas plus at least `1 USDC`.

The canary booking is `1 USDC`. Normal fee math keeps `0.10 USDC` as platform
fee and pays `0.90 USDC` to the host payout wallet. The smoke script defaults
the host payout wallet to the buyer wallet when a buyer key is present.

## Address-Only Funding Preflight

Use this when the buyer address is known but the buyer private key should not be
loaded yet. This reads public chain state only.

```bash
rtk env BASE_MAINNET_RPC_URL=https://mainnet.base.org bun run smoke:paid-booking -- \
  --funding-preflight-only \
  --origin https://api.pirate.sc \
  --buyer-address <funded-buyer-wallet> \
  --chain-id 8453 \
  --token-address 0x833589fCD6eDb6E08f4c7C32D4f71b54bdA02913 \
  --settlement-address 0xbBA024600cba5F375AfdCeC401f7dcCB3D515829 \
  --amount-atomic 1000000
```

Expected result: `funding_preflight_ok` with nonzero buyer gas, buyer USDC, and
settlement operator gas. Do not continue if any funding check fails.

## Full Claim Canary

Switch to the Pirate Infisical profile immediately before reading secrets:

```bash
rtk printf '\n' | rtk infisical user switch >/dev/null
```

Run the production claim canary through Infisical so secrets stay in the child
process environment and are not printed:

```bash
rtk infisical run --project-config-dir /home/t42/Documents/pirate-workspace/core --env prod --path /services/api -- \
  rtk bun run smoke:paid-booking -- \
    --origin https://api.pirate.sc \
    --run-id 20260630-prod-paid-canary \
    --claim \
    --wait-for-completion
```

Expected evidence:

- Booking quote uses `chain_id=8453`, Base mainnet USDC, and amount `1000000`.
- The script submits one buyer USDC transfer to the settlement operator.
- The booking confirms, both session sides attach, and heartbeats are recorded.
- With `--wait-for-completion`, final verification requires:
  - booking status `settled`
  - `funding_tx_ref` equals the submitted buyer transfer
  - `payout_tx_ref` is a transaction hash
  - `live_room_id` equals `pirate-booking-{bookingId}`
- The script prints `smoke_complete`.

If the script exits after payment submission but before final verification,
inspect the printed booking id and funding transaction before retrying. Do not
send a second payment blindly.

## Cron Enablement

Only enable unattended production settlement after the full claim canary has
settled and the evidence has been recorded.

Set the production Worker secret:

```bash
rtk wrangler secret put BOOKINGS_SETTLEMENT_CRON_ENABLED --env production
```

Enter `true` when prompted. Do not use commands that dump existing secret values.

After enabling, monitor production logs, booking rows, settlement effects, and
Base transactions during the next scheduled ticks. Keep the first production
bookings low-value until at least one normal cron-driven payout or refund is
observed.

## Stop Conditions

Keep production cron disabled, or disable it again, if any of these occur:

- Funding preflight fails.
- The canary quote is not Base mainnet `8453` with USDC
  `0x833589fCD6eDb6E08f4c7C32D4f71b54bdA02913`.
- The canary submits payment but cannot confirm the booking.
- Final verification does not reach `status=settled`.
- The payout transaction is missing or uses an unexpected operator wallet.
- Any ambiguous or disputed booking lacks an operator-review resolution path.

