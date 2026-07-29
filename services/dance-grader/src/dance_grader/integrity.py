from __future__ import annotations

import hashlib

import numpy as np

from .features import (
    SCORED_LANDMARKS,
    FeatureSequence,
    _normalized_geometry,
    build_features,
    mirror_landmarks,
)
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


def is_near_reference_feature_replay(
    reference: PoseSequence,
    attempt: PoseSequence,
    config: ScorerConfig,
) -> bool:
    """Conservatively reject near-identical canonical or mirrored feature sequences."""
    reference_features = build_features(reference, config)
    if abs(len(reference_features.times) - round(attempt.duration_sec * config.target_fps)) > 1:
        return False

    for mirrored in (False, True):
        attempt_features = build_features(attempt, config, mirrored=mirrored)
        if reference_features.positions.shape != attempt_features.positions.shape:
            continue
        difference = reference_features.positions - attempt_features.positions
        confidence = np.minimum(
            reference_features.position_confidence,
            attempt_features.position_confidence,
        )
        valid = np.isfinite(difference).all(axis=2) & (confidence > 0)
        if not np.any(valid):
            continue
        squared_distance = np.sum(np.square(difference), axis=2)
        rmse = float(
            np.sqrt(np.sum(squared_distance[valid] * confidence[valid]) / np.sum(confidence[valid]))
        )
        if rmse <= config.max_reference_replay_position_rmse:
            return True
    return False


def is_post_alignment_reference_replay(
    reference: FeatureSequence,
    attempt: FeatureSequence,
    reference_indices: np.ndarray,
    attempt_indices: np.ndarray,
    config: ScorerConfig,
) -> bool:
    """Reject near-identical reference geometry after constrained tempo alignment."""
    difference = reference.positions[reference_indices] - attempt.positions[attempt_indices]
    confidence = np.minimum(
        reference.position_confidence[reference_indices],
        attempt.position_confidence[attempt_indices],
    )
    valid = np.isfinite(difference).all(axis=2) & (confidence > 0)
    if not np.any(valid):
        return False
    squared_distance = np.sum(np.square(difference), axis=2)
    residual_rmse = float(
        np.sqrt(np.sum(squared_distance[valid] * confidence[valid]) / np.sum(confidence[valid]))
    )
    return residual_rmse <= config.max_reference_replay_position_rmse
