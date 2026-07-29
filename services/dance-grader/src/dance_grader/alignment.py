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


def _local_cost(
    reference: FeatureSequence,
    attempt: FeatureSequence,
    ref_index: int,
    attempt_index: int,
) -> float:
    angle_confidence = np.minimum(
        reference.angle_confidence[ref_index],
        attempt.angle_confidence[attempt_index],
    )
    angle_error = _weighted_mean(
        np.abs(reference.angles[ref_index] - attempt.angles[attempt_index]) / 60.0,
        angle_confidence,
    )
    position_confidence = np.minimum(
        reference.position_confidence[ref_index],
        attempt.position_confidence[attempt_index],
    )
    position_error = _weighted_mean(
        np.linalg.norm(
            reference.positions[ref_index] - attempt.positions[attempt_index],
            axis=1,
        ),
        position_confidence,
    )
    if angle_error is None or position_error is None:
        return 5.0
    return 0.7 * min(angle_error, 3.0) + 0.3 * min(position_error, 3.0)


def find_constrained_alignment(
    reference: FeatureSequence,
    attempt: FeatureSequence,
    config: ScorerConfig,
) -> Alignment | None:
    ref_count = len(reference.times)
    attempt_count = len(attempt.times)
    if ref_count < 2 or attempt_count < 2:
        return None

    band = max(1, round(config.dtw_band_sec * config.target_fps))
    max_edge = max(1, round(config.max_global_offset_sec * config.target_fps))
    costs = np.full((ref_count, attempt_count), np.inf)
    previous_i = np.full((ref_count, attempt_count), -1, dtype=np.int32)
    previous_j = np.full((ref_count, attempt_count), -1, dtype=np.int32)
    warp_steps = np.zeros((ref_count, attempt_count), dtype=np.int32)

    for ref_index in range(ref_count):
        expected_attempt = ref_index * (attempt_count - 1) / max(ref_count - 1, 1)
        attempt_min = max(0, int(np.floor(expected_attempt - band)))
        attempt_max = min(attempt_count, int(np.ceil(expected_attempt + band)) + 1)
        for attempt_index in range(attempt_min, attempt_max):
            local = _local_cost(reference, attempt, ref_index, attempt_index)
            candidates: list[tuple[float, int, int, int]] = []
            if ref_index == 0 and attempt_index <= max_edge:
                candidates.append(
                    (
                        attempt_index * config.dtw_unmatched_penalty + local,
                        -1,
                        -1,
                        0,
                    )
                )
            if attempt_index == 0 and ref_index <= max_edge:
                candidates.append(
                    (
                        ref_index * config.dtw_unmatched_penalty + local,
                        -1,
                        -1,
                        0,
                    )
                )
            if ref_index > 0 and attempt_index > 0:
                candidates.append(
                    (
                        costs[ref_index - 1, attempt_index - 1] + local,
                        ref_index - 1,
                        attempt_index - 1,
                        warp_steps[ref_index - 1, attempt_index - 1],
                    )
                )
            if ref_index > 0 and attempt_index > 1:
                candidates.append(
                    (
                        costs[ref_index - 1, attempt_index - 2]
                        + 1.5 * local
                        + config.dtw_warp_penalty,
                        ref_index - 1,
                        attempt_index - 2,
                        warp_steps[ref_index - 1, attempt_index - 2] + 1,
                    )
                )
            if ref_index > 1 and attempt_index > 0:
                candidates.append(
                    (
                        costs[ref_index - 2, attempt_index - 1]
                        + 1.5 * local
                        + config.dtw_warp_penalty,
                        ref_index - 2,
                        attempt_index - 1,
                        warp_steps[ref_index - 2, attempt_index - 1] + 1,
                    )
                )
            finite = [candidate for candidate in candidates if np.isfinite(candidate[0])]
            if not finite:
                continue
            prior_cost, prior_i, prior_j, prior_warp = min(finite, key=lambda value: value[0])
            costs[ref_index, attempt_index] = prior_cost
            previous_i[ref_index, attempt_index] = prior_i
            previous_j[ref_index, attempt_index] = prior_j
            warp_steps[ref_index, attempt_index] = prior_warp

    endings: list[tuple[float, int, int]] = []
    for ref_index in range(max(0, ref_count - max_edge - 1), ref_count):
        attempt_index = attempt_count - 1
        tail = ref_count - 1 - ref_index
        endings.append(
            (
                costs[ref_index, attempt_index] + tail * config.dtw_unmatched_penalty,
                ref_index,
                attempt_index,
            )
        )
    for attempt_index in range(max(0, attempt_count - max_edge - 1), attempt_count):
        ref_index = ref_count - 1
        tail = attempt_count - 1 - attempt_index
        endings.append(
            (
                costs[ref_index, attempt_index] + tail * config.dtw_unmatched_penalty,
                ref_index,
                attempt_index,
            )
        )
    finite_endings = [ending for ending in endings if np.isfinite(ending[0])]
    if not finite_endings:
        return None
    _, ref_index, attempt_index = min(finite_endings, key=lambda value: value[0])

    path: list[tuple[int, int]] = []
    while ref_index >= 0 and attempt_index >= 0:
        path.append((ref_index, attempt_index))
        next_i = int(previous_i[ref_index, attempt_index])
        next_j = int(previous_j[ref_index, attempt_index])
        ref_index, attempt_index = next_i, next_j
    path.reverse()
    ref_indices = np.asarray([pair[0] for pair in path], dtype=np.int32)
    attempt_indices = np.asarray([pair[1] for pair in path], dtype=np.int32)

    matched_ref = len(np.unique(ref_indices))
    matched_attempt = len(np.unique(attempt_indices))
    coverage = min(matched_ref / ref_count, matched_attempt / attempt_count)
    if coverage < config.min_alignment_overlap:
        return None
    unmatched = 1.0 - coverage
    ref_progress = ref_indices / max(ref_count - 1, 1)
    attempt_progress = attempt_indices / max(attempt_count - 1, 1)
    progress_warp = float(np.mean(np.abs(ref_progress - attempt_progress)))
    offset_frames = float(
        np.median(attempt_indices - ref_indices * attempt_count / max(ref_count, 1))
    )
    offset_sec = offset_frames / config.target_fps
    end_ref_index, end_attempt_index = path[-1]
    warp_fraction = int(warp_steps[end_ref_index, end_attempt_index]) / max(len(path), 1)
    total_warp = min(1.0, progress_warp + warp_fraction)
    timing = max(0.0, 1.0 - abs(offset_sec) / max(config.max_global_offset_sec, 1e-8))
    timing *= max(0.0, 1.0 - progress_warp - warp_fraction - unmatched)
    return Alignment(
        reference_indices=ref_indices,
        attempt_indices=attempt_indices,
        metrics=AlignmentMetrics(
            global_offset_ms=round(offset_sec * 1000),
            overlap_bps=round(coverage * 10_000),
            total_warp_bps=round(total_warp * 10_000),
            unmatched_coverage_bps=round(unmatched * 10_000),
            timing_score_bps=round(timing * 10_000),
        ),
    )


def find_global_alignment(
    reference: FeatureSequence,
    attempt: FeatureSequence,
    config: ScorerConfig,
) -> Alignment | None:
    """Compatibility name retained during Gate 0; alignment is now constrained DTW."""
    return find_constrained_alignment(reference, attempt, config)
