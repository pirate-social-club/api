# Dance reward qualification v1

Status: approved v1 design baseline. Implementation and accrual must remain dark until the
acceptance gates in this document pass. This document does not authorize production rewards.

## Decision summary

Pirate will add `dance` as a third way to earn a song-practice reward. A rewarded dance attempt
compares a server-extracted pose sequence from an in-app recording with a versioned reference
choreography. A passing attempt emits the same durable reward qualification event used by study and
karaoke.

V1 fixes the following product decisions:

- `dance` is an explicit campaign activity.
- Existing `either` campaign terms remain frozen as `study OR karaoke`. Adding `dance` must not
  expand already-funded campaigns.
- A user may earn at most one `campaign_practice_day` reward for a song post and UTC day across
  study, karaoke, and dance.
- Rewarded attempts use in-app recording. Arbitrary uploads may be supported later for unrewarded
  coaching, but cannot qualify for money in v1.
- V1 does not require a randomized pre-roll gesture, audio nonce, palm scan, or other active
  liveness challenge.
- Replay controls are reference-copy rejection, exact and near-duplicate fingerprints, session
  binding, and the existing credit-time unique-human proof.
- Raw attempt video is stored only in a private ephemeral object bucket. The grader explicitly
  deletes it after a terminal result. A one-day object-lifecycle rule is a failure backstop, not the
  primary deletion mechanism.
- Full landmark sequences are not retained by default.
- Reference choreography is a versioned first-class resource. It is not only a new song artifact
  kind or a mutable field on the song post.
- Dance scoring and campaign qualification use integer basis points from `0` through `10000`.
- Dance score terms are versioned independently from karaoke score terms.
- The first production worker is a CPU Cloudflare Container (`standard-2`) behind the repository's
  existing Worker-wrapper container pattern, unless a measured benchmark justifies GPU/RunPod or a
  separately managed VPS.

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

## Terminology

- **Choreography:** the logical dance attached to a song post.
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
  -> create dance session
  -> direct upload to private attempt bucket
  -> submit session
  -> dedicated dance grading queue
  -> grader fetches one object with a short-lived signed GET
  -> grader validates, extracts, aligns, scores, and fingerprints
  -> grader sends authenticated idempotent callback
  -> API finalizes shard attempt and optional reward outbox event in one transaction
  -> API records the control-plane projection
  -> API explicitly deletes raw video and retries cleanup until confirmed
  -> client polls the attempt resource
```

The shared `community_jobs` lane is not used for grading. Dance receives a dedicated queue or
equivalent worker lane so unrelated community work cannot create multi-minute or multi-hour grading
latency.

## Resource and data model

### Control-plane choreography tables

Create `dance_choreographies`:

- `dance_choreography_id TEXT PRIMARY KEY`;
- `community_id TEXT NOT NULL`;
- `post_id TEXT NOT NULL`;
- `song_artifact_bundle_id TEXT NOT NULL`;
- `creator_user_id TEXT NOT NULL`;
- `status TEXT NOT NULL` in `draft`, `processing`, `ready`, `disabled`, `failed`;
- `active_revision_id TEXT`;
- `created_at`, `updated_at`;
- unique live-name or creator idempotency constraints as required by the creation route.

Create `dance_choreography_revisions`:

- `dance_choreography_revision_id TEXT PRIMARY KEY`;
- `dance_choreography_id TEXT NOT NULL`;
- positive `revision_number`;
- immutable `reference_storage_ref`;
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

## Public API

New public resources follow the repository's resource conventions: canonical `id` and `object`
fields, Unix-second timestamps, expandable reference fields without `_id` suffixes, and no generic
public `updated_at`.

### Choreography reads

- `GET /posts/{post}/dance_choreography`
- `GET /dance_choreographies/{id}`

A public choreography response exposes the active ready revision, mirror policy, reference playback
resource, expected duration, and availability. It does not expose derived feature storage.

Choreography reads, session creation, and attempt polling all reach the control plane, whose
connection budget is already constrained (scheduled-job concurrency is capped for that reason). The
public choreography read path must be cacheable, polling intervals must be generous, and a cached or
shard-side read model is required before broad availability.

Creation and revision activation are creator/operator surfaces and require a separate route review.
They are not required for the first fixed-reference pilot.

### Create a dance session

`POST /dance_sessions`

Request:

```json
{
  "post": "post_...",
  "idempotency_key": "client-generated"
}
```

The API authenticates the user, resolves the song and ready active choreography revision, checks
feature readiness and rollout flags, creates the attempt/session, and returns:

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
    "max_bytes": 67108864,
    "expires_at": 1780000000
  },
  "expires_at": 1780000000,
  "created": 1779999000
}
```

The signed upload authorizes one object key and MIME type. Object size, actual codec, duration, and
decodability are verified after upload; request headers are not trusted as content validation.

