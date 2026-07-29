from __future__ import annotations

from dataclasses import dataclass

import numpy as np

from .features import FeatureSequence
from .models import AlignmentMetrics, ScorerConfig


@dataclass(frozen=True)
class Alignment:
    reference_indices: np.ndarray
    attempt_indices: np.ndarray
    metrics: AlignmentMetrics


def _weighted_mean(values: np.ndarray, weights: np.ndarray) -> float | None:
    valid = np.isfinite(values) & (weights > 0)
    denominator = float(np.sum(weights[valid]))
    if denominator <= 1e-8:
        return None
    return float(np.sum(values[valid] * weights[valid]) / denominator)


def find_global_alignment(
    reference: FeatureSequence,
    attempt: FeatureSequence,
    config: ScorerConfig,
) -> Alignment | None:
    max_offset = round(config.max_global_offset_sec * config.target_fps)
    best: tuple[float, int, np.ndarray, np.ndarray] | None = None

    for offset in range(-max_offset, max_offset + 1):
        ref_start = max(0, -offset)
        attempt_start = max(0, offset)
        count = min(len(reference.times) - ref_start, len(attempt.times) - attempt_start)
        if count <= 1:
            continue
        ref_indices = np.arange(ref_start, ref_start + count)
        attempt_indices = np.arange(attempt_start, attempt_start + count)
        overlap = count / max(len(reference.times), len(attempt.times))
        if overlap < config.min_alignment_overlap:
            continue

        ref_angles = reference.angles[ref_indices]
        attempt_angles = attempt.angles[attempt_indices]
        confidence = np.minimum(
            reference.angle_confidence[ref_indices],
            attempt.angle_confidence[attempt_indices],
        )
        confidence *= reference.usable[ref_indices, None]
        confidence *= attempt.usable[attempt_indices, None]
        angle_error = _weighted_mean(np.abs(ref_angles - attempt_angles) / 90.0, confidence)
        if angle_error is None:
            continue

        ref_energy = np.linalg.norm(reference.velocity[ref_indices], axis=2)
        attempt_energy = np.linalg.norm(attempt.velocity[attempt_indices], axis=2)
        energy_confidence = np.minimum(
            reference.velocity_confidence[ref_indices],
            attempt.velocity_confidence[attempt_indices],
        )
        energy_error = _weighted_mean(
            np.abs(ref_energy - attempt_energy) / (np.abs(ref_energy) + 0.15),
            energy_confidence,
        )
        if energy_error is None:
            energy_error = 1.0

        cost = 0.75 * angle_error + 0.25 * min(energy_error, 2.0) + (1.0 - overlap)
        candidate = (cost, offset, ref_indices, attempt_indices)
        if best is None or candidate[0] < best[0]:
            best = candidate

    if best is None:
        return None
    _, offset, ref_indices, attempt_indices = best
    overlap = len(ref_indices) / max(len(reference.times), len(attempt.times))
    unmatched = 1.0 - overlap
    offset_sec = offset / config.target_fps
    timing = max(0.0, 1.0 - abs(offset_sec) / max(config.max_global_offset_sec, 1e-8))
    timing *= overlap
    return Alignment(
        reference_indices=ref_indices,
        attempt_indices=attempt_indices,
        metrics=AlignmentMetrics(
            global_offset_ms=round(offset_sec * 1000),
            overlap_bps=round(overlap * 10_000),
            total_warp_bps=0,
            unmatched_coverage_bps=round(unmatched * 10_000),
            timing_score_bps=round(timing * 10_000),
        ),
    )
