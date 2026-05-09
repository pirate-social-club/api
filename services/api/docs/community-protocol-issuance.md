# Community Handle Protocol Issuance Spec

Status: implementation reference
Date: 2026-05-09

## Purpose

Community handle claims already support app-internal paid names. This spec defines the next layer: optional protocol-level issuance of Spaces subnames through `spacesprotocol/subs`.

The product boundary is:

- The Pirate app handle becomes active immediately after a successful paid claim.
- Protocol issuance is asynchronous and visible as `issuing`, `issued`, or `failed`.
- Pirate operates the parent Space and issuance pipeline.
- RunPod Queue Serverless is used only as disposable RISC Zero proof compute.
- Pirate remains the source of truth for issuance workflow state, proofs, Bitcoin commits, and certificate publishing.

## Current Codebase Context

Relevant areas:

- `services/api/src/lib/communities/handles/handle-claim-service.ts`
  - Quote, paid claim, admin reserve/list/revoke, handle policy.
- `services/api/src/routes/communities-handles-routes.ts`
  - Community handle API routes.
- `services/api/test-fixtures/db/community-template/migrations/1066_community_handle_claims.sql`
  - Existing app-internal handle and quote tables.
- `services/community-provision-operator/src/generated/community-migrations.ts`
  - Generated community DB migration manifest used by the provision operator.
- `services/contracts/src/index.ts`
  - Shared API contract types.
- `core/db/community-template/migrations/`
  - Canonical community-template migrations mirrored by API tests/operator.

Important implementation precondition:

The API baseline must be clean before landing worker or migration changes. At the time of the first audit this repo had conflicted files; those must remain resolved before continuing beyond the durable-state/claim-path milestone.

Original implementation boundary:

- Existing code creates app-internal community handles only.
- Existing claim code does not create protocol issuance rows.
- The tables in this spec did not exist before this milestone.
- The durable-state and claim-path pieces are the first implementation milestone; later worker/prover behavior remains to-be-implemented unless explicitly described as a Phase 0 finding.

## External Protocol Findings

Phase 0 test-rig against `spacesprotocol/subs` confirmed:

- `subsd` can operate a delegated parent Space.
- Handles are staged via `POST /requests`.
- Multiple handles commit into one Merkle root.
- Initial root commit skips proving.
- Later commits require a RISC Zero proof before Bitcoin broadcast.
- Certificates are issued per handle after Bitcoin finality and published through Fabric.
- Duplicate staging is handle-first:
  - Same handle and same script pubkey: `AlreadyStaged`.
  - Same handle and different script pubkey: `AlreadyStagedDifferentSpk`.
- CPU proving on a 16 GB workstation was OOM-killed during `subs-prover` calibration. Production should use a dedicated prover backend, likely GPU-enabled.

Key `subsd` endpoints:

```text
POST /spaces/:space/operate
POST /requests                         body: { requests: [{ handle, script_pubkey }] }
POST /spaces/:space/commit             body: { dry_run?: boolean }, response includes prev_root/root/is_initial
GET  /spaces/:space/proving/next
POST /spaces/:space/proving/fulfill
POST /spaces/:space/broadcast          body: { fee_rate?: number }, response: { txid }
GET  /spaces/:space/commit/status      finalized only when status = "finalized"
GET  /certs/:handle                    response: { root_cert, handle_cert }
POST /spaces/:space/publish            body: { handles: [sub_label] }, response includes handles_published/remaining
GET  /spaces/:space/pipeline
```

## Architecture

```text
Paid claim
  -> app handle active immediately
  -> protocol issuance row created when policy requires Spaces subspace issuance
  -> user sees protocol status: issuing

Issuer service
  -> stages pending handles in subsd
  -> groups by parent_space
  -> creates batch
  -> commits batch in subsd
  -> sends proof job(s) to RunPod if proof is required
  -> fulfills each proof into subsd until /proving/next returns none
  -> broadcasts Bitcoin transaction
  -> waits for finality
  -> publishes certs to Fabric
  -> marks linked issuance rows issued
```

Core distinction:

```text
Proof jobs = batch-scoped
Protocol issuance = handle-scoped
```

A batch may contain many handles. It has one Merkle update, one or more proof jobs when needed, one Bitcoin commit, and one finality/publish lifecycle. The issuer must not broadcast after the first proof result; it keeps asking `subsd /proving/next` after each successful fulfill and only advances to `proving_complete` when `subsd` returns `Option::None`.

`protocol_issuance_batches.proof_receipt_ref` stores the latest receipt ref, and after completion it is the final receipt ref. It is not a complete proof receipt history. Earlier proof inputs/receipts remain in the configured artifact store for audit, and `proof_jobs_submitted` is the durable circuit-breaker counter for the batch.

