# Story settlement nonce-repair drill evidence — 2026-07-18

Status: **completed on staging testnets; the nonce-repair half of M4 is proven**.

Environment: staging / Story Aeneid chain 1315 / Base Sepolia funding chain 84532.
This evidence does not authorize mainnet configuration or admission.

## Deployment and scope

The drill ran against API commit `19e40bb8dcc7c0b6587f678eff8fcf8f972a2e09`. Scoped admission was enabled
only for the selected staging community, then disabled before repair. After the drill, both temporary
admission secrets were deleted and verified absent. The repair-scoped operator credential was revoked.

The one-shot drill arm was created for a disposable community whose new video registration did not
become usable. The durable retarget action moved the still-unconsumed arm to an existing ready staging
video community without editing Durable Object storage:

- arm ref: `0x4e1b924efbc449680ca1a88c0ec8e26d534db5c98359571b0e68989d5926230d`;
- retarget journal ref: `0xf8aca25892dd819a074dae17961f1d57b4e6121058a12424e67c0f3c081ff501`;
- target community: `cmt_b3ede813fccf489982e93739ef1bf6b0`;
- locked video: `ast_3adfcce0f3a14b5793c395d0b6395616`;
- source song: `ast_24c96aa3774640a4b185e7c7cd5b647d`;
- listing: `lst_776dd9432a6d4f3e9dcce4fbcf849238`, priced at USD 0.01.

## Real admission and abandonment

A normal quote and settlement request used one exact Base Sepolia USDC receipt:

- quote: `qte_5adb2ca7c5644c349fdd199643237393`;
- purchase: `pur_qte_5adb2ca7c5644c349fdd199643237393`;
- funding transaction: `0xa0a8adf89d3966aecb3354ad367fdd0784608e9ddf2ad0653a987e1b51101127`;
- amount: 10,000 USDC atomic units (USD 0.01);
- coordinator plan: `0x2d50add9a070e9171fe13a11967d547953f0a68330504aadc6aa70ae9cddcf54`;
- abandoned step: `0x420207e8fb8f4a5d6b7363c1b125311a3a9ea27020a88394fc7d4671bc9be3c7`.

The normal coordinator flow atomically consumed the drill arm and reserved signer nonce 5. Before
repair, the plan was `abandoning` at version 4 and the first step was `failed_prebroadcast` at version
3 with nonce 5, no transaction hash, no signed bytes, zero broadcast attempts, and error
`staging_nonce_repair_drill_abandoned`. All later steps remained unsigned and unallocated.

Chain evidence before repair showed `eth_chainId=0x523`, latest nonce 5, and pending nonce 5. Thus the
reserved nonce was unused and no transaction occupied it. Admission was disabled before the repair
request.

## Repair result

The scoped repair request used expected step version 3, reason `terminal_configuration`, and durable
authorization ref `STAGING-NONCE-REPAIR-20260718`. The coordinator persisted, signed, and broadcast
the bounded zero-value self-transaction:

- transaction: `0x5a398967f7fe26ab0dfee64b39b2b009f1e6ab20abe877597d765e303bce2543`;
- block: 21027660;
- signer and destination: `0x22078E51C7dE79E8c8432bB8123D66975bd23FFF`;
- nonce: 5;
- value: 0;
- calldata: `0x`;
- receipt status: success;
- receipt and canonical block hash:
  `0xa70710b8a5e5855b169f831cc0bb0928a7b86c6779e53225d15c51892a8189f7`.

The receipt had 37 confirmations when captured. The final plan state was `abandoned` at version 8;
the business step remained `failed_prebroadcast` but its repair state was `confirmed` at step version
7. No business call was signed or broadcast.

## Exactly-once funding and business-effect proof

A read-only query of staging shard `community-d1-pool-0176-staging` found:

| Effect | Status | Rows | Attempts | Settlement ref | Coordinator state |
| --- | --- | ---: | ---: | --- | --- |
| `buyer_funding_receipt` | `confirmed` | 1 | 1 | present | n/a |
| `story_royalty_payment` | `submitted` | 1 | 1 | absent | `abandoned` |
| `story_parent_royalty_vault_transfer` | `submitted` | 1 | 1 | absent | `abandoned` |
| `story_entitlement_mint` | `submitted` | 1 | 1 | absent | `abandoned` |

All three Story effects reference the same plan. Their local `submitted` status represents the
coordinator-owned mirror row; the absent settlement refs and abandoned coordinator state prove no
royalty, parent transfer, or entitlement business transaction was emitted by this drill.

## Conclusion

The staging harness exercised real admission, real nonce allocation, deliberate unsigned
abandonment, the audited repair route, persist-before-broadcast signing, canonical receipt
reconciliation, and terminal repair confirmation without direct storage edits or wallet tooling.

This closes only the **abandoned-nonce-repair staging proof**. M4 remains open overall because the
same-nonce manual fee-replacement path is still design-only and has neither executable code nor a
staging-chain proof.
