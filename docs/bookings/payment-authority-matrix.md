# Booking payment authority matrix

This document is the durable inventory of every booking-payment state, reader,
executor, and terminal proof. The database state machine and the chain receipt
classifier form one authority boundary; neither may collapse custody evidence
into a readerless terminal state.

## Invariants

1. Every classifier result proving operator custody leads to either a consumed
   booking or a durable executable refund obligation.
2. The immutable quote remains the only authority for booking price,
   recipient, token, chain, fees, and host payout.
3. Observed custody amount and sender are evidence for a refund only. They
   never replace or amend the quote.
4. `refunded` is the sole terminal payment-intent state for funds that arrived
   and were returned. `expired` means unpaid expiry only.
5. A claimed transaction hash has one payment-intent owner.
6. Only the existing booking coordinator may move booking custody funds.

## Receipt → authority matrix

| Chain receipt | Classifier result | Booking transition | Durable evidence | Booker reader | Reverification reader | Operator reader | Money executor | Terminal proof |
| --- | --- | --- | --- | --- | --- | --- | --- | --- |
| Missing, pending, or transient RPC failure | `pending` | `verifying → verification_failed` | Claimed hash and wallet attachment remain | `confirmable` | Yes | Yes | None until verified | Later classifier result |
| Exactly one matching transfer for the immutable amount | `verified` | `verifying → verified` | Hash, verified sender, verified timestamp | `finalizable` | Finalizer worklist | Yes | Booking finalizer | `consumed` plus booking id |
| Exact transfer; booking finalization succeeds | Already `verified` | `verified → consumed` | Booking funding reference and consumed timestamp | `booked` | No | History | Later lifecycle settlement | Booking row plus consumed intent |
| Exact transfer; hold/slot can no longer finalize | Already `verified` | Remains `verified` until refund | Verified sender/hash; unconsumed | `refund_pending` | No | Yes | Exact-payment orphan refund lane | `refunded` plus outbound tx proof |
| One or more expected-sender transfers with nonzero aggregate different from quote | `custody_mismatch(wrong_transfer_amount)` | `verifying → custody_refund_pending`; release hold/slot | Claimed hash, wallet attachment, observed sender, exact atomic amount, reason, detected timestamp | `refund_pending` | No | Yes | Custody-refund worklist through booking coordinator | `refunded` plus outbound tx proof |
| One unexpected sender transfers the expected token into operator custody | `custody_mismatch(unexpected_sender)` | `verifying → custody_refund_pending`; release hold/slot | Same single-sender custody evidence | `refund_pending` | No | Yes | Custody-refund worklist through booking coordinator | Full observed amount returned |
| Multiple positive-balance senders transfer the expected token into operator custody | `custody_incident(multiple_senders)` | `verifying → custody_operator_incident`; release hold/slot | Claimed hash, wallet attachment, deterministic per-sender amount/count inventory, detected timestamp | Excluded | No | Yes | None; operator incident only | Manual evidence-preserving resolution |
| Wrong token, recipient, or chain with no expected-token transfer into expected operator custody | `rejected` | `verifying → verification_rejected` | Claimed hash; rejection classification | Excluded/terminal error | No | History/incident only | None | No operator custody proved |
| Custody refund receipt not final, absent, or reorged during executor check | `pending` at refund recheck | Remains `custody_refund_pending` | Original evidence plus bounded attempt/error metadata | `refund_pending` | No | Yes | Same custody executor retries | Later final receipt or operator incident |
| Custody refund coordinator retryable/pending | Coordinator non-terminal | Remains `custody_refund_pending` | Durable settlement effect and attempt metadata | `refund_pending` | No | Yes | Same coordinator idempotency key | Later confirmed coordinator proof |
| Custody refund confirmed | Successful outbound proof | `custody_refund_pending → refunded` | Refund tx ref and refunded timestamp | History | No | History | None | Confirmed outbound receipt |
| Custody refund terminal/manual incident | Failed/replaced/conflicting evidence | Remains `custody_refund_pending` | Error/evidence preserved; never overwritten | `refund_pending` | No | Yes, alertable | Operator resolution using same coordinator authority | Confirmed refund or explicit unresolved incident |
| Replay of any custody-bearing result | Same normalized hash | Idempotent same-intent result; cross-intent claim loses | Original evidence is immutable | Same resume state | No duplicate work | One obligation | One idempotency key | Original booking/refund proof |

Overpayment and underpayment have identical policy: return the full observed
atomic amount, form no booking, grant no partial credit, and accept no
cross-transaction top-up.

## Database state × reader grid

