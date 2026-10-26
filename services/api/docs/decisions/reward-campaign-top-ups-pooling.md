# Decision: reward campaign top-ups and pool-based activation

Status: decided (2026-07-24). Implementation not yet scheduled.

This note records the agreed semantics for post-activation multi-funder top-ups
and pool-based activation of reward campaigns ("Boost"). It exists so the
implementing session does not have to reconstruct the design from chat history.
When the implementation lands, update the touched code comments and the rewards
runbooks to match.

## Product promise

Anyone can add money to a song's reward pool at any time, and the song pays
rewards whenever enough money is available. The plain-language rule:

> A campaign is earnable whenever the confirmed pool can cover at least one
> reward and the campaign window is open.

## Decisions

1. **No target-gated activation.** A song must never sit on real deposited
   money that nobody can earn. `budget_cents` demotes to a creation-time
   suggested amount / display default. It is not an activation requirement and
   there is no lifetime funding cap.
2. **Pool-threshold activation.** The activation threshold is the campaign's
   own per-reward amount (`reward_cents`). Example: $1 reward + one $5
   contribution → active immediately. Contributions smaller than one reward
   pool safely until the threshold is reached.
3. **Future `starts_at` still gates earning.** Funding may accumulate before
   the window opens; rewards begin only when both conditions hold: window open
   AND confirmed pool ≥ one reward.
4. **Rolling campaigns, no automatic 30-day end.** Campaigns alternate
   between two funding states with no fixed expiry:
   - `active`: pool covers at least one reward.
   - `pooling`: pool is below one reward (includes today's draft / funding_quoted
     / funding_confirming / exhausted states).
5. **Explicit close, honestly presented.** An explicit campaign close stops
   new qualifications. After the settlement tail, unused funds ultimately need
   per-contribution refunds. Until that exists:
   - closing and expiry must be presented in the UI as potentially locking
     unused funds;
   - top-ups must not be accepted near a fixed end without a clear warning.
   Do NOT silently ignore `ends_at` while funded — that would override campaign
   terms and could make campaigns run indefinitely. Rolling campaigns avoid the
   problem by not having a fixed end in the first place.
6. **`paused` and `operational_hold` remain independent safety states.** They
   are orthogonal to funding state and unchanged by this design.
7. **Immutable campaign terms.** Reward size and eligibility terms never
   change after creation. Top-ups change only the pool, not the terms. This
   also means the original creator has no control over when other people's
   contributed money becomes usable.
8. **No new restriction machinery.** No lifetime caps, no new anti-abuse
   limits. The existing per-quote min/max bounds
   (`REWARDS_CAMPAIGN_MIN_BUDGET_CENTS` / `REWARDS_CAMPAIGN_MAX_BUDGET_CENTS`)
   stay as-is (keeping them is zero work). The `budget − funded − pending`
   quote arithmetic and the `funding_campaign_budget_exceeded` refund path are
   removed for top-ups rather than extended.
