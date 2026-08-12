# Dance reward qualification v1

Status: approved v1 design baseline. Implementation and accrual must remain dark until the
acceptance gates in this document pass. This document does not authorize production rewards.

Implementation snapshot (2026-08-10): the landed surface remains dark but now includes authenticated
session/attempt reads, active-revision choreography reads, and cancellation in addition to session
creation, upload, dispatch, signed callback, terminal persistence, and cleanup. Telegram session
binding, consent receipts, start cues, admitted calibration, engagement updates, and reward
qualification remain unimplemented. The sections below describe the target contract, not current
availability.

## Decision summary

Pirate will add `dance` as a third way to earn a song-practice reward. A rewarded dance attempt
compares a server-extracted pose sequence from a Telegram video reply with a versioned reference
choreography. A passing attempt emits the same durable reward qualification event used by study and
karaoke.

V1 fixes the following product decisions:

- `dance` is an explicit campaign activity.
- Existing `either` campaign terms remain frozen as `study OR karaoke`. Adding `dance` must not
  expand already-funded campaigns.
- A user may earn at most one `campaign_practice_day` reward for a song post and UTC day across
  study, karaoke, and dance.
- Telegram bot conversation is the only v1 delivery channel. V1 has no Mini App, browser capture
  page, custom recorder, live pose overlay, or TikTok-style feed.
- The bot creates a session before accepting its video reply. A randomly selected, gross-body
  start cue is shown after session creation and verified from the opening frames. This is a
  freshness signal, not proof of physical liveness.
- Telegram video replies are uploads and cannot be assumed to be newly recorded. Session binding,
  the start cue, reference-copy rejection, and duplicate fingerprints provide layered protection.
- Replay controls are the randomized start cue, reference-copy rejection, exact and near-duplicate
  fingerprints, session binding, Telegram file identifiers, and the existing credit-time
  unique-human proof.
- Raw attempt video is stored only in a private ephemeral object bucket. The grader explicitly
  deletes it after a terminal result. A one-day object-lifecycle rule is a failure backstop, not the
  primary deletion mechanism.
- Full landmark sequences are not retained by default.
- Reference choreography is a versioned first-class resource. It is not only a new song artifact
  kind or a mutable field on the song post.
- Choreography authorship is decoupled from music ownership. Any user's dance-video post that
  references a song can host a choreography; the musician publishes an "official" one the same way,
  and the official mark grants attribution and placement only — no scoring effect, no exclusivity.
  There is no per-song permission over choreography creation in v1: rights and moderation govern the
  video, third-party-reward consent governs money, and campaign revision pinning selects what earns.
  A per-song policy can be added later as a purely additive column if demand appears.
- Dance scoring and campaign qualification use integer basis points from `0` through `10000`.
- Dance score terms are versioned independently from karaoke score terms.
- The first production worker is a Modal asynchronous CPU function: the platform-independent
  `dance_grader` package plus a thin `modal_app.py`, dispatched by the API and reporting back over
  an HMAC-signed callback. Cloudflare Containers is the named fallback if Modal's benchmark,
  privacy review, or operational behavior disappoints.
- The standard hosted Telegram Bot API's 20 MB `getFile` download ceiling is a v1 product limit.
  Pirate will not operate a local Bot API server in v1.

## Problem

Study and karaoke already converge on an append-only, activity-tagged reward qualification outbox.
Dance fits that model, but uploaded video introduces failure modes that the current activities do
not have:

- choreography scoring must tolerate human timing offset without accepting incorrect motion;
- short, occluded, shuffled, mirrored, or unrelated performances must not receive high scores;
- the reference video, another user's performance, or a prior performance must not be replayed for
  repeated rewards;
- raw video can contain a face, a home, bystanders, and other sensitive context;
- a remote grading service must not be able to invent an attempt, user, choreography, or reward;
- changes to a reference or scoring model must not make historical evidence irreproducible.

The proof of concept validates pose extraction and visualization, but its current score cannot be
used for rewards. Against the checked-in pose fixtures, the current implementation produced:

| Case | Score |
|---|---:|
| Reference against itself | 100.00 |
| Honest attempts | 60.89–61.41 |
| Reference shifted by 500 ms | 65.80 |
| Still first pose | 52.26 |
| Reference played backward | 62.38 |
| Reference frames shuffled | 62.77 |
| First second only | 95.01 |
| Honest attempt with visibility forced to zero | 87.44 |

These results make coverage, confidence handling, sequence discrimination, temporal alignment, and
calibration merge-blocking work.

## Goals

- Grade one person's performance of a pinned choreography revision.
- Produce a calibrated, reproducible `score_bps` and explicit integrity/quality outcome.
- Prevent a short or low-confidence input from qualifying.
- Reject reference copies and repeated submissions at a useful v1 abuse threshold.
- Keep the grader outside the money-authority boundary.
- Reuse reward campaign accounting, identity deduplication, caps, settlement, and cashout.
- Delete raw attempt video promptly and prove cleanup operationally.
- Preserve enough bounded evidence to explain and audit a qualification without retaining raw
  video or a full motion trace.
- Roll out behind independent capture, grading, and accrual flags.

## Non-goals

- Perfect proof that a camera stream is physically live.
- Resistance to a determined adversary using real-time compositing, a virtual camera, or a
  human-in-the-loop farm.
- Biometric identity recognition from face, body shape, or gait.
- Independent same-day payouts for study, karaoke, and dance.
- Multiple simultaneous dancers or group choreography.
- Arbitrary camera-angle invariance.
- Creator-authored scoring formulas.
- A public upload-and-grade endpoint that returns money-bearing results.
- A Telegram Mini App or general-purpose web upload surface.
- GPU deployment before CPU throughput is measured.
- Long-term storage of raw attempts for moderation, social posting, or model training.

## Safety and product invariants

These are implementation and rollout gates.

1. **Legacy campaign scope is immutable.** `eligible_activity = 'either'` matches only `study` and
   `karaoke`, before and after the dance migration.
2. **Dance requires explicit funding terms.** Only `eligible_activity = 'dance'` can pay a dance
   qualification in v1.
3. **One paid practice day.** The existing unique-human, song-post, UTC-day
   `campaign_practice_day` claim remains the cross-activity payout fence.
4. **The client never reports a score.** The platform accepts a result only from the configured
   grading service and binds it to an existing submitted attempt.
5. **The grader never chooses reward identity or amount.** It returns scoring and integrity facts.
   The API resolves the user, campaign, unique-human identity, score floor, cap, and amount.
6. **Pinned evidence.** Every terminal result names the exact choreography revision, reference
   content hash, pose-model version, feature-schema version, scorer version, and integrity-policy
   version used.
7. **No partial qualification.** Coverage, detection quality, capture integrity, and score floor
   must all pass before an outbox event is emitted.
8. **Idempotent finalization.** Repeated callbacks for identical terminal facts return the existing
   result. A callback that changes any terminal fact is rejected and alerted.
9. **Private raw media.** Attempt video has no public gateway URL, CID, custom-domain route, or
   durable user-visible download URL.
10. **Explicit deletion.** Terminal finalization attempts object deletion immediately. Cleanup
    status is durable and retryable; the lifecycle rule is only a backstop.