## Public Status Model

Expose only:

```text
issuing
issued
failed
```

Do not expose internal checkpoints to normal users.

Suggested user copy:

```text
Your Pirate handle is active now.
Protocol issuance is queued. Your certificate will be issued through the next protocol batch.
```

## Internal Batch Checkpoints

These are for the worker, support, retries, and audit logs:

```text
pending_stage
staged
batched
committed
proving_submitted
proving_complete
broadcast
confirming
published
failed
```

Checkpoint ownership:

- Batch owns `worker_checkpoint`.
- Handle-level issuance rows own only public status plus certificate/error fields.
- Avoid handle-level copies of proof/BTC/finality checkpoints because all handles in a batch share those states.

## Data Model

Migration file:

```text
services/api/test-fixtures/db/community-template/migrations/1072_community_handle_protocol_issuance.sql
core/db/community-template/migrations/1072_community_handle_protocol_issuance.sql
```

The migration must also be added to:

```text
services/community-provision-operator/src/generated/community-migrations.ts
```

V1 placement decision:

- These tables live in the community DB for the first implementation.
- The issuer worker is scoped to one community DB per run/job in v1.
- This avoids adding a new platform-level registry before the protocol path works.
- Scaling to one worker that globally scans all communities should add a platform/control-plane registry later.

### `protocol_issuance_batches`

Community DB table.

```sql
CREATE TABLE protocol_issuance_batches (
  protocol_issuance_batch_id TEXT PRIMARY KEY,
  community_id TEXT NOT NULL,
  namespace_id TEXT NOT NULL,
  parent_space TEXT NOT NULL,

  status TEXT NOT NULL CHECK (status IN ('open', 'processing', 'published', 'failed')),
  worker_checkpoint TEXT NOT NULL CHECK (
    worker_checkpoint IN (
      'pending_stage',
      'staged',
      'batched',
      'committed',
      'proving_submitted',
      'proving_complete',
      'broadcast',
      'confirming',
      'published',
      'failed'
    )
  ),

  subsd_root_before TEXT,
  subsd_root_after TEXT,

  proof_required INTEGER NOT NULL DEFAULT 0 CHECK (proof_required IN (0, 1)),
  runpod_job_id TEXT,
  runpod_status TEXT,
  proof_input_ref TEXT,
  proof_receipt_ref TEXT,
  proof_jobs_submitted INTEGER NOT NULL DEFAULT 0 CHECK (proof_jobs_submitted >= 0),

  bitcoin_txid TEXT,
  bitcoin_commit_ref TEXT,
  fabric_submission_ref TEXT,

  error_code TEXT,
  error_message TEXT,
  created_at TEXT NOT NULL,
  updated_at TEXT NOT NULL,
  committed_at TEXT,
  proving_submitted_at TEXT,
  proving_completed_at TEXT,
  broadcast_at TEXT,
  published_at TEXT,

  FOREIGN KEY (community_id) REFERENCES communities(community_id),
  FOREIGN KEY (namespace_id) REFERENCES namespace_bindings(namespace_id)
);
```

Indexes:

```sql
CREATE INDEX idx_protocol_issuance_batches_parent_checkpoint
  ON protocol_issuance_batches(parent_space, worker_checkpoint, created_at);

CREATE INDEX idx_protocol_issuance_batches_status
  ON protocol_issuance_batches(status, updated_at);

CREATE UNIQUE INDEX idx_protocol_issuance_batches_runpod_job
  ON protocol_issuance_batches(runpod_job_id)
  WHERE runpod_job_id IS NOT NULL;

CREATE UNIQUE INDEX idx_protocol_issuance_batches_bitcoin_tx
  ON protocol_issuance_batches(bitcoin_txid)
  WHERE bitcoin_txid IS NOT NULL;
```

Notes:

- `proof_required` uses SQLite integer boolean style to match existing community DB conventions.
- On retry, if `subsd_root_before` or `subsd_root_after` is already stored, the worker must compare the value returned by `subsd` against the stored value. A mismatch is a hard failure requiring operator review.
- `fabric_submission_ref` is an opaque reference to the Fabric publish/submission artifact captured by the issuer. If it becomes a transaction/content identifier rather than a storage pointer, rename it before implementation.

### `community_handle_protocol_issuances`

Community DB table.

