# ALTCHA Proof-of-Work Gates

ALTCHA gates add action-scoped proof-of-work for communities whose membership
gate policy contains an `altcha_pow` atom.

## Product Semantics

For membership joins, `altcha_pow` participates in the configured membership
policy expression. For example, a policy like `wallet_score >= 5 OR altcha_pow`
allows either a sufficient Passport wallet score or a solved ALTCHA proof to
join.

For contribution actions, the backend intentionally re-evaluates only the
`altcha_pow` gate when the community policy contains any `altcha_pow` atom.
That means a user who joined through wallet score still needs an action-scoped
proof for posts, comments, replies, and votes.

## Shipped Scopes

| Action | Scope | Binding |
| --- | --- | --- |
| Join community | `community_join` | `community:com_...` |
| Create post/thread | `post_create` | `community:com_...` |
| Create top-level comment | `comment_create` | `post:post_...` |
| Reply to comment | `comment_create` | `comment:cmt_...` |
| Vote on post | `post_vote` | `post:post_...` |
| Vote on comment | `comment_vote` | `comment:cmt_...` |

The challenge payload binds actor, scope, and action. Verification rejects
missing proofs, invalid payloads, expired challenges, binding mismatches, and
replays.

## Runtime Configuration

Required Worker secrets:

- `ALTCHA_HMAC_SECRET`
- `ALTCHA_HMAC_KEY_SECRET`

Optional global defaults:

- `ALTCHA_POW_COST`, default `5000`
- `ALTCHA_POW_COUNTER_MIN`, default `5000`
- `ALTCHA_POW_COUNTER_MAX`, default `10000`
- `ALTCHA_CHALLENGE_TTL_SECONDS`, default `1200`
- `ALTCHA_CHALLENGE_RATE_LIMIT`, default `10`
- `ALTCHA_CHALLENGE_RATE_LIMIT_WINDOW_SECONDS`, default `60`
- `COMMUNITY_GATE_POLICY_CACHE_TTL_MS`, default `60000`; set `0` to disable
  the in-process membership gate policy cache.

Optional per-scope overrides use the same suffixes:

- `ALTCHA_POW_COST_COMMUNITY_JOIN`
- `ALTCHA_POW_COST_POST_CREATE`
- `ALTCHA_POW_COST_COMMENT_CREATE`
- `ALTCHA_POW_COST_POST_VOTE`
- `ALTCHA_POW_COST_COMMENT_VOTE`

The same suffixes are supported for `ALTCHA_POW_COUNTER_MIN_*` and
`ALTCHA_POW_COUNTER_MAX_*`.

Current production starting costs:

| Scope | Cost |
| --- | ---: |
| `community_join` | `2000` |
| `post_create` | `8000` |
| `comment_create` | `5000` |
| `post_vote` | `2000` |
| `comment_vote` | `2000` |

## Operational Notes

`altcha_challenge_rate_limits` limits challenge issuance per actor and window.
`altcha_used_challenges` enforces one-use proofs and stores challenge hashes
until expiry. Expired rows are purged opportunistically by the challenge route.

The action gate policy cache only caches the community membership gate policy
inside a Worker isolate. Community gate updates invalidate the local entry after
the DB transaction commits. Other isolates observe updates after the short TTL.

## Verification

Focused checks:

```bash
rtk bun test services/api/tests/routes/communities/community-membership-gates-routes.test.ts
rtk bun test services/api/tests/routes/verification/verification-routes.test.ts
rtk bun test services/api/src/lib/communities/membership/gate-policy-store.test.ts
rtk bun run check
```

Production smoke should cover join, post, comment, reply, post vote, comment
vote, and replay rejection against a gated community.