11. **Minimal retained evidence.** A full pose sequence is not written to the shard, control plane,
    logs, analytics, or reward outbox.
12. **Fail closed.** Missing versions, missing score, invalid signature, insufficient coverage,
    unavailable duplicate checks, or uncertain reference identity cannot qualify.
13. **Cue-aware scoring is a new contract.** Introducing or changing cue-window removal increments
    the dance scoring contract version. The current dance schema names this `scorer_version`; do not
    reuse an existing value or add a parallel `scoring_version` without a contract migration. The
    cue policy/version and scored-window facts participate in the signed result digest and finalizer
    idempotency comparison. A pre-cue job cannot be silently regraded under the cue-aware contract.
14. **Consent precedes storage.** A versioned consent receipt must be persisted before the first
    byte of any participant recording, including a staff calibration recording, is stored or sent
    to the grader.

## Terminology

- **Choreography:** the logical dance, hosted by a dance-video post and referencing a song post.
- **Choreography revision:** an immutable reference video and derived reference feature set.
- **Dance session:** the authenticated, expiring authorization to upload one attempt.
- **Dance attempt:** the durable record of one submitted recording and its terminal grading result.
- **Reference features:** the precomputed, versioned pose and timing representation of a
  choreography revision.
- **Motion fingerprint:** a bounded keyed representation used for replay/duplicate detection. It is
  not an identity biometric and must not be used to infer identity.
- **Integrity pass:** successful capture-binding and replay checks.
- **Quality pass:** sufficient duration, body visibility, pose presence, and usable frame coverage.
- **Rank eligible:** integrity pass, quality pass, and platform dance floor pass.
- **Campaign eligible:** rank eligible and at or above the selected campaign's dance floor.

## Architecture

The v1 data flow is:

```text
authenticated client
  -> choose "Do this dance" in the Telegram bot
  -> bot creates a dance session and returns a randomized start cue
  -> user replies to the prompt with a Telegram video
  -> webhook binds the reply to the pending session and downloads it once
  -> API validates and copies the media to the private attempt bucket
  -> API submits the session
  -> durable dispatch record and authenticated Modal dispatch
  -> Modal spawns the grading function
  -> grader fetches one object with a short-lived signed GET
  -> grader validates, extracts, aligns, scores, and fingerprints
  -> grader sends authenticated idempotent callback
  -> API finalizes shard attempt and optional reward outbox event in one transaction
  -> API records the control-plane projection
  -> API explicitly deletes raw video and retries cleanup until confirmed
  -> bot reports the terminal result or actionable retry message
```

The shared `community_jobs` lane is not used for grading. Dance receives a dedicated worker lane so
unrelated community work cannot create multi-minute or multi-hour grading latency.

Dispatch durability lives in the control-plane session (grading dispatch id, bounded attempt
count), not in any external queue: a sweeper re-dispatches stalled `submitted` sessions with
backoff and terminalizes them as `scoring_unavailable` when attempts are exhausted. Duplicate
dispatches remain safe because finalization is idempotent on the attempt id.

## Resource and data model

### Control-plane choreography tables

Create `dance_choreographies`:

- `dance_choreography_id TEXT PRIMARY KEY`;
- `community_id TEXT NOT NULL`;
- `host_post_id TEXT NOT NULL` — the dance-video post that presents this choreography (may be the
  song post itself for a musician-authored dance); at most one choreography per host post;
- `referenced_song_post_id TEXT NOT NULL` and `song_artifact_bundle_id TEXT NOT NULL` — the song
  the host post references; reward accounting resolves through these;
- `creator_user_id TEXT NOT NULL` — the host post's author, not necessarily the musician;
- `official INTEGER NOT NULL DEFAULT 0` — set by the song owner for attribution and UI prominence
  only;
- `status TEXT NOT NULL` in `draft`, `processing`, `ready`, `disabled`, `failed`;
- `active_revision_id TEXT`;
- `created_at`, `updated_at`;
- unique live-name or creator idempotency constraints as required by the creation route.

Create `dance_choreography_revisions`:

- `dance_choreography_revision_id TEXT PRIMARY KEY`;
- `dance_choreography_id TEXT NOT NULL`;
- positive `revision_number`;
- immutable `reference_storage_ref`, constrained to the dedicated
  `dance/reference-media/` object-key namespace before seed persistence and every media presign;
- immutable `reference_content_sha256`;
- `reference_mime_type`, `reference_size_bytes`, `reference_duration_ms`;
- `reference_width`, `reference_height`, `reference_fps`;
- `reference_feature_ref`;
- `reference_feature_sha256`;
- `pose_model_version`;
- `feature_schema_version`;
- `mirror_policy TEXT NOT NULL` with v1 values `strict` and `allowed`;
- `status TEXT NOT NULL` in `processing`, `ready`, `failed`, `retired`;
- bounded failure code;
- `created_at`, `ready_at`, `retired_at`;
- unique `(dance_choreography_id, revision_number)`;
- unique `(dance_choreography_id, reference_content_sha256)`.

A ready revision is immutable. Editing reference media creates a new revision. An attempt pins the
active revision when its session is created; later activation of another revision cannot change an
existing session or attempt.

### Ownership and control

Creation is open: any user may turn their own dance-video post that references a song into a
choreography. A song accumulates many choreographies through many hosts; the song surface may
aggregate them and feature the official one. V1 introduces no per-song permission over choreography
creation — the existing control surfaces are sufficient: rights/moderation act on the host video,
`requireThirdPartyRewardsAllowed` gates money, and campaign revision pinning decides exactly which
dance earns.

Disable semantics are fixed now so later controls stay additive: a rights or moderation action sets
the choreography (or a revision) to `disabled`; disabled choreography accepts no new sessions;
in-flight attempts finalize normally; a campaign pinned to a disabled revision stops admitting new
qualifications, already-pending qualifications are unaffected, and unspent budget follows the
existing campaign refund lifecycle.

The v1 pilot operator-seeds a dance-video post referencing the pilot song and creates its
choreography, so the eventual creator flow is exercised without assuming the musician authored the
dance.

The public reference video may reuse the existing durable song-media storage primitives, but the
choreography row remains the canonical version and policy boundary. Derived reference features may
use private durable object storage.

### Control-plane session and coordination table

Create `dance_attempt_sessions`:

- `dance_attempt_session_id TEXT PRIMARY KEY`;
- `dance_attempt_id TEXT NOT NULL UNIQUE`;
- `subject_user_id`, `community_id`, `post_id`, `song_artifact_bundle_id`;
- pinned `dance_choreography_revision_id`;
- expected reference and feature hashes;
- `status TEXT NOT NULL` in `initialized`, `uploading`, `submitted`, `grading`, `finalized`,
  `rejected`, `failed`, `expired`;
- server-resolved `activity_date` and `activity_timezone`;
- random private `upload_object_key`;
- expected MIME type and maximum bytes;
- observed object size, ETag, and SHA-256 after submit;
- capture-mode declaration;
- source channel and channel-specific capture mode;
- consent policy version, consented timestamp, and bounded consent source;
- randomized cue id/version, assignment timestamp, cue window, and verification outcome;
- grading dispatch id and bounded attempt count;
- grader result digest;
- cleanup status in `not_required`, `pending`, `deleted`, `retrying`, `failed`;
- expiry, submission, finalization, deletion, creation, and update timestamps;
- creation idempotency key unique per subject.