```sql
CREATE TABLE community_handle_protocol_issuances (
  community_handle_protocol_issuance_id TEXT PRIMARY KEY,
  community_handle_id TEXT NOT NULL,
  protocol_issuance_batch_id TEXT,
  community_id TEXT NOT NULL,
  namespace_id TEXT NOT NULL,

  public_status TEXT NOT NULL CHECK (public_status IN ('issuing', 'issued', 'failed')),

  parent_space TEXT NOT NULL,
  sname TEXT NOT NULL,
  script_pubkey_hex TEXT NOT NULL,

  cert_ref TEXT,
  certificate_payload_ref TEXT,

  error_code TEXT,
  error_message TEXT,
  created_at TEXT NOT NULL,
  updated_at TEXT NOT NULL,
  issued_at TEXT,

  FOREIGN KEY (community_handle_id) REFERENCES community_handles(community_handle_id) ON DELETE CASCADE,
  FOREIGN KEY (protocol_issuance_batch_id) REFERENCES protocol_issuance_batches(protocol_issuance_batch_id),
  FOREIGN KEY (community_id) REFERENCES communities(community_id),
  FOREIGN KEY (namespace_id) REFERENCES namespace_bindings(namespace_id)
);
```

Indexes:

```sql
CREATE UNIQUE INDEX idx_protocol_issuances_handle_once
  ON community_handle_protocol_issuances(community_handle_id);

CREATE UNIQUE INDEX idx_protocol_issuances_sname_active
  ON community_handle_protocol_issuances(parent_space, sname)
  WHERE public_status IN ('issuing', 'issued');

CREATE INDEX idx_protocol_issuances_pending_parent
  ON community_handle_protocol_issuances(parent_space, public_status, created_at)
  WHERE protocol_issuance_batch_id IS NULL;

CREATE INDEX idx_protocol_issuances_batch
  ON community_handle_protocol_issuances(protocol_issuance_batch_id);
```

Handle deletion/revocation policy:

- Normal admin revoke changes `community_handles.status`; it does not delete the handle row.
- The protocol issuance row remains attached for audit when a handle is revoked.
- If a handle row is hard-deleted by maintenance tooling, the protocol issuance row cascades with it.
- Issued protocol subspaces cannot be revoked on-chain by changing Pirate app state. Admin revoke only affects Pirate app participation/display.

Script pubkey reuse:

- V1 allows the same `script_pubkey_hex` to own multiple SNames.
- `subs` accepts a handle plus arbitrary script pubkey; uniqueness is by SName, not by owner script.
- Add no uniqueness guard on `script_pubkey_hex`.
- Revisit only if Spaces tooling or product policy later requires one address per subspace.

## Policy Setting

Extend `CommunityHandlePolicySettings` with:

```ts
issuance_mode?: "app_internal" | "spaces_subspace" | null
```

Default:

```text
app_internal
```

Only `spaces_subspace` creates protocol issuance rows.

Sanitization rules:

- Unknown settings must be stripped.
- V1 should reject invalid `issuance_mode` on admin updates rather than silently falling back.
- Existing policy reads without `issuance_mode` remain app-internal.
- Existing policies without this setting remain app-internal.

V1 configurability:

- `issuance_mode` should be platform-controlled for launch, not exposed as a normal community-admin toggle.
- The public/admin policy response may show the mode for support clarity.
- Enabling `spaces_subspace` should require platform operator action because it creates irreversible protocol commitments and external proof/BTC/Fabric obligations.

## Wallet Requirements

Protocol issuance requires two distinct wallet roles:

```text
settlement_wallet_attachment
  EVM wallet used for USDC payment.

protocol_owner_wallet_attachment
  Bitcoin Taproot wallet used as the owner script pubkey for the subspace.
```

Validation:

- Attachment exists.
- Attachment belongs to the claiming user.
- Attachment is active.
- Chain namespace is Bitcoin/BIP122.
- Address derives to P2TR.
- Derived `script_pubkey_hex` is stored on the issuance row.

The private key must never touch Pirate infrastructure.

## Claim Path Integration

File:

```text
services/api/src/lib/communities/handles/handle-claim-service.ts
```

Target behavior:

1. Existing quote/payment/claim behavior remains unchanged for app-internal names.
2. If `settings.issuance_mode === "spaces_subspace"`:
   - Quote should signal that protocol issuance requires a Bitcoin Taproot wallet.
   - Claim must require `protocol_owner_wallet_attachment`.
   - Paid claim still verifies USDC before writing the active handle.
   - The app handle is inserted as `active`.
   - A protocol issuance row is inserted in the same write transaction.
3. If the protocol issuance row insert fails, the claim transaction should fail. Do not create an active app handle without the matching issuance row when the policy requires protocol issuance.

Milestone 2 claim-path target:

- `claimCommunityHandle` must insert into `community_handles`, insert the matching `community_handle_protocol_issuances` row when protocol issuance is required, and update `community_handle_claim_quotes` in the same write transaction.
- App-internal claims must continue to skip protocol issuance rows.

SName construction:

```text
label_normalized + "@" + normalized_parent_space_without_leading_at
```

