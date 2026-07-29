from __future__ import annotations

from dataclasses import asdict, dataclass, field
from enum import StrEnum
from typing import Any

import numpy as np


class MirrorPolicy(StrEnum):
    STRICT = "strict"
    ALLOWED = "allowed"


@dataclass(frozen=True)
class PoseFrame:
    time_sec: float
    landmarks: np.ndarray | None


@dataclass(frozen=True)
class PoseSequence:
    frames: tuple[PoseFrame, ...]
    fps: float
    width: int
    height: int

    @classmethod
    def from_dict(cls, value: dict[str, Any]) -> PoseSequence:
        frames: list[PoseFrame] = []
        last_time = -1.0
        for raw_frame in value["frames"]:
            time_sec = float(raw_frame["time_sec"])
            if time_sec <= last_time:
                raise ValueError("pose frame timestamps must be strictly increasing")
            last_time = time_sec
            raw_landmarks = raw_frame.get("landmarks")
            landmarks = None
            if raw_landmarks is not None:
                if len(raw_landmarks) != 33:
                    raise ValueError("each detected pose must contain 33 landmarks")
                landmarks = np.asarray(
                    [
                        (
                            float(landmark["x"]),
                            float(landmark["y"]),
                            float(landmark.get("z", 0.0)),
                            float(landmark.get("visibility", 0.0)),
                        )
                        for landmark in raw_landmarks
                    ],
                    dtype=np.float64,
                )
                if not np.isfinite(landmarks).all():
                    raise ValueError("pose landmarks must be finite")
            frames.append(PoseFrame(time_sec=time_sec, landmarks=landmarks))

        if not frames:
            raise ValueError("pose sequence must contain at least one frame")

        fps = float(value.get("fps", 0.0))
        width = int(value.get("width", 0))
        height = int(value.get("height", 0))
        if fps <= 0 or width <= 0 or height <= 0:
            raise ValueError("pose sequence requires positive fps, width, and height")
        return cls(frames=tuple(frames), fps=fps, width=width, height=height)

    @property
    def duration_sec(self) -> float:
        return self.frames[-1].time_sec - self.frames[0].time_sec + 1.0 / self.fps


@dataclass(frozen=True)
class ScorerConfig:
    version: str = "dance_scorer_gate0_v1"
    feature_schema_version: str = "dance_pose_2d_gate0_v1"
    fingerprint_version: str = "dance_motion_fingerprint_gate0_v1"
    target_fps: float = 15.0
    min_duration_ratio: float = 0.85
    max_duration_ratio: float = 1.15
    min_pose_presence: float = 0.90
    min_usable_coverage: float = 0.80
    min_joint_visibility: float = 0.50
    # Eight of the fourteen scored joints must clear the local confidence floor.
    # Individual feature errors remain confidence-weighted and renormalized.
    min_visible_joint_fraction: float = 8 / 14
    max_missing_gap_sec: float = 0.50
    max_interpolation_gap_sec: float = 0.20
    max_global_offset_sec: float = 1.50
    min_alignment_overlap: float = 0.80
    dtw_band_sec: float = 0.80
    dtw_warp_penalty: float = 0.40
    dtw_unmatched_penalty: float = 0.06
    max_reference_replay_position_rmse: float = 0.03
    min_motion_energy_ratio: float = 0.15
    angle_weight: float = 0.48
    position_weight: float = 0.22
    velocity_weight: float = 0.20
    timing_weight: float = 0.10


@dataclass(frozen=True)
class QualityMetrics:
    outcome: str
    reason: str | None
    duration_ratio_bps: int
    pose_detection_bps: int
    usable_coverage_bps: int
    max_missing_gap_ms: int


@dataclass(frozen=True)
class AlignmentMetrics:
    global_offset_ms: int
    overlap_bps: int
    total_warp_bps: int
    unmatched_coverage_bps: int
    timing_score_bps: int


@dataclass(frozen=True)
class ComponentScores:
    angles_bps: int
    positions_bps: int
    velocity_bps: int
    timing_bps: int
    raw_similarity_bps: int


@dataclass(frozen=True)
class GradeResult:
    outcome: str
    reason: str | None
    score_bps: int | None
    calibration_admitted: bool
    selected_mirror: str
    quality: QualityMetrics
    alignment: AlignmentMetrics | None
    components: ComponentScores | None
    canonical_fingerprint_material_hex: str | None
    versions: dict[str, str] = field(default_factory=dict)

    def to_dict(self) -> dict[str, Any]:
        return asdict(self)