The session row coordinates external work; it is not the authoritative reward evidence. A terminal
shard attempt is authoritative. Cross-database projection failures are repaired idempotently from
the shard attempt.

### Community-shard dance attempts

Create `dance_attempts`:

- `dance_attempt_id TEXT PRIMARY KEY`;
- unique `dance_attempt_session_id`;
- `user_id`, `community_id`, `post_id`, `song_artifact_bundle_id`;
- server-resolved `activity_date` and `activity_timezone`;
- pinned `dance_choreography_revision_id`;
- `status TEXT NOT NULL` in `passed`, `rejected`, `failed`;
- nullable `score_bps` constrained to `0..10000`;
- `rank_eligible INTEGER NOT NULL` constrained to `0|1`;
- `quality_outcome`, `integrity_outcome`, and bounded reason codes;
- `coverage_bps`, `pose_detection_bps`, `duration_ratio_bps`;
- selected temporal offset and warp metrics;
- reference content and feature hashes;
- pose model, feature schema, scorer, calibration, fingerprint, and integrity-policy versions;
- keyed whole-attempt fingerprint hash;
- a bounded JSON array of keyed segment fingerprint hashes;
- grader result digest;
- `completed_at`, `created_at`.

Do not store the source object key, signed URL, public URL, raw landmarks, image frames, or arbitrary
grader diagnostics on the shard.

### Engagement ledger

Add `dance_pass_count INTEGER NOT NULL DEFAULT 0` to `song_engagement_days`.

A rank-eligible dance attempt increments `dance_pass_count` once and sets `qualified = 1`. Study and
karaoke upserts must preserve the dance branch:

```sql
qualified =
  study threshold reached
  OR karaoke_pass_count > 0
  OR dance_pass_count > 0
  OR existing qualified
```

Attempt insertion, engagement update, streak materialization, and reward outbox insertion occur in
one shard write transaction. An idempotent callback cannot increment the count twice.

The session resolves `activity_date` and `activity_timezone` through the existing song-practice
timezone policy. The grader callback cannot choose them. The reward outbox continues deriving its
`reward_period_key` from the trusted completion timestamp in UTC, matching the existing campaign
claim fence.

### Duplicate fingerprints

Create a bounded control-plane `dance_attempt_fingerprints` projection:

- `dance_attempt_id` and subject user;
- choreography revision and reference hash;
- fingerprint policy version;
- keyed whole-attempt fingerprint hash;
- bounded keyed segment hashes;
- terminal integrity outcome;
- expiry and creation timestamps.

The HMAC key is platform-held and versioned. The grader returns canonical fingerprint material,
authenticated as part of its signed result; the API applies the platform-held keyed HMAC and stores
only the derived hashes. Raw reference or user landmark sequences are never required for a duplicate
lookup.

Fingerprint retention must be explicitly configured and bounded. V1 default is 90 days, subject to
the final privacy review before production. Expiry removes the projection without affecting the
immutable aggregate reward evidence.

## Delivery channel: Telegram bot (v1)

Telegram is the v1 product surface. The HTTP resources below remain the internal platform contract
used by the bot and future clients; they are not a promise of a general public upload UI.

### Conversation state machine

1. The bot sends the reference dance video, its song attribution, the attempt terms, and a
   `Do this dance` action.
2. The action creates a short-lived session pinned to the Telegram account, linked Pirate user,
   host post, song post, choreography revision, and applicable reward terms.
3. The bot selects one versioned gross-body start cue, such as hands on head, arms in a T, or hands
   on hips. It asks the user to begin with that pose and then perform the dance.
4. The user replies to that exact bot prompt with a Telegram `video` or video `document`. The
   webhook binds the update to the pending session using the reply relationship and stored chat and
   message identifiers; caption text is not an authority token.
5. The bot acknowledges receipt and reports `Grading…`. The API downloads the file once, validates
   it, stores it in the private ephemeral attempt bucket, and dispatches grading.
6. The bot sends or edits a terminal message with score, pass/rejection, concise corrective
   feedback, and reward status when rewards are enabled.

The first implemented cue contract is `dance_start_cue_gross_body_v1`: one of `hands_on_head`,
`arms_t`, or `hands_on_hips`, selected with cryptographic randomness at session creation, held for
at least 500 ms inside the opening 2,500 ms. The assignment is database-immutable. The grader
records `passed` plus the exact scored-window boundary, or rejects with `start_cue_mismatch`; the
cue evidence is included in the callback digest and immutable aggregate attempt evidence. Scoring
after cue-window exclusion is `dance_scorer_gate0_v2`. Session creation selects only v2 reference
revisions; there is no in-place v1-to-v2 reprocessing job, so v1 references remain unavailable until
operators seed a fresh v2 revision. Migration 0216 is the cutover boundary for existing sessions:
it expires every nonterminal session, so it must run before any consented staff recording or pilot
capture begins.

Only one nonterminal dance session may exist per Telegram account. `/cancel` expires it and releases
the slot. Sessions also expire automatically. Telegram webhook redelivery, repeated button presses,
repeated media updates, dispatch retry, and result delivery are idempotent.

The bot accepts media only from the same private chat and Telegram sender that created the session.
Forwarded-message metadata is rejected for reward-bearing attempts. Absence of forwarding metadata
is not treated as proof of fresh capture. A Telegram account must be linked to the platform's
rewards-eligible identity before an attempt can accrue money; an unlinked user may receive a score
but must not see an earned-reward claim.

### Telegram media contract

The hosted Bot API `getFile` limit is 20 MB. The channel-neutral V1 contract accepts at most
19,000,000 bytes and 30 seconds for both choreographies and attempts. Session creation persists the
accepted consent policy and timestamp before upload authorization; legacy sessions without that
receipt cannot obtain or reuse an upload intent. The API, storage signer, callback contracts, and
grader enforce the shared envelope. Consent receipt columns are database-immutable after insert;
legacy all-null rows cannot be retroactively consented. Persisted session limits are capped at
19,000,000 bytes, and ready references above 30 seconds are retired and disabled rather than
remaining selectable but impossible to complete. The Telegram adapter must additionally reject an oversized
reported file before download and pass an explicit 19,000,000-byte ceiling to its bounded download
helper; that adapter work remains pending. Limits may be configured downward, but raising either
requires evidence that the hosted Bot API and grader budgets still hold. V1 does not operate a
local Bot API server.

Both Telegram `video` and video `document` messages are accepted. `file_id` is used to download;
`file_unique_id` and the observed media metadata are retained as bounded exact-replay signals.
Neither identifier replaces content hashing, reference comparison, or motion-fingerprint checks.
The API streams the Telegram file into private ephemeral storage, enforces a download byte ceiling,
hashes it, probes the actual container and codecs, and normalizes supported inputs to the grader's
MP4 contract. Declared MIME type, file name, and Telegram metadata are not trusted as media
validation.