Examples:

```text
icepilot@xn--e77h6a
alice@pesto
```

Parent space storage should preserve the canonical Spaces label with leading `@` where operationally needed:

```text
parent_space = "@xn--e77h6a"
sname = "icepilot@xn--e77h6a"
```

Definitive parent-space rule:

- Spaces route labels are identified by `namespace_bindings.route_family = 'spaces'` when present, or by `display_label`/`normalized_label` starting with `@`.
- HNS/bare namespaces must not be eligible for `spaces_subspace` issuance.
- The claim path and issuer construct `parent_space` by stripping any existing leading `@` from the stored namespace label and then prepending one canonical `@`.
- The SName must omit the leading `@` after the separator, for example `icepilot@xn--e77h6a`.
- `subsd` space routes and operate calls should use the leading-`@` parent space.

## API Surface

### `/handles/me`

Extend response when a protocol issuance row exists:

```ts
protocol_issuance?: {
  status: "issuing" | "issued" | "failed"
  sname: string
  parent_space: string
  issued_at?: number | null
}
```

### Admin list

Admin handle list should include protocol issuance summary:

```ts
protocol_issuance?: {
  status: "issuing" | "issued" | "failed"
  batch?: string | null
  sname: string
  parent_space: string
  checkpoint?: string | null
  error_code?: string | null
  error_message?: string | null
}
```

Admin API exposure rule:

- Normal user APIs expose only public protocol status and Unix-second timestamps.
- Community admin list may expose protocol status and batch reference.
- Internal checkpoints, error codes/messages, RunPod job ids, proof refs, and Bitcoin refs should be behind explicit support/admin inspection endpoints, not default user-facing responses.

### Future admin endpoints

These can be added after the issuer worker exists:

```text
GET  /communities/:id/handle-issuance/batches
GET  /communities/:id/handle-issuance/batches/:batchId
POST /communities/:id/handle-issuance/batches/:batchId/retry
POST /communities/:id/handle-issuance/force-batch
```

## Issuer Worker

Suggested package:

```text
services/community-protocol-issuer/
```

Core modules:

```text
src/lib/protocol-issuance-db.ts
src/lib/subsd-client.ts
src/lib/runpod-proof-client.ts

services/community-protocol-prover-runpod/
  handler.py
  proof_worker.py
  Dockerfile
  README.md
src/lib/proof-artifact-store.ts
src/lib/issuer-workflow.ts
```

Current foundation:

- `services/community-protocol-issuer/src/lib/issuer-workflow.ts` owns the first resumable workflow slice.
- `services/community-protocol-issuer/src/lib/protocol-issuance-db.ts` adapts the community DB tables through a small SQL client port.
- `services/community-protocol-issuer/src/lib/subsd-client.ts` contains the HTTP client boundary and normalizes `AlreadyStaged` / `AlreadyCommitted` idempotency outcomes.
- `subsd-client.ts` is aligned to upstream `spacesprotocol/subs` route shapes: `/requests` takes a `requests` array, local commit derives proof requirement from `prev_root`, commit status requires `status = "finalized"`, and publish sends sub-label names rather than certificate payloads.
- `services/community-protocol-subsd` packages a persistent pinned `subsd` image. This is the staging/prod path for protocol-local state; it must run with a durable data directory and private network exposure only.
- Stage requests omit `dev_private_key`; upstream defines it as optional and test-only.
- This foundation stages unbatched handle issuance rows, creates batches by parent Space, commits batches when thresholds are met, records proof-required batches, and marks only the conflicting handle failed on hard script-pubkey conflicts.
- Batch creation and issuance attachment are one store operation so the worker cannot leave an empty batch between two writes.
- Ready-to-commit reads reject empty and oversized batches.
- Proofless batches can now broadcast, move to `confirming`, poll commit finality, fetch certificates, publish certificates, and mark linked issuance rows `issued`.
- A live `subsd --test-rig` smoke on `@test9998` verified the one-shot issuer against real upstream HTTP routes:
  - run 1: DB issuance row -> `POST /requests` -> local commit -> Bitcoin broadcast.
  - mine 151 regtest blocks.
  - run 2: finalized status -> `GET /certs/:handle` -> `POST /publish` -> issuance `issued`, batch `published`.
