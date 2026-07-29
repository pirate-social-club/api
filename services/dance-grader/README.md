# Pirate dance grader

This package is the platform-independent Gate-0 scoring core described by the dance reward
qualification spec. It consumes pose JSON, not video. MediaPipe extraction and the thin Modal
entry point are intentionally deferred until the scorer's adversarial tests and calibration gates
pass.

The repository corpus is generated deterministically in `tests/conftest.py`; it contains no
personal video or captured landmarks. It covers honest noise, global delay, moderate tempo changes,
stillness, truncation, missing detections, zero visibility, mirroring, reference-frame reordering,
and near-reference jitter.

The default calibration is explicitly provisional. It produces stable basis-point-shaped output
for corpus analysis, but `calibration_admitted` is false and must never authorize a reward.

The production runtime extra pins MediaPipe and PyAV. The Pose Landmarker model is not committed;
`models/pose_landmarker_full_float16_v1.json` pins its immutable download URL, byte length, and
SHA-256. Runtime construction verifies that checksum before importing MediaPipe.

Run the focused suite:

```bash
python -m pytest -q
```

Evaluate saved pose JSON:

```bash
PYTHONPATH=src python scripts/evaluate_corpus.py \
  --reference /path/to/reference_pose.json \
  --attempt honest=/path/to/attempt_pose.json
```

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