Telegram commonly transforms videos sent as `video`, while documents may preserve their source.
Therefore Gate 0 calibration and Gate 1 pilot recordings must enter through this exact Telegram
flow in the same user-default media mode expected in production. Clean local files alone cannot
admit a calibration for Telegram reward traffic. Calibration reporting must stratify `video` and
`document` delivery; v1 may disable document attempts for rewards if the held-out corpus does not
support one shared policy.

### Failure and retry UX

Failure handling distinguishes user-correctable capture failures from infrastructure failures:

- Invalid/oversized media, duration, coverage, pose presence, multiple-person, and start-cue
  failures close the submitted session, release the active slot, and return a reason-specific
  instruction plus `Try again`, which creates a new session and cue.
- Reference replay or duplicate-attempt outcomes close the session without accusatory language and
  do not offer an automatic reward retry against the same evidence.
- `scoring_unavailable` remains pending while bounded server dispatch retries run. After exhaustion
  it closes the session, consumes no daily qualification, and offers a new attempt.
- A failed, rejected, expired, or cancelled attempt never consumes the song/day reward fence. Only
  a committed qualification does.
- Telegram message-delivery failure does not change the terminal attempt. A later bot interaction
  can read and present the durable result.

The bot maps stable internal reason codes to reviewed user-facing copy. It never exposes provider
errors, signed URLs, hashes, fingerprints, or fraud accusations.

## Public API

New public resources follow the repository's resource conventions: canonical `id` and `object`
fields, Unix-second timestamps, expandable reference fields without `_id` suffixes, and no generic
public `updated_at`.

The read path in this section is greenfield. The landed dance routes are write-only; Telegram,
browser, and native clients have no current status or choreography resource to call.

### Reward opportunity reads

Add `GET /reward-opportunities?activity=dance` as a core-first contract change. Do not overload
`/public/reward_campaigns`: a campaign is a funding envelope, while an opportunity is the
viewer-facing combination of campaign eligibility, song post, choreography revision, timing, and
completion state.

Each opportunity has an opaque id and includes the activity, song/post identity, pinned
choreography revision, display amount/network, active window, score-policy summary, and the
viewer's bounded availability/completion state. Availability is advisory until the existing reward
reservation and credit transaction succeeds. Telegram, web, Android, and iOS consume the same
resource; no channel-specific reward selection is authoritative.

This resource must begin in the Core OpenAPI source, regenerate bundled OpenAPI and contracts, and
land before API implementation. Generated contract files are never hand-edited.

### Choreography reads

- `GET /posts/{post}/dance-choreography`
- `GET /dance-choreographies/{id}`

A public choreography response exposes the active ready revision, mirror policy, reference playback
resource, expected duration, and availability. It does not expose derived feature storage.

Choreography reads, session creation, and attempt polling all reach the control plane, whose
connection budget is already constrained (scheduled-job concurrency is capped for that reason). The
public choreography read path must be cacheable, polling intervals must be generous, and a cached or
shard-side read model is required before broad availability.

Creation and revision activation are creator/operator surfaces and require a separate route review.
They are not required for the first fixed-reference pilot.

### Create a dance session

`POST /dance-sessions`

Request:

```json
{
  "post": "post_...",
  "idempotency_key": "client-generated"
}
```

The API authenticates the user, resolves the host post's choreography, its ready active revision,
and the referenced song, checks feature readiness and rollout flags, creates the attempt/session,
and returns:

```json
{
  "id": "dse_...",
  "object": "dance_session",
  "attempt": "dat_...",
  "post": "post_...",
  "choreography": "dch_...",
  "choreography_revision": "dcr_...",
  "status": "initialized",
  "upload": {
    "method": "PUT",
    "url": "short-lived-presigned-url",
    "headers": {
      "content-type": "video/mp4"
    },
    "max_bytes": 19922944,
    "expires_at": 1780000000
  },
  "expires_at": 1780000000,
  "created": 1779999000
}
```

The signed upload authorizes one object key and MIME type. Object size, actual codec, duration, and
decodability are verified after upload; request headers are not trusted as content validation.

### Submit a session

`POST /dance-sessions/{id}/submit`

Request:

```json
{
  "content_sha256": "64-lowercase-hex",
  "capture_mode": "telegram_video_reply"
}
```

Submit is an idempotent custom action. The API verifies object existence, bounds, observed metadata,
session ownership, expiry, and hash before moving the session to `submitted` and dispatching exactly
one logical grading job.

`capture_mode` is derived by the Telegram adapter, not accepted from Telegram caption text. It is
an auditable delivery-channel assertion, not cryptographic liveness proof. V1 does not claim
otherwise.

### Read status

- `GET /dance-sessions/{id}`
- `GET /dance-attempts/{id}`
- `POST /dance-sessions/{id}/cancel`

Cancellation is idempotent for an already-terminal session and is accepted as a state transition
only before submission. It moves the session to the distinct `cancelled` status with `cancelled`
reason and releases the active slot. Cleanup is scheduled only after an upload intent replaced the
placeholder object key; create-then-cancel never consumes the deletion sweep budget. Once a session
is `submitted` or `grading`, cancellation returns a conflict rather than racing immutable grader
evidence.

The attempt resource returns status, score when available, user-facing quality/integrity reason,
aggregate coaching dimensions, and whether a terminal attempt was reward eligible. Nonterminal
attempts return `rank_eligible: null`; they never project a provisional false value. It never returns
the raw video or fingerprint hashes.

Terminal rejections distinguish at least:

- `video_invalid`;
- `duration_out_of_range`;
- `insufficient_coverage`;
- `insufficient_pose_presence`;
- `multiple_people`;
- `reference_replay`;
- `duplicate_attempt`;
- `scoring_unavailable`;
- `below_platform_floor`.

Public copy must avoid claiming fraud when the system only observed a duplicate or uncertain input.

## Grader protocol

### Job request

The grading worker receives:

- attempt and session references;
- a short-lived signed GET for the private attempt object;
- immutable reference video/features access;
- choreography revision, hashes, duration, and mirror policy;
- required pose model, feature schema, scorer, calibration, fingerprint, and integrity versions;
- result callback URL;
- a per-job callback credential or key identifier;
- trace/request reference.

The job contains no reward amount, campaign floor, reward identity, wallet, or payout destination.

### Result callback

The grader sends a canonical JSON body with:

- attempt and session references;
- terminal grader outcome;
- `score_bps` when scoring completed;
- quality outcome and bounded metrics;
- integrity facts including reference-copy comparison;
- canonical fingerprint material or authenticated digest;
- selected mirror mode;
- temporal alignment metrics;
- all pinned versions and hashes;
- completed timestamp;
- deterministic result digest.

The callback uses a timestamped HMAC over:

```text
HTTP method
path
timestamp
attempt id
SHA-256(canonical body)
```

The API enforces a short clock window, constant-time signature comparison, expected key version,
session/attempt binding, and terminal-result immutability. A shared static plaintext header alone is
not sufficient for the external grader.