| Intent state | Claim/evidence shape | Client pending reader | Server recovery/finalizer | Operator unresolved reader | Settlement/refund worklist | Terminal? |
| --- | --- | --- | --- | --- | --- | --- |
| `active` | No claim | `payable` while hold is live | No | No | No | No |
| `verifying` with live lease | Claimed hash + attachment + live claim | `confirmable` | Lease owner only | Yes | No | No |
| `verifying` with expired lease | Claimed hash + attachment | `confirmable` | Reverification worklist; reclaimable CAS | Yes | No | No |
| `verification_failed` with claim | Claimed hash + attachment | `confirmable` | Reverification worklist | Yes | No | No |
| `verification_rejected` | No operator custody proved | Excluded | No | History/incident | No | Yes |
| `verified`, unconsumed, live finalization opportunity | Verified sender/hash | `finalizable` | Finalizer worklist | Yes | Not yet | No |
| `verified`, unconsumed, expired/conflicted hold | Verified sender/hash | `refund_pending` | No | Yes | Exact-payment orphan refund | No |
| `custody_refund_pending` | Observed atomic amount/sender/reason/hash | `refund_pending` | No | Yes | Custody-refund executor only | No |
| `custody_operator_incident` | Multi-sender per-transfer inventory/hash | Excluded | No | Yes | None; never automatically refunded | No; operator-owned incident |
| `consumed` | Booking id and consumed proof | `booked` during recent window | No | History | Booking lifecycle only | Yes for intake |
| `refunded` | Confirmed outbound tx proof | History | No | History | No | Yes |
| `expired` | Unpaid intent only; written when an unclaimed/reclaimable payment intent and its hold lapse with no custody evidence | Excluded | No | No | No | Yes; deliberately readerless |

No non-terminal claimed state may be visible only to the client. Every such
state must have a server-owned reader so recovery does not depend on the user
returning.

## Crash windows

| Crash boundary | Durable state after crash | Recovery owner |
| --- | --- | --- |
| After broadcast report, before first verification | Claimed `verifying` or `verification_failed` | Reverification sweeper |
| During RPC with active claim | `verifying` with live lease | Current worker; sweeper after lease expiry |
| After custody classification, before CAS | `verifying`; classifier result not yet durable | Same request or later reclassification of claimed hash |
| After custody CAS, before response | `custody_refund_pending` with full evidence | Booker/operator readers and custody executor |
| After multi-sender incident CAS, before response | `custody_operator_incident` with full sender inventory | Operator unresolved reader |
| After exact verification, before booking consume | `verified` | Finalizer/reverification worker |
| After refund-effect reservation, before broadcast | Pending intent plus durable submitted effect | Booking coordinator reconciliation |
| After refund broadcast, before response | Pending intent plus coordinator/ledger tx proof | Same idempotency key reconciliation |
| After confirmed outbound receipt, before intent transition | Confirmed durable effect; intent still pending | Executor replay marks `refunded` |

## Reader ownership rule

Queries are part of the state machine. Whenever a state, lease rule, or
classifier kind changes, update and test these readers together:

- booker pending-intent discovery;
- server re-verification/finalization worklist;
- operator unresolved-payment listing;
- exact-payment orphan refund query;
- custody-refund worklist;
- terminal/history views.

A state selected by no reader is a strand candidate. A non-terminal state
selected only by the booker reader violates server-discoverable recovery.

## Boundary field-fidelity matrix

State coherence is insufficient if evidence is dropped while crossing a
classifier, repository, ledger, or signer boundary.

| Field | Producer → durable owner → consumer | Failure if dropped | Enforced by |
| --- | --- | --- | --- |
| `claimed_tx_ref` | Broadcast/confirm → payment intent → verifier and refund executor | Payment in custody becomes undiscoverable | Unique index plus intent shape checks |
| `consumed_wallet_attachment_id` | Broadcast report → payment intent → address resolver | Server cannot reconstruct buyer authority after request loss | Claimed/reclaimable shape checks |
| `custody_observed_amount_atomic` | Classifier → payment intent → custody refund effect | Wrong refund amount or undischargeable obligation | Custody-pending shape check |
| `custody_sender_address` | Classifier → payment intent → receipt recheck and refund recipient | Funds can be sent to the wrong party | Custody-pending shape check and executor equality check |
| `custody_evidence_json` | Multi-sender classifier inventory → incident row → operator | Ambiguous custody becomes readerless or falsely auto-refunded | JSON shape check requiring multiple transfers |
| `amount_atomic` | Refund obligation → settlement effect → signing coordinator | Atomic custody refund is reconstructed as zero/cents | `bookings_settlement_effects_amount_shape_check` XOR |
| `amount_cents` | Lifecycle settlement decision → settlement effect → signing coordinator | Ordinary payout/refund cannot be signed | Same XOR shape check |
| `refund_tx_ref` | Signing coordinator → intent → history/idempotent replay | Completed refund appears pending or can be repeated | Unique index plus refunded-state shape check |
| `recipient_address` | Immutable quote/custody sender → settlement effect → signer | Valid proof is sent to a different address | Snapshot immutability and coordinator request |
| `verified_sender_address` | Classifier → payment intent → booking finalizer | A different wallet can consume another booker's transfer | Finalizer replay/address equality checks |

The booking-refund signer intentionally falls through to `amount_cents` when
`amount_atomic` is null because booking refunds have both lifecycle-cents and
custody-atomic forms. That is safe only while Core's
`bookings_settlement_effects_amount_shape_check` makes a row with neither
amount unwritable.
