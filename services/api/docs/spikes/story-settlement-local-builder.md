# Story settlement Gate A.2: local transaction builder

Date: 2026-07-16

Status: pure builder implemented and tested; not wired to signing or broadcast.

## Inventory

The builder pins the protocol targets used by Story SDK 1.4.4 for both Aeneid
(1315) and Story mainnet (1514):

- WIP: `0x1514000000000000000000000000000000000000`
- Royalty Module: `0xD2f60c40fEbccf6311f8B47c4f2Ec6b040400086`
- Royalty Policy LAP: `0xBe54FB168b3c982b7AaE60dB6CF75Bd8447b390E`

The local ABI surface is deliberately limited to `deposit`, ERC-20 `approve`,
`payRoyaltyOnBehalf`, LAP `transferToVault`, and Pirate
`mintEntitlement`. Selector fixtures pin those signatures in tests.

## Planning policy

The coordinator will supply an ordered WIP balance and Royalty Module allowance
snapshot. From that snapshot the pure builder emits:

1. a WIP deposit for the exact balance deficit, when needed;
2. an approval for the exact royalty amount, when the allowance is insufficient;
3. the royalty payment;
4. separately requested parent-vault transfers; and
5. a separately requested entitlement mint.

The exact deficit and exact allowance are intentional restrictions relative to
the SDK's sequential helper, which wraps the full fee amount and grants maximum
allowance. Once emitted into a plan, calls are immutable even if later external
funding changes the wallet balance.

## Evidence boundary

The royalty-payment calldata is compared with the SDK's safe encoded output.
The test transport permits only the SDK's read-only IP-registration check and
throws on every other RPC method. LAP transfer is never invoked through the SDK
because SDK 1.4.4 can broadcast despite `encodedTxDataOnly`; its ABI and selector
are pinned locally instead.

The production builder accepts no provider, wallet, signer, nonce, fee fields,
or private key. This PR does not change the existing settlement execution path.
Coordinator integration must add state reads, call-identity hashing, durable
signed-byte persistence, nonce ownership, simulation, and receipt reconciliation
before any local call can be signed or sent.

