# Story settlement coordinator policy v1

Status: approved configuration baseline; admission remains disabled.

## Aeneid

The deployed development, staging, staging-d1, and production API environments
currently target Story Aeneid (chain 1315). Their initial coordinator policy is:

| Setting | Value |
| --- | --- |
| Fee policy version | `aeneid-coordinator-fee-v1` |
| Finality policy version | `aeneid-safe-finality-v1` |
| Maximum fee | `1,000,000,000` wei (1 gwei) |
| Maximum priority fee | `500,000,000` wei (0.5 gwei) |
| Gas limit cap | `1,500,000` |
| Estimate buffer | `12,000` bps plus the shared 15,000-gas padding |
| Prefer safe block | `true` |
| Fallback confirmations | `20` |

Evidence collected read-only from the official Aeneid RPC on 2026-07-16:

- `eth_feeHistory` over the latest 1,024 blocks reported a constant 7-wei
  base fee. The nonzero p50, p95, p99, and maximum sampled priority reward were
  all 0.1 gwei. The selected priority cap is 5x that sampled maximum.
- `safe`, `finalized`, and `latest` resolved to the same block during the
  observation. The safe tag is therefore supported and is authoritative.
- The 20-block fallback is used only when an RPC does not support the safe tag.
  At the sampled 1.91 seconds per block it represents roughly 38 seconds.

The cap intentionally rejects or stalls work during a larger fee spike instead
of granting the coordinator an unbounded treasury spend. Broadcast-age alerts
and the manual replacement runbook are the mitigation.

## Mainnet

No deployed API environment currently targets Story mainnet (chain 1514), so
mainnet values are not present in Wrangler configuration and must not be copied
from Aeneid automatically.

The same read-only sample found a 23-wei p50 base fee, 24-wei p95/max base fee,
approximately 5-gwei p50/p95 nonzero priority reward, approximately 6-gwei p99,
and a 205-gwei isolated maximum. The official mainnet RPC supported `safe` with
zero observed lag. Before a mainnet rollout, repeat the sample over a longer
window and review a separately versioned cap; a reasonable review starting
point is 15-gwei maximum fee and 12-gwei maximum priority fee, not an approved
production value.

## Rotation rule

Policy versions are immutable plan inputs. Never change a configured version
while any plan for the signer is nonterminal. First disable new admission,
drain or manually disposition every plan, verify the coordinator backlog is
zero, then deploy the new values and version together. Changing only values
under an existing version is prohibited.