- Broadcast failures after a successful local commit are retryable. The worker leaves the batch at `worker_checkpoint = 'committed'` instead of marking it failed, because `subsd` already owns the local Merkle commitment and a later run can retry Bitcoin broadcast.
- Retryable broadcast failures record `error_code` / `error_message` on the batch without changing its checkpoint.
- Broadcast responses without a `txid` do not advance the batch to `confirming`.
- Certificate fetch/publish failures leave the batch at `confirming` and record a retryable batch error. A single cert-fetch failure does not mark the entire batch failed.
- Issuance rows are marked `issued` with their own per-handle `certificate_payload_ref`; the worker no longer writes a comma-joined batch-level cert ref to every row.
- Proof-required batches can now move through the M4 skeleton:
  - `committed` + `proof_required = 1`
  - fetch inner `ProvingRequest` bytes from `GET /spaces/:space/proving/next`
  - reject unexpected Borsh `Option` tags instead of sending malformed proof input
  - store proof input through the artifact-store interface
  - submit RunPod Queue `/run`
  - poll RunPod `/status/:job_id`
  - store returned fulfill payload through the artifact-store interface
  - fulfill proof into `POST /spaces/:space/proving/fulfill`
  - call `GET /spaces/:space/proving/next` again
  - if another proving request exists, submit the next RunPod job and stay at `proving_submitted`
  - move to `proving_complete` only when `subsd` returns no pending proving request
  - continue to Bitcoin broadcast/finality/publish.
- RunPod is still disposable compute only. Job results are copied into Pirate artifact storage before `subsd` fulfillment.
- Implemented artifact stores:
  - `memory`: tests/local-only, not allowed when RunPod is enabled.
  - `file`: durable filesystem-backed storage for proof inputs/receipts. Refs are relative to the configured artifact root for mount portability. This is the current real-smoke gate until R2/S3 storage is added.
- RunPod proof jobs require `COMMUNITY_PROTOCOL_ISSUER_PROOF_ARTIFACT_STORE=file` and `COMMUNITY_PROTOCOL_ISSUER_PROOF_ARTIFACT_DIR`.
- RunPod terminal failures (`FAILED`, `TIMED_OUT`, `CANCELLED`) mark the batch and linked issuance rows failed. They are not retried forever against the same job id.
- `COMMUNITY_PROTOCOL_ISSUER_PROOF_JOB_MAX_AGE_SECONDS` optionally marks a stale queued/running RunPod job failed so a stuck job does not leave users in `issuing` indefinitely.
- `COMMUNITY_PROTOCOL_ISSUER_MAX_PROOF_JOBS_PER_BATCH` defaults to `16`. If `subsd` continues returning proving requests after that many submitted jobs for one batch, the issuer marks the batch and linked issuance rows failed with `proof_job_limit_exceeded`.
- `services/community-protocol-prover-runpod` defines the RunPod worker contract and command-adapter container:
  - input: `proof_input_base64`, `batch_id`, `parent_space`, `proof_input_ref`.
  - output: `fulfill_payload_base64` plus echoed batch metadata.
  - Dockerfile pins upstream `spacesprotocol/subs` at `dd92608be286a97bcbb1537cb0ba74ae35183539` and installs `subs-prover`.
  - default command uses `/app/subs_prover_http.py`, which starts `subs-prover --server`, posts binary Borsh to `/prove`, polls `/jobs/:job_id`, downloads `/jobs/:job_id/receipt`, and writes base64 for the RunPod result.
  - the RunPod worker frames the raw prover receipt for `subsd /proving/fulfill`: 8-byte little-endian `commitment_id`, 1-byte request type (`0` step, `1` fold), then receipt bytes.
  - `subsd /proving/next` returns `borsh::to_vec(&Option<ProvingRequest>)`; the issuer strips the outer `Some` tag and sends the inner `ProvingRequest` bytes because `subs-prover /prove` expects the inner request.
  - `SUBS_PROVER_FEATURES=cuda` can be passed at image build time for GPU-enabled builds; exact GPU base image/runtime still needs smoke validation.
  - upstream does not currently ship a `Cargo.lock`, so the git revision is pinned but production deployment should use an immutable built image digest and archive the generated dependency lock/build metadata.
  - worker command env vars are trusted operator config only and must not be derived from user/community input.
  - coordinate RunPod execution timeout, `SUBS_PROVER_TIMEOUT_SECONDS`, and `COMMUNITY_PROTOCOL_ISSUER_PROOF_JOB_MAX_AGE_SECONDS`; the shortest timer wins operationally.
- V1 assumes a single worker instance per community DB. A distributed parent-space lock is required before running concurrent workers.
- The one-shot runner is `bun src/main.ts` in `services/community-protocol-issuer`.
- The runner can either receive a direct community DB URL/token or resolve the active community DB credential from the control plane via `COMMUNITY_PROTOCOL_ISSUER_COMMUNITY_ID`. Prefer the control-plane resolver for staging/prod so rotated Turso tokens are not copied into the issuer secret namespace.

Runner environment:

