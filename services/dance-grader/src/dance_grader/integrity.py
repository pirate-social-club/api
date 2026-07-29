from __future__ import annotations

import hashlib

import numpy as np

from .features import SCORED_LANDMARKS, _normalized_geometry, mirror_landmarks
from .models import PoseSequence, ScorerConfig


def _unordered_pose_digest(
    sequence: PoseSequence,
    config: ScorerConfig,
    *,
    mirrored: bool = False,
) -> str:
    """Detect exact reference-feature reuse even when frames are reordered.

    This is intentionally an exact Gate-0 check. A calibrated near-copy detector and video-level
    perceptual check are still required before rollout.
    """
    rows = []
    for frame in sequence.frames:
        if frame.landmarks is None:
            rows.append(b"missing")
            continue
        landmarks = mirror_landmarks(frame.landmarks) if mirrored else frame.landmarks
        geometry = _normalized_geometry(landmarks, sequence.width, sequence.height)
        if geometry is None:
            rows.append(b"invalid")
            continue
        quantized = np.rint(geometry[SCORED_LANDMARKS] * 100_000).astype(np.int64)
        rows.append(quantized.tobytes())
    ordered_rows = sorted(rows)
    digest = hashlib.sha256()
    for row in ordered_rows:
        digest.update(row)
    return digest.hexdigest()


def is_exact_reference_feature_replay(
    reference: PoseSequence,
    attempt: PoseSequence,
    config: ScorerConfig,
) -> bool:
    if len(reference.frames) != len(attempt.frames):
        return False
    reference_digest = _unordered_pose_digest(reference, config)
    return reference_digest in {
        _unordered_pose_digest(attempt, config),
        _unordered_pose_digest(attempt, config, mirrored=True),
    }
