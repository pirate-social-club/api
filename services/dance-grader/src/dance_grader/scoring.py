from __future__ import annotations

import numpy as np

from .alignment import Alignment, find_global_alignment
from .calibration import CalibrationArtifact, provisional_calibration
from .features import FeatureSequence, build_features
from .fingerprint import canonical_fingerprint_material
from .integrity import (
    is_exact_reference_feature_replay,
    is_near_reference_feature_replay,
    is_post_alignment_reference_replay,
)
from .models import (
    AlignmentMetrics,
    ComponentScores,
    GradeResult,
    MirrorPolicy,
    PoseSequence,
    ScorerConfig,
)
from .quality import assess_quality


def _similarity(error: np.ndarray, confidence: np.ndarray, scale: float) -> float:
    valid = np.isfinite(error) & (confidence > 0)
    denominator = float(np.sum(confidence[valid]))
    if denominator <= 1e-8:
        return 0.0
    local = np.exp(-np.square(error[valid] / scale))
    return float(np.sum(local * confidence[valid]) / denominator)


def _score_variant(
    reference: FeatureSequence,
    attempt: FeatureSequence,
    alignment: Alignment,
    config: ScorerConfig,
) -> tuple[float, ComponentScores]:
    ref = alignment.reference_indices
    att = alignment.attempt_indices

    angle_confidence = np.minimum(reference.angle_confidence[ref], attempt.angle_confidence[att])
    angle_confidence *= reference.usable[ref, None]
    angle_confidence *= attempt.usable[att, None]
    angle_score = _similarity(
        np.abs(reference.angles[ref] - attempt.angles[att]),
        angle_confidence,
        35.0,
    )

    position_confidence = np.minimum(
        reference.position_confidence[ref],
        attempt.position_confidence[att],
    )
    position_confidence *= reference.usable[ref, None]
    position_confidence *= attempt.usable[att, None]
    position_error = np.linalg.norm(reference.positions[ref] - attempt.positions[att], axis=2)
    position_score = _similarity(position_error, position_confidence, 0.55)

    velocity_confidence = np.minimum(
        reference.velocity_confidence[ref],
        attempt.velocity_confidence[att],
    )
    velocity_confidence *= reference.usable[ref, None]
    velocity_confidence *= attempt.usable[att, None]
    velocity_error = np.linalg.norm(reference.velocity[ref] - attempt.velocity[att], axis=2)
    velocity_score = _similarity(velocity_error, velocity_confidence, 0.18)

    timing_score = alignment.metrics.timing_score_bps / 10_000
    raw = (
        config.angle_weight * angle_score
        + config.position_weight * position_score
        + config.velocity_weight * velocity_score
        + config.timing_weight * timing_score
    )
    raw *= alignment.metrics.overlap_bps / 10_000
    components = ComponentScores(
        angles_bps=round(angle_score * 10_000),
        positions_bps=round(position_score * 10_000),
        velocity_bps=round(velocity_score * 10_000),
        timing_bps=round(timing_score * 10_000),
        raw_similarity_bps=round(raw * 10_000),
    )
    return raw, components


def _empty_alignment() -> AlignmentMetrics:
    return AlignmentMetrics(0, 0, 0, 10_000, 0)


def _motion_energy(features: FeatureSequence) -> float:
    energy = np.linalg.norm(np.nan_to_num(features.velocity, nan=0.0), axis=2)
    confidence = features.velocity_confidence * features.usable[:, None]
    denominator = float(np.sum(confidence))
    if denominator <= 1e-8:
        return 0.0
    return float(np.sum(energy * confidence) / denominator)


def grade_dance(
    reference: PoseSequence,
    attempt: PoseSequence,
    *,
    mirror_policy: MirrorPolicy = MirrorPolicy.STRICT,
    config: ScorerConfig | None = None,
    calibration: CalibrationArtifact | None = None,
    enforce_reference_replay: bool = True,
) -> GradeResult:
    config = config or ScorerConfig()
    calibration = calibration or provisional_calibration()
    quality = assess_quality(reference, attempt, config)
    versions = {
        "scorer": config.version,
        "feature_schema": config.feature_schema_version,
        "calibration": calibration.version,
        "calibration_checksum": calibration.checksum,
        "fingerprint": config.fingerprint_version,
    }
    if quality.outcome != "passed":
        return GradeResult(
            outcome="rejected",
            reason=quality.reason,
            score_bps=None,
            calibration_admitted=calibration.admitted,
            selected_mirror="canonical",
            quality=quality,
            alignment=None,
            components=None,
            canonical_fingerprint_material_hex=None,
            versions=versions,
        )
    if enforce_reference_replay and (
        is_exact_reference_feature_replay(reference, attempt, config)
        or is_near_reference_feature_replay(reference, attempt, config)
    ):
        return GradeResult(
            outcome="rejected",
            reason="reference_replay",
            score_bps=None,
            calibration_admitted=calibration.admitted,
            selected_mirror="canonical",
            quality=quality,
            alignment=None,
            components=None,
            canonical_fingerprint_material_hex=None,
            versions=versions,
        )

    reference_features = build_features(reference, config)
    canonical_attempt_features = build_features(attempt, config)
    reference_motion = _motion_energy(reference_features)
    attempt_motion = _motion_energy(canonical_attempt_features)
    if (
        reference_motion > 1e-8
        and attempt_motion / reference_motion < config.min_motion_energy_ratio
    ):
        return GradeResult(
            outcome="rejected",
            reason="insufficient_motion",
            score_bps=None,
            calibration_admitted=calibration.admitted,
            selected_mirror="canonical",
            quality=quality,
            alignment=None,
            components=None,
            canonical_fingerprint_material_hex=None,
            versions=versions,
        )

    variants = [("canonical", canonical_attempt_features)]
    if mirror_policy == MirrorPolicy.ALLOWED:
        variants.append(("mirrored", build_features(attempt, config, mirrored=True)))

    best: tuple[float, str, FeatureSequence, Alignment, ComponentScores] | None = None
    for name, attempt_features in variants:
        alignment = find_global_alignment(reference_features, attempt_features, config)
        if alignment is None:
            continue
        raw, components = _score_variant(reference_features, attempt_features, alignment, config)
        if best is None or raw > best[0]:
            best = (raw, name, attempt_features, alignment, components)

    if best is None:
        return GradeResult(
            outcome="rejected",
            reason="insufficient_alignment",
            score_bps=None,
            calibration_admitted=calibration.admitted,
            selected_mirror="canonical",
            quality=quality,
            alignment=_empty_alignment(),
            components=None,
            canonical_fingerprint_material_hex=None,
            versions=versions,
        )

    raw, name, attempt_features, alignment, components = best
    if enforce_reference_replay and is_post_alignment_reference_replay(
        reference_features,
        attempt_features,
        alignment.reference_indices,
        alignment.attempt_indices,
        config,
    ):
        return GradeResult(
            outcome="rejected",
            reason="reference_replay",
            score_bps=None,
            calibration_admitted=calibration.admitted,
            selected_mirror=name,
            quality=quality,
            alignment=alignment.metrics,
            components=None,
            canonical_fingerprint_material_hex=None,
            versions=versions,
        )
    return GradeResult(
        outcome="scored",
        reason=None,
        score_bps=calibration.score(raw),
        calibration_admitted=calibration.admitted,
        selected_mirror=name,
        quality=quality,
        alignment=alignment.metrics,
        components=components,
        canonical_fingerprint_material_hex=canonical_fingerprint_material(attempt_features).hex(),
        versions=versions,
    )