The dance `scorer_version` covers preprocessing that changes the scored input, including cue-window
exclusion. A cue-aware result includes the cue policy/version, observed cue outcome, and exact
scored-window boundary in its canonical digest material. Re-dispatch uses the session's pinned
contract tuple; it does not select whatever grader contract happens to be newest.

### Finalization order

1. Verify callback authentication and parse bounded input.
2. Load the expected session and pinned choreography facts.
3. Reject any hash, version, or identity mismatch.
4. Check existing shard attempt for idempotent terminal replay.
5. Perform reference-copy and duplicate-fingerprint decisions.
6. Derive `rank_eligible` from integrity, quality, and the platform dance floor.
7. In one shard transaction:
   - insert the terminal `dance_attempt`;
   - update the engagement day and streak if rank eligible;
   - emit the dance reward qualification if reward accrual flags permit.
8. Project the terminal session/fingerprint state to the control plane.
9. Mark raw-object cleanup pending and issue explicit delete.
10. Return the canonical attempt result.

Failure to delete video does not roll back an already-finalized score, but it pages/retries as a
privacy incident. Failure before the shard terminal write remains retryable and must not emit a
qualification.

## Scoring specification

### MediaPipe runtime

Use the MediaPipe Tasks Pose Landmarker in `VIDEO` mode. Pin the model artifact, library version, and
model checksum in the container. Record them in every result.

The extraction stage must:

- decode timestamps monotonically;
- apply rotation metadata before inference;
- preserve the original frame timeline, including missing detections;
- report pose presence and landmark visibility;
- reject zero or multiple principal subjects;
- convert image-normalized coordinates into aspect-corrected geometry;
- avoid treating image-relative `z` as equal to x/y;
- produce only the selected body landmarks/features needed by the versioned scorer;
- cap decoded duration, frame count, resolution, and total pixels.

Reference features are extracted once per choreography revision using the same pinned feature
schema. Changing the extractor or feature schema requires a new derived reference artifact and
scorer compatibility decision.

### Quality gate

Before pose similarity is considered, require:

- attempt duration within a calibrated ratio of reference duration;
- minimum usable-frame coverage over the full reference timeline;
- no missing-pose gap longer than a configured bound;
- minimum confidence for joints used in a scored feature;
- required full-body landmarks visible for enough frames;
- exactly one stable principal pose;
- valid temporal progression and bounded frame-rate variation.

V1 configuration values are calibration outputs, not hard-coded assumptions. The first-second-only
fixture and visibility-zero fixture are mandatory regression tests.

Low-confidence features are excluded from their local error calculation and the remaining error is
renormalized by total confidence. Low visibility can never improve the score. If too few features
remain, the quality gate fails.

### Temporal alignment

The client playback clock is the preferred initial alignment signal. The scorer may then estimate a
bounded global offset using a robust multijoint motion-energy or angle sequence.

After global alignment, constrained dynamic time warping may accommodate modest human tempo
variation. It must use:

- a narrow, versioned path band;
- monotonic matching;
- bounded local slope;
- an explicit warp penalty;
- a coverage penalty for unmatched reference or attempt regions.

Independent best-match frame windows and unconstrained DTW are prohibited because they can turn
incorrect timing or repeated poses into a high score.

The result reports global offset, total warp, unmatched coverage, and timing subscore.

### Mirror handling

For `mirror_policy = 'strict'`, only the reference handedness is scored.

For `mirror_policy = 'allowed'`, compute canonical and anatomically swapped horizontal-mirror
variants and select the better complete-sequence result. The selected variant is part of evidence.
Mirror selection cannot vary independently per frame.

### Feature groups

The first calibrated scorer should include:

- confidence-weighted 2D joint angles;
- aspect-corrected normalized joint positions for selected shoulders, elbows, wrists, hips, knees,
  ankles, and feet;
- velocity or first-difference features;
- motion-energy and timing features;
- beat or choreography-keyframe weighting where reference metadata supports it;
- explicit penalties for missing coverage, temporal warp, and unstable detection.

Face detail and finger landmarks are excluded from the reward score. World landmarks may be used as
a secondary feature only after their cross-device behavior is measured.

### Calibration and basis points

Raw feature similarity is not a percentage and must not be multiplied by `100` and treated as
reward basis points.

Calibration uses a labeled, held-out corpus containing:

- reference replay;
- reference with compression, crop, overlay, and resampling;
- honest attempts from different heights, clothing, lighting, devices, and camera distances;
- honest mirrored attempts when allowed;
- global offsets and moderate tempo differences;
- stillness, partial performances, and early termination;
- unrelated dances and random movement;
- reversed and shuffled motion;
- occlusion and intermittent detection;
- repeated prior attempts from the same and different accounts.

Corpus collection precedes the capture pipeline, so Gate 0 uses a two-tier corpus: a small
repository fixture set of synthetic and adversarial pose JSON containing no personal video, plus a
private calibration bucket (separate from the ephemeral attempt bucket) holding consented team
recordings — 10 to 20 people performing the reference honestly, plus mirrored, offset,
tempo-varied, partial, still, unrelated, reversed, occluded, and transcoded-replay variants across
devices, clothing, lighting, and camera distances. A held-out subset is never used while tuning
weights. The dark pilot expands this corpus before any reward floor is frozen.

The calibration artifact maps scorer features to `score_bps`, has its own version and checksum, and
is immutable for an admitted campaign attempt. Threshold selection is based on honest pass rate and
adversarial false acceptance, not letter-grade labels.

The platform dance floor prevents obviously weak results from emitting qualifications. A campaign
may set an equal or stronger dance floor but cannot weaken the platform floor.

## Reward integration

### Activity enums and constraints

Add `dance` to:

- shard `reward_qualification_outbox.activity`;
- control-plane `reward_qualification_events.activity`;
- reservation, pending-qualification, and reward-event `qualification_basis`;
- TypeScript activity unions;
- generated contracts and OpenAPI schemas;
- read serializers and tests.

Historical `qualification_basis = 'both'` remains readable for compatibility. V1 does not create a
combined three-activity basis.

### Qualification outbox

Add `emitDanceQualification()` beside the study and karaoke emitters. It accepts only server-owned
facts from the finalized shard attempt:

- dance attempt and session references;
- choreography and revision references;
- final score basis points;
- quality and integrity outcomes;
- reference content and feature hashes;
- pose model, feature schema, scorer, calibration, fingerprint, and integrity-policy versions.

The emitter builds bounded evidence from the persisted attempt inside the transaction. A client or
unpersisted callback object cannot directly provide `evidence_summary_json`.

Recommended policy version:

```text
dance_rank_eligible_v1
```

The current outbox uniqueness of `(user_id, post_id, activity, reward_period_key)` remains, with
`post_id` being the referenced song post resolved from the pinned choreography — so many
choreographies over one song still produce at most one dance qualification per user and UTC day,
and the cross-activity practice-day fence keeps operating on the song. Multiple passing dance
attempts on one UTC day therefore produce at most one dance qualification event.

### Campaign matching

Extend the campaign enum with `dance`, but do not use the current generic condition:

```sql
eligible_activity = 'either' OR eligible_activity = qualification_activity
```

That expression would silently make legacy `either` campaigns pay dance. Use explicit matching:

