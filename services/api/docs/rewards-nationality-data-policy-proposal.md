# Reward nationality data policy proposal

Status: owner-approved on 2026-08-03 for passport-nationality semantics and the
30/180-day retention defaults. Privacy/legal, compliance, security, disclosure,
implementation, and activation approvals remain open. This document does not
authorize collection. Nationality shadow evaluation remains paused through
`REWARDS_NATIONALITY_SHADOW_WRITES_ENABLED=false`.

## Decision record and remaining approvals

Reward qualification may read an accepted nationality attestation from the
canonical identity-verification store when evaluating a claim. The rewards
domain must not create a second copy of nationality or identity-document
provenance merely to preserve an evaluation snapshot.

The owner has approved items 1 and 4 below. Before collection can be enabled,
the remaining reviewers and implementation owners must complete:

1. the product meaning of nationality versus residence;
2. the sanctions and restricted-jurisdiction policy;
3. the user disclosure and lawful basis for using identity data for rewards;
4. the retention periods below; and
5. the roles allowed to retrieve decision records.

## Approved targeting semantics

Tiers select on passport nationality, not residence. Self and ZKPassport prove
nationality; neither currently proves where a person lives. A holder of a
United States passport living in Hanoi is therefore evaluated as United States
nationality. This is expected behavior, not an edge case.

Campaign creation and participant disclosure should say "by passport
nationality" rather than "by country." Residence-based targeting is out of
scope until an independently reviewed residence proof exists.

## Purpose limitation

Nationality data may be used by rewards only to:

- select a versioned campaign tier after the user has selected an eligible
  reward identity document;
- enforce that the evaluated identity is the identity bound to the claim; and
- investigate a concrete reward dispute or suspected identity-binding abuse.

It must not be used for advertising, public profiles, recommendations, general
analytics, or an unversioned eligibility rule. Shadow evaluation must remain
non-blocking and must not alter credits, reservations, claims, or payouts while
tier funding is disabled.

## Data minimization

The canonical source remains the identity-verification domain. A reward
evaluation may read the active binding, active identity nullifier, and accepted
attestation in one transaction, but a reward decision record must not persist:

- nationality;
- `identity_nullifier_id` or the nullifier hash;
- `user_attestation_id`;
- verification-session identifiers;
- document metadata; or
- a copy of the attestation payload.

The proposed reward decision record is limited to:

- reward qualification event and campaign identifiers;
- user identifier;
- a versioned tier or no-tier result;
- a coarse outcome code, including binding mismatch;
- evaluator and campaign-policy versions;
- evaluation timestamp; and
- the selected reward-identity binding identifier only if fraud review confirms
  that it is necessary to enforce the borrowed-document threat model.

The tier result must be sufficient to reproduce reward accounting without
persisting a separate nationality field. That does not make a tier result
non-sensitive: when a tier contains one country, or a small country set, the
tier code is itself a nationality assertion or a close proxy. Tier decisions
therefore inherit nationality-level handling, retention, access, and
small-cohort protections. Detailed provenance remains in the
identity-verification store under that domain's lifecycle and access policy.

## Owner-approved retention defaults

The owner approved these defaults on 2026-08-03. They are not active collection
policy until privacy/legal approves the lifecycle and the deletion controls are
implemented and verified:

| Record | Owner-approved default | Deletion rule |
| --- | --- | --- |
| Retryable/no-tier evaluation | 30 days | Delete after 30 days or immediately when superseded by a final evaluation. |
| Resolved tier decision | 180 days after campaign close | Delete the reward decision provenance; retain only required financial/accounting records without copying nationality or identity provenance. |
| Terminal binding-mismatch outcome | 180 days | Delete unless a documented abuse investigation places the record on a time-bounded legal/security hold. |
| Aggregate product metrics | Indefinite only when non-identifying | Minimum cohort-size controls must prevent nationality or user reconstruction. |

An approved policy must name the deletion job owner, its schedule, failure
alert, and a verification query. A row must never become indefinite merely
because deletion automation failed.

## Access and disclosure

- No nationality-derived reward decision is public or exposed to campaign
  creators.
- Users must receive a concise disclosure before nationality affects reward
  eligibility or amount.
- The disclosure must explain that tier-dependent payout amounts are public on
  the settlement chain. Anyone who correlates campaign terms, recipients, and
  payout amounts may permanently infer a recipient's nationality class. The
  database retention periods bound Pirate's decision-record exposure; they
  cannot erase or prevent inference from an immutable public transfer.
- Support may see the tier/outcome needed to answer a dispute, but not identity
  nullifiers, attestation payloads, or verification-session provenance.
- Raw identity evidence remains restricted to the existing identity/privacy
  access path.
- Internal aggregate reporting must suppress small cohorts and must not export
  row-level nationality-derived decisions.
- Government, litigation, and sanctions disclosures follow the approved legal
  request process; this feature creates no separate disclosure channel.

Access to decision records must be audited. Break-glass access requires a case
identifier, named approver, and expiry.

## User rights and deletion

The privacy request workflow must be able to locate reward decision records by
user identifier. Deleting eligible reward-decision provenance must not delete
immutable on-chain transfers or required accounting records. Those retained
records must not copy nationality or identity provenance, although public
tier-dependent transfer amounts may continue to support nationality-class
inference. Any legal or security hold must record its purpose, owner, scope,
and expiry.

## Activation checklist

Collection stays paused until all items are complete:

- [x] Owner/product approves passport-nationality semantics.
- [ ] Campaign UI uses "by passport nationality" rather than ambiguous
      country/residence copy.
- [ ] Compliance approves sanctions and restricted-jurisdiction behavior.
- [ ] Privacy/legal approves purpose, disclosure, lawful basis, retention, and
      user-rights handling.
- [x] Owner approves the 30/180-day retention defaults, subject to the remaining
      privacy/legal approval and implementation controls.
- [ ] Participant disclosure explicitly covers permanent on-chain inference
      from tier-dependent payout amounts.
- [ ] Security approves the minimum binding-mismatch fields and access roles.
- [ ] The schema is changed so rewards do not duplicate nationality or raw
      identity provenance.
- [ ] Automated deletion and failure alerting are implemented and tested.
- [ ] ZKPassport reward-identity eligibility is either implemented or the
      Self-only limitation is explicitly disclosed.
- [ ] Tier funding remains blocked through a separate reviewed control until
      real-money policy and accounting tests pass.
- [ ] Re-enablement is a reviewed production configuration change with a
      pre/post aggregate inventory and rollback plan.

## Current inventory

As recorded on 2026-08-02, `reward_claim_identity_evidence` contained zero rows.
There is therefore no shadow dataset requiring a retrospective retention or
deletion decision. The two existing Self nationality attestations belong to the
identity-verification domain and are outside this proposed reward-decision
lifecycle.