```text
COMMUNITY_PROTOCOL_ISSUER_COMMUNITY_DB_URL optional direct community DB URL
COMMUNITY_PROTOCOL_ISSUER_COMMUNITY_DB_AUTH_TOKEN optional direct community DB auth token
COMMUNITY_PROTOCOL_ISSUER_COMMUNITY_ID optional control-plane resolver community id
CONTROL_PLANE_DATABASE_URL required when using COMMUNITY_PROTOCOL_ISSUER_COMMUNITY_ID
TURSO_COMMUNITY_DB_WRAP_KEY required when using COMMUNITY_PROTOCOL_ISSUER_COMMUNITY_ID
COMMUNITY_PROTOCOL_ISSUER_SUBSD_BASE_URL
COMMUNITY_PROTOCOL_ISSUER_MIN_BATCH_SIZE default 5
COMMUNITY_PROTOCOL_ISSUER_MAX_BATCH_SIZE default 50
COMMUNITY_PROTOCOL_ISSUER_MAX_BATCH_AGE_SECONDS default 1800
COMMUNITY_PROTOCOL_ISSUER_BTC_FEE_RATE_SAT_VB optional explicit broadcast fee rate
COMMUNITY_PROTOCOL_ISSUER_RUNPOD_ENDPOINT_ID optional
COMMUNITY_PROTOCOL_ISSUER_RUNPOD_API_KEY optional
COMMUNITY_PROTOCOL_ISSUER_PROOF_ARTIFACT_STORE optional; "file" for real RunPod jobs, "memory" for tests/local only
COMMUNITY_PROTOCOL_ISSUER_PROOF_ARTIFACT_DIR required when artifact store is "file"
COMMUNITY_PROTOCOL_ISSUER_PROOF_JOB_MAX_AGE_SECONDS optional stale RunPod job timeout
COMMUNITY_PROTOCOL_ISSUER_SCAN_LIMIT optional
```

Staging Infisical placeholders:

```text
/services/community-protocol-issuer
  COMMUNITY_PROTOCOL_ISSUER_RUNPOD_ENDPOINT_ID=auto-created-by-provisioner
  COMMUNITY_PROTOCOL_ISSUER_RUNPOD_API_KEY=x
  COMMUNITY_PROTOCOL_ISSUER_SUBSD_BASE_URL=http://127.0.0.1:7777
  COMMUNITY_PROTOCOL_ISSUER_PROOF_ARTIFACT_STORE=file
  COMMUNITY_PROTOCOL_ISSUER_PROOF_ARTIFACT_DIR=/var/lib/pirate/community-protocol-issuer/proofs
  COMMUNITY_PROTOCOL_ISSUER_PROOF_JOB_MAX_AGE_SECONDS=604800

/services/community-protocol-subsd
  SUBSD_RPC_URL=http://127.0.0.1:7225
  SUBSD_WALLET=wallet_99
  SUBSD_DATA_DIR=/var/lib/pirate/subsd/data
  SUBSD_PORT=7777

/services/community-protocol-prover-runpod
  SUBS_PROVER_TIMEOUT_SECONDS=604800
  RUNPOD_PROVER_IMAGE=t3333333k/community-protocol-prover-runpod@sha256:fc8f56292fd749f6c305ba7483510cc8747376acf3ab778e3a751f4dbfd4380e
  RUNPOD_PROVER_TEMPLATE_ID=auto-created-by-provisioner
  RUNPOD_PROVER_ENDPOINT_ID=auto-created-by-provisioner
  RUNPOD_PROVER_GPU_TYPE=NVIDIA GeForce RTX 4090
  RUNPOD_PROVER_WORKERS_MIN=0
  RUNPOD_PROVER_WORKERS_MAX=1
  RUNPOD_PROVER_EXECUTION_TIMEOUT_MS=604800000
  RUNPOD_PROVER_IDLE_TIMEOUT=5
```

The only manual secret is `COMMUNITY_PROTOCOL_ISSUER_RUNPOD_API_KEY`. After the worker image exists in a registry, run:

```bash
rtk python3 services/community-protocol-prover-runpod/scripts/provision_runpod.py --write-infisical --infisical-env staging
```

That creates or reuses the RunPod private template and Queue Serverless endpoint, then writes the generated endpoint/template ids back to Infisical. It uses RunPod's REST template and endpoint APIs with Bearer auth.

Current staging resources:

```text
RunPod template: a0nqg0h3ge
RunPod endpoint: kifqe786lpj2ne
Worker image: t3333333k/community-protocol-prover-runpod:staging
Image digest: sha256:fc8f56292fd749f6c305ba7483510cc8747376acf3ab778e3a751f4dbfd4380e
```

Endpoint smoke result: RunPod accepted a queue job and the worker ran the pushed image. The invalid-input smoke failed inside `/app/proof_worker.py` with `proof_input_base64 must be valid base64`, which verifies endpoint auth, image pull, handler startup, and worker execution.

