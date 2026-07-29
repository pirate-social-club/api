from __future__ import annotations

import hashlib
import json
from dataclasses import asdict, dataclass

import numpy as np

from .extraction import ExtractionResult
from .features import FeatureSequence, build_features
from .models import ScorerConfig


@dataclass(frozen=True)
class ReferenceFeatureArtifact:
    artifact_version: str
    reference_content_sha256: str
    pose_model_version: str
    pose_model_sha256: str
    pose_runtime_version: str
    feature_schema_version: str
    scorer_compatibility: tuple[str, ...]
    width: int
    height: int
    fps: float
    duration_ms: int
    times_ms: tuple[int, ...]
    angles_millidegrees: tuple[tuple[int | None, ...], ...]
    angle_confidence_bps: tuple[tuple[int, ...], ...]
    positions_microunits: tuple[tuple[tuple[int | None, int | None], ...], ...]
    position_confidence_bps: tuple[tuple[int, ...], ...]
    velocity_microunits: tuple[tuple[tuple[int | None, int | None], ...], ...]
    velocity_confidence_bps: tuple[tuple[int, ...], ...]
    usable_frames: tuple[bool, ...]
    extraction_metrics: dict[str, int]

    def canonical_json(self) -> bytes:
        return json.dumps(
            asdict(self),
            sort_keys=True,
            separators=(",", ":"),
            allow_nan=False,
        ).encode()

    @property
    def sha256(self) -> str:
        return hashlib.sha256(self.canonical_json()).hexdigest()

    @classmethod
    def from_json(cls, payload: bytes) -> ReferenceFeatureArtifact:
        value = json.loads(payload)
        artifact = cls(**value)
        if artifact.canonical_json() != payload:
            raise ValueError("reference artifact is not canonical JSON")
        return artifact

    def to_feature_sequence(self) -> FeatureSequence:
        def restore_optional(values, scale: int) -> np.ndarray:
            return np.asarray(
                [
                    [np.nan if component is None else component / scale for component in row]
                    for row in values
                ],
                dtype=np.float64,
            )

        positions = np.asarray(
            [
                [
                    [np.nan if component is None else component / 1_000_000 for component in point]
                    for point in row
                ]
                for row in self.positions_microunits
            ],
            dtype=np.float64,
        )
        velocity = np.asarray(
            [
                [
                    [np.nan if component is None else component / 1_000_000 for component in point]
                    for point in row
                ]
                for row in self.velocity_microunits
            ],
            dtype=np.float64,
        )
        return FeatureSequence(
            times=np.asarray(self.times_ms, dtype=np.float64) / 1000,
            angles=restore_optional(self.angles_millidegrees, 1000),
            angle_confidence=np.asarray(self.angle_confidence_bps, dtype=np.float64) / 10_000,
            positions=positions,
            position_confidence=np.asarray(self.position_confidence_bps, dtype=np.float64) / 10_000,
            velocity=velocity,
            velocity_confidence=np.asarray(self.velocity_confidence_bps, dtype=np.float64) / 10_000,
            usable=np.asarray(self.usable_frames, dtype=bool),
        )


def _optional_integer(value: float, scale: int) -> int | None:
    if not np.isfinite(value):
        return None
    return round(float(value) * scale)


def build_reference_artifact(
    extraction: ExtractionResult,
    *,
    reference_content_sha256: str,
    config: ScorerConfig | None = None,
) -> ReferenceFeatureArtifact:
    config = config or ScorerConfig()
    if len(reference_content_sha256) != 64 or any(
        character not in "0123456789abcdef" for character in reference_content_sha256
    ):
        raise ValueError("reference content SHA-256 must be 64 lowercase hexadecimal characters")
    if extraction.feature_schema_version != config.feature_schema_version:
        raise ValueError("extraction and scorer feature schema versions do not match")
    features: FeatureSequence = build_features(extraction.pose_sequence, config)
    return ReferenceFeatureArtifact(
        artifact_version="dance_reference_features_v1",
        reference_content_sha256=reference_content_sha256,
        pose_model_version=extraction.pose_model_version,
        pose_model_sha256=extraction.pose_model_sha256,
        pose_runtime_version=extraction.pose_runtime_version,
        feature_schema_version=extraction.feature_schema_version,
        scorer_compatibility=(config.version,),
        width=extraction.pose_sequence.width,
        height=extraction.pose_sequence.height,
        fps=config.target_fps,
        duration_ms=extraction.metrics.duration_ms,
        times_ms=tuple(round(float(value) * 1000) for value in features.times),
        angles_millidegrees=tuple(
            tuple(_optional_integer(value, 1000) for value in row) for row in features.angles
        ),
        angle_confidence_bps=tuple(
            tuple(round(float(value) * 10_000) for value in row)
            for row in features.angle_confidence
        ),
        positions_microunits=tuple(
            tuple(
                (
                    _optional_integer(point[0], 1_000_000),
                    _optional_integer(point[1], 1_000_000),
                )
                for point in row
            )
            for row in features.positions
        ),
        position_confidence_bps=tuple(
            tuple(round(float(value) * 10_000) for value in row)
            for row in features.position_confidence
        ),
        velocity_microunits=tuple(
            tuple(
                (
                    _optional_integer(point[0], 1_000_000),
                    _optional_integer(point[1], 1_000_000),
                )
                for point in row
            )
            for row in features.velocity
        ),
        velocity_confidence_bps=tuple(
            tuple(round(float(value) * 10_000) for value in row)
            for row in features.velocity_confidence
        ),
        usable_frames=tuple(bool(value) for value in features.usable),
        extraction_metrics=asdict(extraction.metrics),
    )