```sql
eligible_activity = qualification_activity
OR (
  eligible_activity = 'either'
  AND qualification_activity IN ('study', 'karaoke')
)
```

Apply the same predicate during outbox ingestion/projection, credit reconciliation, pending
qualification scans, and any public reward-offer selection.

Campaign creation validates prerequisites by activity:

- `study`: study artifact/readiness requirements;
- `karaoke`: timed measured lyric-line requirement;
- `either`: both legacy study/karaoke behavior and the existing karaoke requirement;
- `dance`: a ready active choreography revision with compatible reference features.

A `dance` campaign terms hash pins the choreography revision and required score-policy versions.
If choreography activation changes, the existing funded campaign continues to show and use its
pinned revision. Funding a new revision requires a new campaign or an explicitly designed future
terms transition.

Campaign lookup must also compare the qualification's choreography revision with the dance
activity term's pinned revision. Matching only community, post, song bundle, and activity is
insufficient.

### Per-activity score terms

Introduce `reward_campaign_activity_terms`:

- `reward_campaign_id`;
- `activity` in `karaoke`, `dance`;
- `min_score_bps`;
- `platform_floor_bps`;
- `score_policy_version`;
- nullable `dance_choreography_revision_id`, required only when `activity = 'dance'`;
- nullable reference content and feature hashes, required only when `activity = 'dance'`;
- nullable dance pose-model, feature-schema, scorer, calibration, fingerprint, and
  integrity-policy versions, required only when `activity = 'dance'`;
- `created_at`;
- primary key `(reward_campaign_id, activity)`;
- immutable after campaign funding begins.

For public API compatibility, `RewardCampaign.min_score_bps` remains the floor for the campaign's
only scored eligible activity:

- karaoke for `karaoke` and legacy `either`;
- dance for `dance`;
- accepted but unused for `study` until that API field is versioned away.

Migration backfills karaoke terms for existing `karaoke` and `either` campaigns from the current
column. New dance campaigns create only a dance term and mirror its selected floor into the legacy
non-null `reward_campaigns.min_score_bps` column for response and terms-hash compatibility. The
reconciler selects the term matching the qualification activity and fails closed if it is absent.

The activity-term database constraint permits `0..10000`; application validation enforces that a
campaign floor is at least the platform floor for that activity. Do not reuse the karaoke-specific
`>= 7000` lower bound for dance unless calibration independently selects the same bound.

The existing immutable campaign terms and hash include the selected activity term and policy
version. Dance campaigns use a new terms version and include the pinned choreography revision,
reference hashes, and every scoring/integrity version in the canonical terms payload.

### Daily reward semantics

Dance shares `reward_kind = 'campaign_practice_day'`.

Do not add activity to the unique key in `reward_song_period_claims`. The existing unique tuple:

```text
community, post, reward identity, UTC reward period, reward kind
```

continues to ensure that the first qualifying study, karaoke, or dance event earns the daily
practice reward and later activities receive an `identity_duplicate` outcome for that reward day.
They may still update product activity history and coaching results.

Independent activity payouts require a future campaign kind, cap design, funding quote, UI, and
terms review. They are outside v1.

## Replay and abuse controls

V1 uses layered friction rather than claiming cryptographic camera liveness.

### Required checks

- Session belongs to the authenticated subject, post, and pinned choreography revision.
- Session is unexpired and accepts only one upload object and one logical submission.
- Telegram sender, private chat, and reply-to prompt match the session.
- The opening frames satisfy the session's randomly selected, versioned gross-body start cue before
  choreography scoring begins.
- Submitted content hash matches the stored object.
- Attempt is not byte-identical to the reference or a previous attempt.
- Perceptual video/reference comparison does not indicate a reference copy with simple
  transcode/crop changes.
- Motion fingerprint does not match the reference feature sequence.
- Whole-attempt and segment fingerprints are checked against the user's previous attempts.
- Exact high-confidence cross-user fingerprint matches are rejected as shared replay.
- Credit-time unique-human proof and the existing song/day claim fence prevent multi-account
  duplicate payment for one verified identity.
- Per-user and per-IP session/submission limits constrain storage and grading spend.
- The backend permits at most one active dance session per user and at most six newly-created
  sessions per rolling hour. Cancellation does not refund the hourly budget, so users cannot
  cheaply re-roll the three cue kinds until a prepared clip matches.
- Repeated integrity failures can disable rewarded dance for the account pending review.

Near-duplicate thresholds must be calibrated against honest people performing the same choreography.
A low-confidence similarity is not enough to accuse or reject. Fail closed for rewards only when the
policy reaches its calibrated duplicate threshold; otherwise retain a bounded risk flag for
observability.

### Explicitly deferred controls

- audio nonce or spoken challenge;
- device attestation;
- palm or face liveness;
- continuous camera-frame attestation;
- manual video review;
- cross-platform biometric identity matching.

These remain escalation options if campaign value, duplicate rate, or observed organized farming
exceeds v1 risk limits.

The prelude-only cue does not prevent an attacker from splicing a freshly recorded valid cue onto
pre-recorded choreography footage. The cue is therefore replay friction, not continuous liveness.
Higher-value campaigns require a larger cue sequence or a challenge interleaved with choreography,
plus a separately calibrated scorer contract.

## Privacy and retention

### Raw attempt video

- Store in a dedicated private R2/S3-compatible bucket.
- Do not enable a public development URL or custom public domain.
- Use random non-user-derived object keys.
- Use short-lived operation-specific presigned URLs.
- Do not put signed URLs or object keys in analytics or ordinary logs.
- Explicitly delete immediately after passed, rejected, failed, or expired terminal state.
- Retry deletion through a dedicated cleanup worker.
- Apply the provider's minimum supported one-day lifecycle expiration as a backstop.
- Alert on objects that remain after the expected explicit-delete window.
- Abort incomplete multipart uploads with a lifecycle policy.
- Exclude the bucket from durable backup and replication unless a later privacy review explicitly
  approves them.

Grading on Modal makes it a data processor for ephemeral attempt video. Gate 0B may use explicitly
consented staff recordings in staging after the consent receipt and storage/deletion controls are
implemented. Before collecting any non-staff recording or admitting a calibration for broader use:
complete the subprocessor/DPA review, confirm that Modal containers retain no media after a job,
select the approved region where available, and verify that Modal-side logs contain no signed URLs,
frames, or landmarks. The same review covers Telegram as the capture/data-transfer channel.

The product statement must promise prompt deletion after grading, not instantaneous erasure. It
must describe the bounded cleanup fallback accurately.

### Retained evidence

Retain only:

- aggregate score, quality, timing, and integrity outcomes;
- version and content hashes;
- bounded reason codes;
- keyed duplicate fingerprints with an expiry;
- callback/result digest and operational timestamps.

Do not retain:

- raw video;
- audio extracted from the video;
- still frames or thumbnails;
- full pose or world-landmark sequences;
- face embeddings;
- unkeyed reusable motion templates.

Any future dispute workflow that retains raw video or full landmarks requires explicit consent,
access control, retention period, deletion behavior, and a separate privacy/security review.

## Deployment

### Grader container

Package a stateless HTTP/queue worker with:

- MediaPipe Tasks and a pinned Pose Landmarker asset;
- OpenCV or FFmpeg decode with strict resource limits;
- reference-feature cache keyed by immutable content and schema hashes;
- deterministic scorer and calibration artifacts;
- structured bounded logs without media URLs or landmarks;
- health, readiness, version, and metrics endpoints;
- no persistent local media after each job;
- concurrency fixed from measured CPU and memory use.

The grader may cache public reference features, but never caches user attempt media or full attempt
features across jobs.

### Initial hosting decision

Benchmark before selecting capacity. Measure at least:

- 0.5, 1.0, and 2.0 Modal physical cores (a Modal core is roughly two vCPU);
- 15 and 30 sampled frames per second;
- supported input resolutions and codecs;
- 15, 30, and 60 second clips;
- one through several concurrent workers;
- decode, inference, alignment, and callback time separately;
- peak resident memory and temporary disk;
- cold and warm reference-feature cache.

Run v1 grading on Modal asynchronous functions: the platform-independent `dance_grader` package
plus a thin `modal_app.py` entry point. The API calls a protected Modal dispatch endpoint with a
request HMAC; the endpoint spawns the grading function and returns immediately; the function
reports its terminal result through the standard signed callback. Modal-side `modal.Queue` and
`modal.Dict` are not documented as durably persistent and must not hold business state; durable
dispatch and attempt state stay in the control plane.

Give the grading job a short-lived, single-object signed R2 GET. Do not mount the attempt bucket or
grant Modal persistent list/read credentials. Reference features may be baked into the image or a
read-only volume once revisions become numerous. Separate Modal staging and production environments
and secrets are required.

Cloudflare Containers (`standard-2`, the Worker-wrapper pattern of
`services/song-preview-container`) is the named fallback if Modal's measured latency, privacy
review, or operational behavior disappoints; if exercised, the image must handle SIGTERM as PID 1 —
a prior container in this repository never slept because its runtime ignored SIGTERM, billing
allocated memory continuously. Move to RunPod or another GPU platform only when a real benchmark
shows a material end-to-end price or backlog-latency advantage. GPU availability alone is not
evidence that decode and pose extraction are cheaper or faster.

### Service-level objectives

Pilot targets:

- 95% of submitted attempts reach a terminal grading state within two minutes;
- no raw attempt remains in storage more than one hour after a successful terminal callback;
- lifecycle expiration removes any abandoned object within the provider's one-day granularity;
- callback and shard finalization are idempotent under at least ten identical deliveries;
- queue retry never produces a second qualification event;
- cleanup backlog and oldest-object age are visible and alerted.

These are initial operational targets and may be tightened after measured pilot data.

## Feature flags

Use independent flags:

- `DANCE_CHOREOGRAPHY_ENABLED`: expose ready choreography/reference playback.
- `DANCE_CAPTURE_ENABLED`: allow session creation and private upload.
- `DANCE_GRADING_ENABLED`: dispatch submitted attempts.
- `DANCE_REWARDS_ENABLED`: permit rank-eligible attempts to emit reward qualifications.
- Existing `REWARDS_CAMPAIGNS_ENABLED` and `REWARDS_ACCRUAL_ENABLED` remain required for emission
  and credit.

Turning off rewards must not disable attempt cleanup or access to already-completed results.
Turning off grading rejects new submissions cleanly while allowing in-flight jobs to finalize or
expire.

## Observability

Record bounded metrics by scorer/version, without user media:

- sessions created, submitted, expired, and abandoned;
- queue latency and grading duration;
- decode and pose extraction failures by code;
- coverage and pose-presence distributions;
- score distributions by choreography revision;
- platform-floor pass rate;
- reference-replay, same-user duplicate, and cross-user duplicate rates;
- callback authentication and version mismatch failures;
- shard finalization retries and idempotent replays;
- explicit delete latency, retry count, cleanup backlog, and oldest object age;
- reward outbox emission and downstream credit outcomes.

Alert on:

- any grader version/hash not allowed by the API;
- a sudden score or pass-rate shift after deployment;
- a reference-copy or duplicate-rate spike;
- callback signature failures;
- raw-object cleanup beyond the explicit-delete SLO;
- grading queue age beyond the pilot SLO;
- dance qualification reaching an `either` campaign.

The last condition is a hard semantic invariant and should have a database/test guard plus runtime
telemetry.

## Migration and implementation surface

### Gate 1 fleet migration prerequisite

The community-shard schema is not currently protected by an authoritative multi-pool migration
ledger, and production fleet ledger state is known to drift. Before reward-enabling dance code is
scheduled, choose and approve one of these paths:

1. make the reviewed multi-pool ledger and migration runner authoritative for the complete fleet;
   or
2. publish a one-time operator-run protocol using supported migration tooling, with a manifest of
   every target shard, per-shard migration evidence, retry/resume behavior, and a full-fleet
   read-only schema scan proving the constraint before code rollout.

Raw production database writes are not an approved substitute. The community outbox CHECK must be
verified across the complete fleet before code can emit `dance`. The remaining Gate 1 change set is
indivisible: widen the activity guards, freeze all three legacy `either` predicates to
`study|karaoke`, and add the dance score/calibration gate together. A partial deployment must fail
closed, and `terms_version` must not be treated as an activity-resolution mechanism.

### Community template

- Add an ungated migration for `dance_attempts`.
- Add `dance_pass_count` to `song_engagement_days`.
- Rebuild or replace the `reward_qualification_outbox` activity constraint to include `dance`.
- Update study and karaoke engagement upserts to preserve dance qualification.
- Add the dance attempt finalizer and outbox emitter.
- Regenerate the community schema snapshot.
- Update schema requirements and staging/production attestation expectations.

### Control plane

- Add choreography, revision, session, fingerprint, and per-activity campaign-term tables.
- Extend qualification event and qualification-basis constraints with `dance`.
- Extend campaign eligible activity with `dance` while preserving legacy `either` semantics in
  every query.
- Backfill karaoke activity terms from existing campaign rows.
- Add required indexes, read-only grants, and cleanup selection indexes.

### Application and contracts

- Add dance resources, routes, serializers, and bounded parsers.
- Add grading dispatch, callback verification, finalization, and cleanup services.
- Extend reward activity unions and reconciler score extraction.
- Branch campaign prerequisite validation explicitly by activity.
- Update public reward offers and campaign capabilities.
- Add the core-first `/reward-opportunities` source contract and regenerate all derived contracts.
- Update source contracts and regenerate OpenAPI/contracts output; do not hand-edit generated files.
- Add operator diagnostics for attempt, job, fingerprint decision, and cleanup state without media
  access.

## Test plan

### Scorer unit and fixture tests

- reference self-match;
- honest attempt;
- exact and transcoded reference replay;
- 250, 500, 800, and 1500 ms global offsets;
- allowed and strict mirror behavior;
- first-second-only and other truncated attempts;
- still pose, reversed frames, and shuffled frames;
- unrelated dance and random movement;
- visibility zero and partial occlusion;
- missing-pose gaps;
- multiple people;
- aspect-ratio, rotation metadata, and resolution changes;
- modest speed-up and slowdown;
- deterministic result for identical versioned input;
- no NaN, infinity, or out-of-range basis points.

