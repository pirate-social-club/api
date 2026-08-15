# ERC-20 Multi-Asset Reward Settlement — API Pointer

The canonical program specification lives in the Core repository (the
schema-owning repo):

`core: specs/domain/erc20-multi-asset-reward-settlement.md`

Status: ratified program specification (2026-08-15) — proposed program, not
active implementation. It builds on API #1318 (merged `d82803fa`), which
snapshots the settlement-asset descriptor into campaign terms hash v5, and on
Core migrations 0231/0232.

API-side scope defined by that spec:

- A registry reader (`reward-settlement-asset-registry.ts`) replacing both
  hardcoded `CANONICAL_USDC_BY_CHAIN` maps and the settlement-asset config
  literals in `reward-campaign-config.ts`; fail-closed when the registry is
  unreachable.
- A single decimals-conversion module replacing the eight hardcoded
  USDC/6-decimals sites (exact integer scaling under the `usd_par` policy,
  `decimals >= 2`).
- Per-(user, asset) cashout balances, payout-effect asset snapshots,
  allocation confinement, and per-asset single-inflight.
- Per-asset solvency and vault-capacity observations and gating.
- `REWARDS_MULTI_ASSET_ENABLED` as the fail-closed master gate.

Hard prerequisites before any second asset is activated: the D4
funded-inventory refund product policy must be ratified, the refund
implementation landed, and the staging retirement/refund drill completed.
See the Core spec, sections 2 (D4) and 5.

Migration numbers referenced by the spec (0235–0239) are provisional and
must be recomputed immediately before each implementation PR.
