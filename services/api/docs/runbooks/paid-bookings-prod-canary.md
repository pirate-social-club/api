# Paid Bookings Production Testnet Canary Runbook

This runbook is for the production API environment while paid bookings are
configured on Base Sepolia. There should be no Base mainnet funding,
configuration, or settlement expectation in this phase. The API runtime already
supports paid booking confirmation, Agora attendance, operator review, and
settlement; this procedure proves production-environment wiring against
testnet funds before unattended settlement is enabled.

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

Base Sepolia USDC:

```text
0x036CbD53842c5426634e7929541eC2318f3dCF7e
```

## Funding Requirements

Fund these wallets on Base Sepolia before running the claim canary:

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
rtk env BASE_SEPOLIA_RPC_URL=https://sepolia.base.org bun run smoke:paid-booking -- \
  --funding-preflight-only \
  --origin https://api.pirate.sc \
  --buyer-address <funded-buyer-wallet> \
  --chain-id 84532 \
  --token-address 0x036CbD53842c5426634e7929541eC2318f3dCF7e \
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

- Booking quote uses `chain_id=84532`, Base Sepolia USDC, and amount `1000000`.
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
Base Sepolia transactions during the next scheduled ticks. Keep the first
production bookings low-value until at least one normal cron-driven payout or
refund is observed.

## Stop Conditions

Keep production cron disabled, or disable it again, if any of these occur:

- Funding preflight fails.
- The canary quote is not Base Sepolia `84532` with USDC
  `0x036CbD53842c5426634e7929541eC2318f3dCF7e`.
- The canary submits payment but cannot confirm the booking.
- Final verification does not reach `status=settled`.
- The payout transaction is missing or uses an unexpected operator wallet.
- Any ambiguous or disputed booking lacks an operator-review resolution path.

## Operator Review Canary

Operator review uses `Operator <credential_id>.<secret>` authorization and the
`bookings:settlement:resolve` scope. Provide that full credential to the smoke
process through `PIRATE_BOOKING_SETTLEMENT_OPERATOR_CREDENTIAL`, or override the
environment variable name with `--operator-credential-env`.

Do not print the credential. If it is stored in Infisical, keep it under the
API service path and inject it with `infisical run`; if it is supplied manually,
scope it to one shell session.

### Credential provisioning

Mint operator credentials with the control-plane migrator database URL, not the
API runtime database URL. The API runtime role can read active credentials for
auth, but it must not be widened to insert or rotate rows in
`operator_credentials`.

The Pirate Infisical layout keeps the migrator URL under
`/services/control-plane`:

```bash
rtk infisical run --env prod --path /services/control-plane -- \
  rtk node -e "for (const k of ['CONTROL_PLANE_MIGRATOR_DATABASE_URL']) console.log(k + '=' + (process.env[k] ? 'present' : 'missing'))"
```

If the database URL contains `sslrootcert`, normalize the URL inside the child
process before invoking Bun SQL; Bun's Postgres client rejects that connection
parameter. Do not print the normalized URL.

Use private temp files when issuing and storing the credential so the
`opc_...secret` value does not appear in terminal output:

```bash
rtk bash -lc 'set -euo pipefail
rtk printf "\n" | rtk infisical user switch >/dev/null
envfile="$(mktemp /tmp/booking-opc-env.XXXXXX)"
trap '\''rtk rm -f "$envfile"'\'' EXIT

rtk infisical run --env prod --path /services/control-plane -- rtk bash -lc '\''
set -euo pipefail
export CONTROL_PLANE_OPERATOR_DATABASE_URL="$(
  rtk node -e "const raw=process.env.CONTROL_PLANE_MIGRATOR_DATABASE_URL;if(!raw)process.exit(2);const url=new URL(raw);url.searchParams.delete(\"sslrootcert\");process.stdout.write(url.toString())"
)"
rtk bun scripts/operator-credentials.ts issue \
  --database-url-env CONTROL_PLANE_OPERATOR_DATABASE_URL \
  --operator-actor-id svc_paid_bookings_prod_canary \
  --label "Paid bookings prod canary" \
  --scope bookings:settlement:resolve \
  --expires-at 2026-07-31T00:00:00Z \
  --credential-env-file "$0"
'\'' "$envfile"

rtk infisical secrets set --env prod --path /services/api --file "$envfile" --silent >/dev/null
echo "secret_set=PIRATE_BOOKING_SETTLEMENT_OPERATOR_CREDENTIAL"
'
```

For staging, use `--env staging`, `svc_paid_bookings_staging_smoke`, and a
staging label. Keep production unprovisioned until the prod canary phase unless
there is an approved operator-review rollout reason.

List pending reviews without resolving money:

```bash
rtk infisical run --project-config-dir /home/t42/Documents/pirate-workspace/core --env prod --path /services/api -- \
  rtk bun run smoke:booking-review -- \
    --origin https://api.pirate.sc \
    --limit 10
```

Inspect one pending review:

```bash
rtk infisical run --project-config-dir /home/t42/Documents/pirate-workspace/core --env prod --path /services/api -- \
  rtk bun run smoke:booking-review -- \
    --origin https://api.pirate.sc \
    --booking-id <booking-id>
```

Resolve one review. This can trigger payout/refund settlement, so run it only
after confirming the review version and intended outcome:

```bash
rtk infisical run --project-config-dir /home/t42/Documents/pirate-workspace/core --env prod --path /services/api -- \
  rtk bun run smoke:booking-review -- \
    --origin https://api.pirate.sc \
    --resolve \
    --booking-id <booking-id> \
    --resolution no_show_host \
    --expected-review-version <review-version> \
    --note "operator-reviewed attendance"
```

Expected results:

- `status=200` means the review resolved and settlement finalized.
- `status=202` means the review resolved but payout/refund settlement is still
  pending confirmation; poll the booking and settlement effect before retrying.
- Replaying the same resolution should be idempotent.
- Sending a different resolution after one is resolved should return a conflict.
