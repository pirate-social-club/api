# Runbook: Story runtime signer funding

Song and video posts with royalties register an IP asset on **Story (Aeneid
testnet, chain 1315)**. That registration is a real on-chain transaction signed by
the **story-operator** wallet and gated by a pre-flight funding check. If the
operator's balance is below the enforced floor, **every** royalty post fails
deterministically and the user sees:

> "Publishing is temporarily blocked by an operator funding issue on our side.
> Our team has been notified — you don't need to retry."

(Before the 2026-07-02 fix this was a misleading "temporarily unavailable, try
again in a few minutes" — see PR #168.) This runbook is how you diagnose and
resolve that.

## The wallets

| Signer env var | Gates | Enforced floor |
| --- | --- | --- |
| `STORY_OPERATOR_PRIVATE_KEY` (`story-operator`) | Song/video **royalty registration** (mint + attach PIL terms) | **TARGET** (0.5 IP) — the royalty-registration path asserts the operator against the target, not the min |
| `STORY_CDR_WRITER_PRIVATE_KEY` (`story-cdr-writer`) | Locked-asset CDR allocate/write (paid delivery) | MIN (0.25 IP) |
| `MUSIC_PURCHASE_STORY_SETTLEMENT_PRIVATE_KEY` (`story-settlement`) | Music purchase settlement / royalty sync | MIN (0.25 IP) |
| `STORY_RUNTIME_FUNDER_PRIVATE_KEY` (falls back to `STORY_CONTRACT_OWNER_PRIVATE_KEY`) | Source wallet the top-up script sends **from** | n/a — keep it funded |

Floors are `STORY_RUNTIME_SIGNER_MIN_BALANCE_WEI` (0.25 IP) and
`STORY_RUNTIME_SIGNER_TARGET_BALANCE_WEI` (0.5 IP) in `wrangler.jsonc`.

> Note: in staging the operator and cdr-writer resolve to the **same address**
> (`0xc77Ad4de…F4BB`), and that operator address is **shared with prod**.

## 1. Check balances

Dry-run prints every signer's address + balance without sending anything:

```bash
cd services/api
infisical run --project-config-dir ../../../core --env staging --path /services/api -- \
  env STORY_RPC_URL=https://aeneid.storyrpc.io \
  bun run fund:story-runtime-signers --dry-run
# --env prod for production
```

Or hit the RPC directly for one address:

```bash
curl -s -X POST https://aeneid.storyrpc.io -H 'content-type: application/json' \
  -d '{"jsonrpc":"2.0","id":1,"method":"eth_getBalance","params":["0xc77Ad4de7d179FFFBa417cA24c055d86Af69F4BB","latest"]}'
```

## 2. Top up a signer from the funder wallet

Sends from `STORY_RUNTIME_FUNDER_PRIVATE_KEY` (or `STORY_CONTRACT_OWNER_PRIVATE_KEY`)
up to a target. Give the operator headroom above its 0.5 target (e.g. 0.7 IP):

```bash
cd services/api
infisical run --project-config-dir ../../../core --env staging --path /services/api -- \
  env STORY_RPC_URL=https://aeneid.storyrpc.io \
  bun run fund:story-runtime-signers --signer=story-operator --target-balance-wei=700000000000000000
```

- Omit `--signer=` to top up all three signers.
- `--target-balance-wei` overrides the default target for this run (wei; 0.7 IP =
  `700000000000000000`).
- The funder must itself hold enough IP (see step 3). This was the exact fix for
  the 2026-07-02 incident: operator had drifted to 0.4877 < 0.5.

## 3. Refill the FUNDER wallets (operator action — needs a faucet)

The funder wallets are topped from the **Story Aeneid faucet**, not from the app —
there is no in-repo faucet tooling, and you should **not** drain one runtime
wallet to pad another. When a funder runs low, send testnet IP to its address via
the faucet (Story Aeneid faucet / your funded ops wallet):

- Staging funder: `0xfBC505c0E2659400618b6cE0215b1ba4A2c5d79B`
  (fallback source `STORY_CONTRACT_OWNER` = `0xD713708b8460aB234BBb578C87Ca3EFf6aFcE3D4`)
- Prod funder: `0x07b12a71CE484819677259a3d5D0C03D3fa71CA1`

After refilling a funder, run step 2 to push balance into the signers.

## 4. Watchdog (proactive alert)

The scheduled cron runs a read-only funding watchdog (`story_runtime_funding_watchdog`,
PR #169) that warns **before** a signer hits its floor. Threshold =
`enforced_floor + 3 × worst_case_tx` (worst-case tx = `gasLimitCap × maxFeePerGasCap`
≈ 0.0075 IP, so ~0.0225 IP of runway). It emits:

- A greppable worker log line: `[story_runtime_funding_watchdog] BELOW FLOOR {…}`
  (or `low runway`), with `balance_ip`, `enforced_floor_ip`, `warn_threshold_ip`,
  `worst_case_tx_ip`, `balance_minus_floor_ip`, `tx_headroom`.
- An ops alert through the API Worker alert sink (task
  `story_runtime_funding_watchdog`, urgency `high` when below floor).

Recommended ops alert handling:

- Page on any high-urgency `scheduled_warning:story_runtime_funding_watchdog:*`
  alert. A signer is below its enforced floor and dependent transactions are
  already failing.
- Notify during working hours on medium-urgency watchdog alerts. A signer is
  still above its floor but has fewer than the configured runway transactions
  left.

When you see it: run step 1 to confirm, then step 2 (and step 3 if the funder is
also low). It is read-only and fail-soft — it never sends a transaction.

Tunables (optional env): `STORY_RUNTIME_FUNDING_WATCHDOG_INTERVAL_MS` (default
300000), `STORY_RUNTIME_FUNDING_WATCHDOG_TX_MARGIN` (default 3).

## 5. Verify end to end

Manual smoke — posts a real song and asserts it publishes **with** a registered
asset (spends ~0.002 operator IP; not on a timer, run on demand):

```bash
cd services/api
infisical run --project-config-dir ../../../core --env staging --path /services/api -- \
  bun run smoke:song-submit
```

Also runnable from GitHub via the `staging-song-submit-smoke` workflow
(workflow_dispatch).

## Current snapshot (2026-07-02, Aeneid testnet)

| Wallet | Address | Balance | Action |
| --- | --- | --- | --- |
| staging/prod operator (shared) | `0xc77Ad4de…F4BB` | ~0.70 IP | OK (topped 2026-07-02) |
| staging settlement | `0x526331dd…7D2F` | ~0.11 IP | **Below 0.25 min** — faucet + top up before relying on staging music purchases |
| staging funder | `0xfBC505c0…d79B` | ~0.03 IP | **Dry** — faucet refill (fallback `0xD713…E3D4` has ~0.22) |
| prod funder | `0x07b12a71…1CA1` | ~0.78 IP | Low-ish — faucet refill soon |
| prod cdr-writer | `0x9d5Dc963…e9FB` | ~0.25 IP | At min — watch |
| prod settlement | `0xc74Dd94a…e9c7` | ~0.25 IP | At min — watch |

Song posting itself (operator) is healthy in both envs. The remaining low
balances gate music-purchase/locked-delivery flows and are faucet actions, not
app changes.
