# Reward identity parity: Self and ZKPassport

Status: proposed; design review required before implementation

## Question

How can a person verified with ZKPassport earn campaign rewards without the
same person earning twice by presenting one document through Self and another
proof through ZKPassport?

Today the durable reward identity is:

`hash(provider:mechanism:nullifier)`

Self and ZKPassport produce provider-local nullifiers. There is no common
cryptographic subject and the two nullifiers cannot be compared. Therefore a
system that accepts both providers in one campaign cannot prove that a Self
identity and a ZKPassport identity are different humans. This is a hard input
constraint, not a missing database join.

Existing claim and cap keys use `reward_identity_id`, including
`reward_song_period_claims` and `reward_campaign_reservations`. Merely allowing
ZKPassport in the resolver would create a second independent claim namespace.

## Option A: one provider per campaign

Add an immutable `reward_identity_provider` campaign term. A campaign accepts
exactly one of `self` or `zkpassport`; its qualification resolver, nationality
evidence resolver, claim key, and audit snapshot all use that provider.

Properties:

- A person cannot claim the same campaign through both providers because the
  campaign admits only one provider namespace.
- Both providers receive full product support, but not simultaneously inside
  one campaign.
- Provider choice is visible before funding and cannot change after funding.
- Historical decisions remain reproducible because the provider is part of the
  versioned campaign terms.
- A provider outage affects campaigns assigned to that provider. Creators and
  users are split across provider-specific campaigns.
- The same human may still participate in different campaigns through
  different providers. That is not a duplicate claim within one campaign.

This is the only evaluated option that closes the cross-provider duplicate
path without pretending the providers expose a shared human identifier.

## Option B: account-level provider election

The first accepted reward provider becomes the account's elected provider.
Ordinary verification through another provider does not change reward
eligibility. Switching requires an explicit migration that records the old and
new provider identities and prevents use of both during the migration window.

Properties:

- Prevents one Pirate account from alternating providers to claim twice.
- A safe switch must preserve prior claim/cap history. Replacing the derived
  `reward_identity_id` directly would allow a second claim, so implementation
  would need a stable reward subject or an alias set consulted by every claim,
  cap, reservation, payout, and reconciliation key.
- Account control is evidence that the same account requested the switch; it
  is not cryptographic evidence that the two provider nullifiers represent the
  same human.
- The same human can still use two Pirate accounts, one per provider. Because
  provider nullifiers cannot be cross-matched, the platform cannot detect that
  case.
- Migration and recovery become security-sensitive operational paths.

This is useful account hygiene but does not solve the stated cross-provider
human uniqueness problem.

## Option C: claim key on `user_id`

Keep provider verification for admission, but deduplicate campaign claims on
the Pirate account instead of `reward_identity_id`.

Properties:

- Simple and prevents two provider identities on one account from claiming the
  same campaign twice.
- Weakens the current Sybil boundary: account creation, not a provider
  nullifier, becomes the durable cap key.
- Provider-local nullifier uniqueness can still stop reuse inside one provider,
  but it cannot stop one person creating a Self-backed account and a
  ZKPassport-backed account.
- Re-keying existing reservations, claims, payout allocation, and audit logic
  would be broad and would make account merges/recovery money-sensitive.

This should not be used for paid rewards.

## Recommendation

Adopt option A for the first parity release: one immutable provider per funded
campaign. Support the full earn and nationality flow for both Self campaigns
and ZKPassport campaigns, but reject `either`/multi-provider campaign terms.

This is an honest safety boundary that can be enforced with existing
provider-local nullifiers and database uniqueness. It avoids a false promise
of cross-provider deduplication. If the providers later expose a reviewed common
subject—or users complete a proof that cryptographically links the two
identities—a stable cross-provider reward subject can replace this restriction
in a versioned campaign-terms migration.

## Required implementation invariants after approval

1. Provider is mandatory and immutable before campaign funding.
2. Qualification resolves only the campaign's provider; no fallback provider.
3. Nationality evidence must be bound to the same provider/nullifier used for
   the reward identity.
4. Claim, cap, reservation, payout-allocation, and reconciliation records keep
   the provider-derived `reward_identity_id` and campaign terms version.
5. Creator and participant disclosures name the selected passport-proof
   provider before funding or participation.
6. Tests prove that presenting the non-selected provider cannot create a
   qualification, reservation, reward event, or payout.
7. A future multi-provider mode remains invalid until a cryptographically
   linked common subject and migration plan are reviewed.
