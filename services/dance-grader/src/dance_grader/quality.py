from __future__ import annotations

import numpy as np

from .features import SCORED_LANDMARKS
from .models import PoseSequence, QualityMetrics, ScorerConfig


def _bps(value: float) -> int:
    return round(np.clip(value, 0.0, 1.0) * 10_000)


def assess_quality(
    reference: PoseSequence,
    attempt: PoseSequence,
    config: ScorerConfig,
) -> QualityMetrics:
    return assess_attempt_quality(reference.duration_sec, attempt, config)


def assess_attempt_quality(
    reference_duration_sec: float,
    attempt: PoseSequence,
    config: ScorerConfig,
) -> QualityMetrics:
    duration_ratio = attempt.duration_sec / reference_duration_sec
    detected = np.asarray([frame.landmarks is not None for frame in attempt.frames])
    pose_presence = float(np.mean(detected))

    usable: list[bool] = []
    missing_gap = 0.0
    current_gap = 0.0
    previous_time = attempt.frames[0].time_sec
    for frame in attempt.frames:
        step = max(0.0, frame.time_sec - previous_time)
        previous_time = frame.time_sec
        if frame.landmarks is None:
            current_gap += step if step else 1.0 / attempt.fps
            missing_gap = max(missing_gap, current_gap)
            usable.append(False)
            continue
        current_gap = 0.0
        confidence = np.clip(frame.landmarks[SCORED_LANDMARKS, 3], 0.0, 1.0)
        usable.append(
            float(np.mean(confidence >= config.min_joint_visibility))
            >= config.min_visible_joint_fraction
        )

    usable_coverage = float(np.mean(usable))
    values = {
        "duration_ratio_bps": round(duration_ratio * 10_000),
        "pose_detection_bps": _bps(pose_presence),
        "usable_coverage_bps": _bps(usable_coverage),
        "max_missing_gap_ms": round(missing_gap * 1000),
    }
    if not config.min_duration_ratio <= duration_ratio <= config.max_duration_ratio:
        return QualityMetrics("rejected", "duration_out_of_range", **values)
    if pose_presence < config.min_pose_presence:
        return QualityMetrics("rejected", "insufficient_pose_presence", **values)
    if missing_gap > config.max_missing_gap_sec:
        return QualityMetrics("rejected", "insufficient_pose_presence", **values)
    if usable_coverage < config.min_usable_coverage:
        return QualityMetrics("rejected", "insufficient_coverage", **values)
    return QualityMetrics("passed", None, **values)