### Submit a session

`POST /dance_sessions/{id}/submit`

Request:

```json
{
  "content_sha256": "64-lowercase-hex",
  "capture_mode": "in_app_camera"
}
```

Submit is an idempotent custom action. The API verifies object existence, bounds, observed metadata,
session ownership, expiry, and hash before moving the session to `submitted` and dispatching exactly
one logical grading job.

`capture_mode` is an auditable product assertion, not a cryptographic liveness proof. V1 does not
claim otherwise.

### Read status

- `GET /dance_sessions/{id}`
- `GET /dance_attempts/{id}`

The attempt resource returns status, score when available, user-facing quality/integrity reason,
aggregate coaching dimensions, and whether the attempt was reward eligible. It never returns the raw
video or fingerprint hashes.

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

The current outbox uniqueness of `(user_id, post_id, activity, reward_period_key)` remains. Multiple
passing dance attempts on one UTC day therefore produce at most one dance qualification event.

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
- Repeated integrity failures can disable rewarded dance for the account pending review.

Near-duplicate thresholds must be calibrated against honest people performing the same choreography.
A low-confidence similarity is not enough to accuse or reject. Fail closed for rewards only when the
policy reaches its calibrated duplicate threshold; otherwise retain a bounded risk flag for
observability.

### Explicitly deferred controls

- randomized gesture or audio challenge;
- device attestation;
- palm or face liveness;
- continuous camera-frame attestation;
- manual video review;
- cross-platform biometric identity matching.

These remain escalation options if campaign value, duplicate rate, or observed organized farming
exceeds v1 risk limits.

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

- `standard-2` versus `standard-3` instance types;
- 15 and 30 sampled frames per second;
- supported input resolutions and codecs;
- 15, 30, and 60 second clips;
- one through several concurrent workers;
- decode, inference, alignment, and callback time separately;
- peak resident memory and temporary disk;
- cold and warm reference-feature cache.

Run v1 on Cloudflare Containers, reusing the existing Worker-wrapper pattern from
`services/song-preview-container` and `services/zkpassport-verifier-container`: a
`services/dance-grader-container` package with a Worker wrapper, a dedicated queue
(`DANCE_GRADING_QUEUE`, batch size 1, initial concurrency 1), and a private per-environment R2
attempts bucket. The first benchmark target is one `standard-2` instance (1 vCPU, 6 GiB memory,
12 GB disk) with `max_instances: 2` in staging. Queue delivery is at-least-once, so
`dance_attempt_id` remains the idempotency key through dispatch and callback.

The container image must handle SIGTERM correctly as PID 1 (init shim or explicit signal handling):
a prior container in this repository never reached sleep because its runtime ignored SIGTERM, which
silently defeats scale-to-zero and bills allocated memory continuously.

Move to RunPod or another GPU/burst platform only when a real benchmark shows a material end-to-end
price or backlog-latency advantage. Use a separately managed VPS only if MediaPipe compatibility or
container cold starts prove problematic; neither is assumed upfront. GPU availability alone is not
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

### Gate 0: scorer discrimination

Required before API integration can emit rank-eligible results:

- adversarial fixture suite passes;
- low visibility never increases a score;
- incomplete coverage cannot pass;
- shuffled/reversed motion is separated from honest attempts;
- calibration artifact and thresholds are reviewed on a held-out dataset;
- scorer output is deterministic and versioned.

### Gate 1: dark grading

- choreography and private upload flow available only to staff/pilot allowlist;
- grading runs with rewards disabled;
- raw deletion and lifecycle backstop verified;
- queue SLO, CPU cost, and memory measured;
- no attempt video or landmark leakage in logs/storage.

### Gate 2: shadow qualification

- produce hypothetical qualification and duplicate outcomes without outbox emission;
- compare honest pass rate, unrelated false accepts, replay rejects, and support burden;
- freeze the first platform floor, calibration version, fingerprint policy, and compatible
  choreography revisions.

### Gate 3: capped reward pilot

- enable `DANCE_REWARDS_ENABLED` only for explicit `dance` campaigns and allowlisted posts;
- use low campaign amounts and existing unique-human verification;
- alert on every dance credit initially;
- verify no `either` campaign receives dance;
- define a kill-switch owner and rollback procedure.

### Gate 4: broader availability

- requires stable cleanup, duplicate, pass-rate, queue, cost, and dispute metrics;
- active liveness remains deferred unless observed abuse justifies its UX and implementation cost;
- any increase in campaign value requires a new abuse-risk review.

## Acceptance criteria

V1 is complete only when:

- a creator/operator can publish a ready immutable choreography revision;
- an authenticated user can record, upload, submit, and read one dance attempt;
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

- active liveness challenges;
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
