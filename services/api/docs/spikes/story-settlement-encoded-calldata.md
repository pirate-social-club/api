# Story settlement Gate A: encoded calldata

Date: 2026-07-16

Status: SDK shortcut rejected; no transaction was signed or broadcast.

## Question

Can `@story-protocol/core-sdk` 1.4.4 expose the complete ordered transaction set for the current
Aeneid purchase settlement by using `txOptions.encodedTxDataOnly`, including conditional WIP wrap
and approval plus parent-vault transfer?

## Result

No. Static inspection of the exact SDK version pinned by the API establishes two merge-blocking
failures before an Aeneid fixture run is useful:

1. `royalty.payRoyaltyOnBehalf` computes and returns only
   `royaltyModule.payRoyaltyOnBehalf` calldata when `encodedTxDataOnly` is true. It returns before
   `contractCallWithFees`, which is the path that evaluates and executes conditional WIP wrapping
   and approval. The encoded response therefore cannot describe the complete subtransaction set
   used by the runtime configuration (`enableAutoWrapIp: true`, `enableAutoApprove: true`, sequential
   execution).
2. `royalty.transferToVault` accepts `txOptions` in its public type but the implementation does not
   branch on `encodedTxDataOnly`. It always simulates the policy call, invokes
   `wallet.writeContract`, and waits for a receipt. Calling it in a supposedly non-broadcast spike
   would violate the spike safety boundary.

The entitlement mint is already a direct contract call in Pirate code and can be encoded locally;
it does not repair the two SDK gaps above.

## Decision

Gate A rejects `encodedTxDataOnly` as the Fix 2 transaction builder. Do not run the proposed SDK
equivalence invocation with a funded signer: the parent-transfer method can broadcast.

Fix 2 remains feasible only through one of these reviewed paths:

- construct WIP deposit, exact allowance approval, royalty payment, policy `transferToVault`, and
  entitlement mint calls from pinned addresses and ABIs, then compare the non-prerequisite calldata
  against the SDK encoder and protocol ABIs; or
- adopt an upstream SDK API that returns every ordered unsigned subtransaction and proves that all
  methods honor the non-broadcast option.

The next spike revision should inventory the Aeneid contract addresses/ABIs and build local calldata
without a wallet. It must not call `transferToVault` through SDK 1.4.4.