If the API key is stored only in Infisical, run the provisioner through that path:

```bash
rtk infisical run --project-config-dir ../core --env staging --path /services/community-protocol-issuer -- rtk python3 services/community-protocol-prover-runpod/scripts/provision_runpod.py --write-infisical --infisical-env staging --infisical-project-id 5acea78e-7813-4d8a-b29c-9b862a0b1c71
```

Workflow:

```text
load pending issuance rows
group by parent_space
for each parent_space:
  stage unbatched handles in subsd
  create/open batch
  attach issuance rows to batch
  commit batch in subsd when policy threshold is met
  if proof_required:
    store proof input
    submit RunPod job
    store runpod_job_id
    wait for webhook or polling fallback
    store receipt
    fulfill receipt into subsd
  broadcast Bitcoin tx
  poll finality
  publish certs
  store cert refs
  mark linked issuance rows issued
```

Batch policy for v1:

```text
Group by parent_space.

Commit when:
  count >= 5
  OR oldest pending >= 30 minutes
  OR operator manually forces batch
```

Max batch size:

```text
max_batch_size = 50 for v1 unless proof benchmarks justify more
```

The worker must not attach more than `max_batch_size` handles to a single batch.

Pilot override:

```text
count >= 1
OR oldest pending >= 10 minutes
```

All thresholds must be config values:

```text
min_batch_size
max_batch_size
max_batch_age_seconds
pilot_batch_age_seconds
```

Fee policy:

- Configure max fee rate per commit.
- If fee rate exceeds budget, hold the batch and surface an operator alert.
- Do not fail user issuance solely because fees are temporarily high.

## RunPod Queue Serverless

RunPod role:

```text
disposable RISC Zero compute only
```

RunPod is not:

- Source of truth.
- Durable proof storage.
- Workflow owner.

Integration:

```text
issuer gets proof input from subsd
issuer stores proof input in Pirate storage
issuer submits RunPod /run job
issuer stores runpod_job_id
RunPod webhook or polling returns receipt
issuer immediately stores receipt in Pirate storage
issuer fulfills receipt into subsd
```

Do not rely on RunPod result retention.

Initial endpoint settings:

```text
RunPod Queue Serverless
Flex workers
workersMin = 0
workersMax = 1
executionTimeout = high enough for proof jobs
GPU = 4090 / A40 / L40S class
webhook = Pirate issuer webhook
polling fallback = enabled
```

Avoid RunPod load-balancing endpoints because proof jobs can exceed per-request HTTP timeouts.

Scaling note:

- `workersMax = 1` is intentional for pilot to avoid parallel proof cost surprises.
- This serializes proof jobs across the worker scope.
- Increase only after proof duration, GPU memory, and batch economics are measured.

## Failure Behavior

If a batch fails:

- `protocol_issuance_batches.status = 'failed'`
- `worker_checkpoint = 'failed'`
- `error_code` stores a machine-readable reason.
- `error_message` stores human-readable context.

Linked handle issuance rows:

- Stay `issuing` if the failure is retryable and the operator can recover the batch.
- Move to `failed` only when the failure is terminal or support decides to abandon/recreate the batch.

Do not silently retry forever.

Required operator actions:

- Inspect batch.
- Retry batch.
- Force replacement batch if safe.
- Mark failed with reason.

Product behavior:

- The app handle remains active unless a separate admin action revokes it.
- v1 does not automatically refund on protocol issuance failure.
- This must be clear in product copy: app-internal ownership is immediate; protocol certificate issuance is asynchronous.

## Idempotency

Use these identifiers as idempotency keys:

```text
claim_id / handle_claim_quote_id
community_handle_id
community_handle_protocol_issuance_id
protocol_issuance_batch_id
runpod_job_id
bitcoin_txid
```

Idempotency rules:

- Creating protocol issuance for a handle is unique by `community_handle_id`.
- Attaching issuance rows to a batch must be repeatable.
- Staging the same SName in `subsd` must treat `AlreadyStaged` and `AlreadyCommitted` as successful idempotent outcomes when script pubkey matches.
- `AlreadyStagedDifferentSpk` and `AlreadyCommittedDifferentSpk` are hard conflicts.
- RunPod webhook handling must be idempotent by `runpod_job_id`.
- Bitcoin broadcast handling must be idempotent by `bitcoin_txid`.

## Build Order

### Milestone 1: Durable State

- Add community DB migration.
- Update generated operator migration manifest.
- Add contract/types for protocol issuance.
- Add serialization helper for handle protocol status.
- Add focused tests for migration and serialization.

### Milestone 2: Claim Integration

