# Pirate dance grader

This package is the platform-independent Gate-0 scoring core described by the dance reward
qualification spec. Its scoring core consumes pose JSON; the package also contains pinned
MediaPipe Tasks extraction and a thin Modal entry point.

The repository corpus is generated deterministically in `tests/conftest.py`; it contains no
personal video or captured landmarks. It covers human-like joint and body-proportion variation,
global delay, moderate tempo changes, stillness, truncation, missing detections, zero visibility,
mirroring, reference-frame reordering, near-reference jitter, and discrete frame-drop/duplication
tempo replays.

The default calibration is explicitly provisional. It produces stable basis-point-shaped output
for corpus analysis, but `calibration_admitted` is false and must never authorize a reward.

The production runtime extra pins MediaPipe and PyAV. The Pose Landmarker model is not committed;
`models/pose_landmarker_full_float16_v1.json` pins its immutable download URL, byte length, and
SHA-256. Runtime construction verifies that checksum before importing MediaPipe.

Run the focused suite:

```bash
rtk uv sync --frozen --extra dev
rtk uv run ruff check .
rtk uv run ruff format --check .
rtk uv run pytest -q
```

Evaluate saved pose JSON:

```bash
PYTHONPATH=src python scripts/evaluate_corpus.py \
  --reference /path/to/reference_pose.json \
  --attempt honest=/path/to/attempt_pose.json
```

## Local calibration-corpus extraction

Install the `runtime` extra, download the model named by
`models/pose_landmarker_full_float16_v1.json`, and extract each consented recording locally:

```bash
PYTHONPATH=src python scripts/extract_local_video.py \
  --video /private/corpus/attempt-01.mp4 \
  --model /private/models/pose_landmarker_full.task \
  --pose-output /private/corpus/features/attempt-01.pose.json \
  --report-output /private/corpus/reports/attempt-01.json
```

For the reference recording, also pass
`--reference-artifact-output /private/corpus/reference-features.json`. The command verifies the
pinned model, applies the same quality gates as Modal, writes outputs atomically with mode `0600`,
and records content hashes and runtime versions. Pose JSON is sensitive motion data: keep the
corpus directory private, consented, access-controlled, and outside Git. The command performs no
network upload.

## Modal app

`modal_app.py` defines authenticated asynchronous dispatch endpoints backed by
`extract_reference_features` and `grade_attempt` functions. The functions use presigned
single-object GET/PUT URLs, verify every content and version binding, sign callbacks, and remove
temporary media before callback delivery.

Deploy staging and production into separate Modal Environments. Each environment requires a
`dance-grader-service` secret containing:

- `DANCE_GRADER_DISPATCH_HMAC_KEY`
- `DANCE_GRADER_DISPATCH_KEY_VERSION`
- `DANCE_GRADER_CALLBACK_HMAC_KEY`
- `DANCE_GRADER_CALLBACK_KEY_VERSION`

The app must not be deployed beyond consented staff until the Modal subprocessor/DPA, region,
no-media-retention, and log-content privacy gates in the approved spec pass.

### Staging deployment

Staging deployment is manual-dispatch only through
`.github/workflows/dance-grader-staging-deploy.yml`. The workflow installs the locked dependencies,
runs lint and tests, verifies that the staging `dance-grader-service` secret exists and contains all
four required keys, deploys with the source commit as its Modal tag, and records deployment history.
It cannot target production.

Prerequisites:

- the GitHub `staging` environment has `MODAL_TOKEN_ID` and `MODAL_TOKEN_SECRET` for a service user
  limited to the Modal staging environment;
- the Modal `staging` environment exists;
- its `dance-grader-service` secret contains the four keys listed above;
- a consent receipt has been recorded before any staff recording is stored or dispatched.

The same guarded deploy may be run locally from this directory:

```bash
export DANCE_GRADER_DEPLOY_TAG=<full-source-commit-sha>
rtk ./scripts/deploy_staging.sh
```

Verify the deployed revision without invoking a grading job:

```bash
rtk uv run modal app history --env staging pirate-dance-grader
rtk uv run modal run --env staging modal_app.py::validate_service_configuration
```

Rollback is an explicit operator action. Inspect history, select the previously verified version,
and then run:

```bash
rtk uv run modal app rollback --env staging pirate-dance-grader <version>
```

After rollback, repeat the history and configuration checks. Do not use this workflow or script for
production. Endpoint-to-API smoke verification is added with the Gate 0B dispatcher wiring; there
is no staging API dispatch surface to probe yet.