### API and storage tests

- session idempotency and ownership;
- Telegram callback/button idempotency and one-active-session enforcement;
- Telegram sender, private-chat, and reply-to-prompt binding;
- forwarded-message rejection for reward-bearing attempts;
- hosted Bot API file-size preflight and streaming byte-ceiling enforcement;
- `video` and video `document` ingestion, probing, and normalization;
- `file_unique_id` exact-replay signal without treating it as the sole duplicate check;
- randomized start-cue assignment, persistence, verification, and score-window exclusion;
- `/cancel`, expiry, retry-slot release, and reason-code-to-message mapping;
- Telegram result-delivery failure leaves the durable terminal attempt readable;
- upload expiry and object-key isolation;
- submit verifies observed size/hash;
- MIME spoof and invalid codec rejection;
- one logical dispatch under concurrent submits;
- callback HMAC, clock window, body digest, and attempt binding;
- identical callback replay succeeds idempotently;
- conflicting terminal callback fails;
- explicit deletion on every terminal outcome;
- cleanup retry and one-day lifecycle configuration assertion;
- logs and public responses contain no signed URL or object key.

### Reward tests

- dance outbox event contains pinned server-owned evidence;
- below-platform-floor attempt emits no event;
- dance campaign applies its dance score floor;
- missing dance activity term fails closed;
- legacy `either` matches study and karaoke but never dance;
- dance-only campaign never credits study or karaoke;
- campaign creation requires a ready compatible choreography;
- timed karaoke-line validation is not applied to dance;
- study, karaoke, and dance on one song/day produce one paid practice-day claim;
- duplicate callback and duplicate outbox ingestion cannot double pay;
- unique-human verification remains required before credit;
- contracts/read models serialize `qualification_basis = 'dance'`;
- backfilled karaoke activity terms equal the legacy campaign `min_score_bps` for every existing
  `karaoke` and `either` campaign;
- historical `both` and `either` rows remain readable.

### Privacy and operational tests

- no raw video or landmarks persist in shard/control databases;
- terminal objects are explicitly deleted;
- abandoned uploads expire under the configured lifecycle rule;
- cleanup backlog alarms on overdue objects;
- grader temporary files are removed after success, rejection, timeout, and process restart;
- fingerprint expiry deletes the replay projection without corrupting reward evidence.

## Rollout gates

The gate labels describe dependency order. The staff-only Telegram ingestion surface is intentionally
built before calibration admission because the production delivery path defines the calibration
input distribution.

### Gate 0A: offline scorer discrimination

- adversarial fixture suite passes;
- low visibility never increases a score;
- incomplete coverage cannot pass;
- shuffled/reversed motion is separated from honest attempts;
- scorer output is deterministic and versioned.

### Gate 0B: staff-only Telegram ingestion

While the pilot surface is dark, disabling `DANCE_CAPTURE_ENABLED` also disables participant
session/attempt reads and cancellation with a fail-closed 503. Internal grader callbacks remain
available for already-dispatched work. Before broader launch, define and implement the client
recovery policy for attempts that outlive a flag transition.

- Python tests and lint run in CI for every grader change;
- staging deployment is codified, version-tagged, configuration-checked, and rollback-documented;
- session, attempt, choreography, and cancellation reads exist before client orchestration;
- a versioned consent receipt is persisted before any participant recording, including staff
  calibration media;
- the Telegram byte/duration contract is reconciled with direct-upload limits, and every Telegram
  download requires an explicit maximum byte count;
- randomized cue assignment, persistence, verification, score-window exclusion, dance
  `scorer_version` bump, and digest/idempotency binding are implemented together;
- Telegram uses an explicit per-chat session state machine with exact sender, private-chat, and
  `reply_to_message.message_id` binding, action/revision fencing, and `file_unique_id` dedupe;
- missing dispatcher configuration fails loudly; cleanup exhaustion alerts; the bucket lifecycle
  rule provides a tested one-day backstop;
- consented-staff staging use is allowed before the broader Modal DPA/region/no-retention review is
  complete, but no non-staff recording may be collected until those privacy gates pass;
- Telegram choreography prompt and private ingestion flow available only to staff/pilot allowlist;
- grading runs with rewards disabled;
- raw deletion and lifecycle backstop verified;
- queue SLO, CPU cost, and memory measured;
- no attempt video or landmark leakage in logs/storage.

### Gate 0C: channel-matched calibration admission

- the core-first reward-opportunity contract and read model are available to all channel adapters;
- calibration and held-out recordings are collected through the production Telegram bot media
  path, with the default `video` path represented and delivery mode recorded;
- calibration artifact and thresholds are reviewed on a held-out dataset;
- no API result can be rank eligible under an unadmitted calibration.

### Gate 1: shadow qualification

- produce hypothetical qualification and duplicate outcomes without outbox emission;
- compare honest pass rate, unrelated false accepts, replay rejects, and support burden;
- freeze the first platform floor, calibration version, fingerprint policy, and compatible
  choreography revisions.

### Gate 2: capped reward pilot

- enable `DANCE_REWARDS_ENABLED` only for explicit `dance` campaigns and allowlisted posts;
- use low campaign amounts and existing unique-human verification;
- alert on every dance credit initially;
- verify no `either` campaign receives dance;
- define a kill-switch owner and rollback procedure.

### Gate 3: broader availability

- requires stable cleanup, duplicate, pass-rate, queue, cost, and dispute metrics;
- stronger liveness beyond the v1 randomized start cue remains deferred unless observed abuse
  justifies its UX and implementation cost;
- any increase in campaign value requires a new abuse-risk review.

## Acceptance criteria

V1 is complete only when:

- a creator/operator can publish a ready immutable choreography revision;
- a linked Telegram user can start a session, reply with a bounded video, receive a terminal result,
  and retry a correctable failure without a Mini App or web capture UI;
- the Telegram adapter enforces sender/prompt binding, randomized start-cue verification, hosted
  Bot API media limits, and idempotent webhook handling;
- the grader returns reproducible, calibrated basis points and bounded coaching facts;
- truncated, low-visibility, reference-copy, and duplicate attempts fail closed;
- a passing attempt updates dance engagement and emits one durable dance qualification;
- an explicit dance campaign can credit it after unique-human proof;
- legacy `either` campaigns remain study/karaoke-only;
- one user identity cannot receive separate study, karaoke, and dance practice-day rewards for the
  same song and UTC day;
- raw attempt video is explicitly deleted with observable retries and a one-day lifecycle fallback;
- no full attempt landmark sequence is durably retained;
- capture, grading, or rewards can be independently disabled without preventing cleanup.

## Deferred decisions

The following require new evidence or product scope and are not implied by v1:

- stronger active liveness beyond the randomized gross-body start cue;
- device attestation;
- group choreography;
- multiple choreographies eligible within one campaign;
- a new campaign value meaning study, karaoke, or dance;
- independent per-activity daily rewards;
- long-lived user replay/coaching video;
- human review of raw attempts;
- training or fine-tuning on user videos or landmarks;
- GPU/RunPod deployment;
- creator-configurable scoring weights.