- Add `issuance_mode` policy setting.
- Add `protocol_owner_wallet_attachment` to claim request if not already present.
- Validate Bitcoin P2TR ownership wallet.
- Insert protocol issuance row in the same transaction as the active app handle.
- Extend quote response with protocol eligibility messaging.
- Extend `/handles/me` and admin list with protocol issuance summary.

### Milestone 3: Issuer Worker Without RunPod

- Build `subsd-client`.
- Build DB store.
- Stage handles.
- Create batches.
- Commit initial batch.
- Broadcast/finalize/publish proofless initial batch.
- For non-initial batches, stop at `worker_checkpoint = 'committed'` with `proof_required = 1` and an operator-visible message that RunPod proof integration is not enabled.
- Milestone 3 must not be used for production protocol issuance beyond a controlled initial proofless test batch.

### Milestone 4: RunPod Proof Integration

- Add proof artifact storage. Done for memory and durable file storage; R2/S3 remains a later hardening option.
- Add RunPod client. Done for Queue `/run` and `/status`.
- Add RunPod worker contract/container. Done as a command-adapter worker in `services/community-protocol-prover-runpod`.
- Add webhook handler and polling fallback. Polling exists inside one-shot workflow; webhook handler still pending.
- Store proof input and receipt. Done through artifact-store interface; real RunPod jobs are gated to file-backed storage.
- Fulfill proof into `subsd`. Implemented in workflow once RunPod returns `fulfill_payload_base64`.
- Continue broadcast/finality/publish. Implemented after `proving_complete`.

### Milestone 5: Admin Operations

- Batch list/detail.
- Retry failed batch.
- Force batch.
- View proof refs, RunPod job id, Bitcoin txid, cert refs.

### Milestone 6: Staging Smoke

- Fresh parent Space initial batch:
  - claim
  - issuance row
  - stage
  - commit
  - broadcast
  - finality
  - publish
  - `/handles/me` shows `issued`
- Second batch requiring proof:
  - claim
  - stage
  - commit
  - RunPod proof
  - fulfill proof
  - broadcast
  - finality
  - publish
  - cert resolves

## Test Plan

API tests:

- App-internal policy does not create protocol issuance.
- `spaces_subspace` policy requires Bitcoin Taproot wallet at quote/claim.
- Non-Taproot Bitcoin wallet is rejected with a specific error.
- Wrong-user wallet attachment is rejected.
- Paid claim creates app handle and issuance row atomically.
- If issuance row creation fails, no active app handle is committed.
- `/handles/me` includes `issuing` status.
- Admin list includes batch/checkpoint summary when present.

DB tests:

- One issuance row per handle.
- One active issuing/issued row per `parent_space + sname`.
- Batch can attach many issuance rows.
- Batch RunPod job id and Bitcoin txid uniqueness are enforced.

Issuer tests:

- Groups pending rows by parent space.
- Handles `AlreadyStaged` as idempotent success for matching script.
- Handles `AlreadyCommitted` as idempotent success for matching script.
- Treats `AlreadyStagedDifferentSpk` as hard failure.
- Treats `AlreadyCommittedDifferentSpk` as hard failure.
- Creates one batch for many handles.
- Initial batch skips proving and proceeds to broadcast.
- Non-initial batch stops or submits proof.
- RunPod webhook is idempotent.
- Receipt is stored before fulfill.
- Finality polling can resume after restart.

Integration tests:

- Local `subsd` test-rig initial batch.
- Local/staging proof-required batch using real RunPod worker.
- Certificate retrieval and publish.

## Remaining Audit Questions

Resolved for v1:

- `parent_space = "@" + namespace_bindings.normalized_label`.
- Batch and issuance tables live in the community DB.
- The v1 issuer worker is scoped per community.
- App handles remain active if protocol issuance fails terminally unless an admin separately revokes the app handle.
- `issuance_mode` is platform-controlled for v1.
- RunPod `workersMax = 1` is a pilot constraint, not a scaling design.

Still open before production proof jobs:

1. Certificate payload storage if we decide cert payloads should be durable artifacts rather than refs only.
2. Validate the pinned upstream `subs-prover` Docker build on the target RunPod GPU image.
3. What GPU class and memory are required for expected batch sizes?
4. What proof duration and memory profile do we measure for `max_batch_size = 1`, `5`, `10`, and `50`?

## Non-Goals For First Implementation

- No protocol issuance for HNS/bare namespaces.
- No user-run proving.
- No custodial Bitcoin keys.
- No automatic refunds.
- No broad public UI exposing internal worker checkpoints.
- No load-balanced RunPod HTTP endpoint for proof jobs.
- No one-purchase-one-Bitcoin-commit default for general launch.