9. **UI presentation.** Show "current reward pool" ("$5 available for
   rewards"), never "$5 of $10 required". An optional fundraising-goal
   presentation may be retained later only as an explicit, separate decision.

## State-transition table

Funding-state transitions (safety states `paused` / `operational_hold` overlay
independently and are not shown):

| From | To | Trigger |
| --- | --- | --- |
| (creation) | `pooling` | Campaign created with valid terms; accepts quotes immediately |
| `pooling` | `scheduled` | Confirmed pool ≥ `reward_cents` AND `starts_at` in the future |
| `pooling` | `active` | Confirmed pool ≥ `reward_cents` AND window open |
| `scheduled` | `active` | `starts_at` reached while pool ≥ `reward_cents` |
| `active` | `pooling` | Available pool drops below `reward_cents` through crediting (replaces today's `exhausted`) |
| `scheduled` | `pooling` | Should not occur (pool only decreases via crediting, which requires `active`); assert/log if seen |
| any non-terminal | `closed` | Explicit close: stops new quotes and new qualifications; settlement tail continues |
| any non-terminal | `canceled` | Operator cancellation (existing semantics) |

Legacy status mapping for the migration: `draft`, `funding_quoted`,
`funding_confirming`, and `exhausted` all map to `pooling`. `ended` requires a
data decision per campaign: either map to `closed`, or grandfather with their
fixed `ends_at` under decision 5's warning rules. No silent conversion of
`ended` campaigns into rolling ones.

## Concurrency invariants

- **Per-effect attribution.** Every contribution remains its own
  `reward_campaign_funding_effect` row with its own sender, quote, transaction
  hash, and refund state. The schema already models N effects per campaign
  (`reward_campaign_funding_effects`, migration 0134); top-ups extend, they do
  not redesign.
- **Atomic accumulation.** A confirmed effect increases `funded_cents` and the
  available pool in the same transaction that marks the effect confirmed
  (existing accumulation at `reward-campaign-service.ts:1012-1013`). Concurrent
  confirmations of different quotes must both land; neither blocks the other.
- **Single-consumption.** A transaction hash funds exactly one quote (unique
  index `reward_campaign_funding_effects_tx_unique`, migration 0134).
- **Idempotency.** Quote creation stays keyed on
  `(funder_user_id, idempotency_key)`.
- **No global funding lock.** One contributor's pending or completed payment
  never prevents another's quote or confirm. With no lifetime cap there is no
  remaining-budget window to race over; the only shared mutable counters are
  the campaign totals, updated transactionally.
- **Credit/debit safety.** Reward crediting continues to debit available pool
  (`credited_cents`) transactionally; the `active → pooling` transition is
  derived, never a separate writable flag that could drift from the counters.
- **Reactivation race.** A confirm that lifts the pool over threshold and a
  reconciler credit that drops it below threshold may interleave. The funding
  state must always be recomputed from counters after each mutation, never
  cached, so the result is one of the two serial orders — never a torn state.
- **One live campaign per song.** Unchanged
  (`reward_campaigns_one_live_per_song_post` partial unique index +
  `reward_song_slots`).

## Implementation touchpoints

- `services/api/src/lib/rewards/reward-campaign-service.ts`
  - `:654-657` — quote-creation status gate. Expand from
    `draft/funding_quoted/funding_confirming` to also accept `active` and
    today's `exhausted` (new `pooling`).
  - `:660-675` — remove the `budget − funded − pending` remaining-budget
    arithmetic for top-ups; keep per-quote min/max bounds.
  - `:1015-1027` — `funding_campaign_budget_exceeded` → `refund_pending` path
    becomes dead for top-ups; keep for legacy quotes only or remove.
  - `:1039-1047` — activation branch: replace `funded ≥ budget` with
    `pool ≥ reward_cents` (+ window check).
- `services/api/src/lib/rewards/reward-campaign-reconciler.ts:556-570` —
  replace the `exhausted` transition with the derived `active ↔ pooling`
  recompute; add reactivation when pool ≥ `reward_cents`.
- `services/api/src/lib/rewards/reward-campaign-lifecycle.ts` — remove the
  time-based `ended` transition for rolling campaigns; keep `scheduled →
  active` on window open.
- `services/api/src/lib/rewards/reward-campaign-capabilities.ts` and the
  public offer reads — expose `available_pool_cents`; drop funded-vs-budget
  presentation.
- Contract statuses: `services/contracts/src/index.ts:2844` — add `pooling` /
  `closed`, retire `exhausted` / `ended` per the mapping above; DB CHECK
  constraint migration (see migration 0137 for the current list) lives in the
  `core` repo.
- Quote TTL, late-acceptance grace, custody-mismatch refunds, tx
  single-consumption, and per-effect refund-to-sender: unchanged.

## Non-goals

- Per-contribution refunds of unused funds after close. Required eventually;
  explicitly not part of this slice. Decision 5's warnings exist because of
  this gap.
- Lifetime funding caps or new anti-abuse limit machinery.
- Changing campaign terms (reward size, eligibility) after creation.
- Any change to `paused` / `operational_hold` semantics.
- Scheduler work. The two open scheduler follow-ups — prelude phase starvation
  (`post_publish_finalize` never receives prelude budget) and tail-job
  starvation (`flush_analytics` et al. never start) — are tracked separately
  and must not be bundled into the top-up implementation.
- Fundraising-goal UI ("$5 of $10"). Optional later presentation only, by
  separate decision.
- Per-campaign identity providers, campaign-level demographic gates,
  non-USDC assets, milestone/streak rewards.
