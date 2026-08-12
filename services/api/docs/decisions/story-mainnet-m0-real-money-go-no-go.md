# M0 decision: Story real-money go/no-go

Status: unresolved. Unresolved owner or unanswered control means **no-go**.

Related plan: `../story-mainnet-pricing-treasury-design.md`

## Decision requested

Authorize or reject a capped project to accept canonical Base-mainnet USDC from buyers and spend
platform-owned Story-mainnet IP/WIP for sold-video royalty settlement.

This is not approval to launch broadly. A `go` authorizes the gated engineering, provisioning, and
one separately approved floor-price canary described by M0-M8. Mainnet admission remains disabled
until every later gate passes.

## Options

### A. No-go

Keep buyer funding and Story settlement on testnets. Do not create real-money treasury, pricing,
refund, catalog, signer, or canary infrastructure beyond read-only market research.

- Financial exposure: none from this pipeline.
- Product consequence: sold videos remain simulated-money/testnet commerce.
- Reversibility: fully reversible through a later decision.

### B. Go, capped canary only — recommended if the business wants to validate real money

Authorize engineering and provisioning for one allowlisted community, buyer, newly registered
mainnet asset, and minimum approved USD price under a written maximum-loss/canary budget.

- Financial exposure: bounded by the approved treasury and canary caps.
- Product consequence: this is an operational proof, not general availability.
- Reversibility: disable new admission; already admitted plans and refunds must still reconcile.

### C. Go, broader launch

Not recommended as the first decision. It requires all canary evidence plus separately approved
catalog, geography, exposure, support, accounting, and expansion limits.

## Required accountable owners

Name one accountable owner for each row. One person may own multiple rows, but blank ownership is a
no-go.

| Control | Owner | Required decision/evidence |
| --- | --- | --- |
| Executive/product risk | Unassigned | Business objective, canary scope, launch authority |
| USDC/IP/WIP custody and treasury | Unassigned | Custody model, funding source, withdrawal authority, dual review |
| Tax and accounting | Unassigned | Buyer receipts, platform revenue, collaborator/parent royalty treatment |
| Legal/compliance | Unassigned | Applicable sanctions, identity, consumer, money-transmission, reporting obligations |
| Security/key custody | Unassigned | Contract-owner, checkout, refund, and coordinator signer custody/rotation |
| Incident response | Unassigned | 24/7 page owner, stop authority, recovery approval, maximum response time |
| Buyer support/refunds | Unassigned | Late funding, failed admission, delayed delivery, refund SLA and communications |

## Values that must be approved

- Maximum canary buyer charge in USD/USDC: **unresolved**
- Maximum native IP/WIP treasury funding: **unresolved**
- Maximum aggregate and daily exposure: **unresolved**
- Minimum reserve and operational-loss buffer: **unresolved**
- Allowed community, asset, buyer, and geography: **unresolved**
- Refund policy and maximum refund-review age: **unresolved**
- Required sanctions/identity screening subjects and timing: **unresolved**
- Incident owner and authority to disable admission: **unresolved**
- Authority to execute one floor-price real-money canary: **unresolved**

If screening is required, it is a versioned admission preflight before any IP spend, not a post-hoc
report. If buyer funding cannot admit, the approved durable refund/review path applies; retaining
funds silently or requesting a second payment is prohibited.

## Engineering consequences of go

A `go` authorizes work only in the plan's order:

1. measured IP/USD rate-source and executable USDC-to-IP replenishment evidence;
2. approved FX, slippage, margin, refund, reserve, and exposure policies;
3. finalized Base funding before admission/IP spend;
4. immutable pricing/admission snapshots and global treasury reservations;
5. persist-before-broadcast USDC refund coordinator;
6. staging-proven nonce repair and fee replacement;
7. mainnet contracts, exclusive signers, minter role, treasury, watchdogs, and alerts;
8. shadow pricing against testnet traffic;
9. explicitly authorized canary only after M1-M7 pass.

It does not authorize copying Aeneid prices/policies, moving keys outside the secret manager,
registering the catalog, accepting production USDC, or enabling mainnet admission early.

## Decision record

- Decision: **unresolved — no-go by default**
- Chosen option: A / B / C
- Accountable approver:
- Control owners completed: yes / no
- Approved values/evidence attachment:
- Decision date:
- Review/expiry date:
- Notes:

