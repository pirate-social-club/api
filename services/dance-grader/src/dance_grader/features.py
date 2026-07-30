from __future__ import annotations

from dataclasses import dataclass

import numpy as np

from .models import PoseSequence, ScorerConfig

LEFT_RIGHT_PAIRS = ((11, 12), (13, 14), (15, 16), (23, 24), (25, 26), (27, 28), (29, 30), (31, 32))
SCORED_LANDMARKS = np.asarray((11, 12, 13, 14, 15, 16, 23, 24, 25, 26, 27, 28, 31, 32))
ANGLE_TRIPLETS = (
    (11, 13, 15),
    (12, 14, 16),
    (23, 25, 27),
    (24, 26, 28),
    (23, 11, 13),
    (24, 12, 14),
    (11, 23, 25),
    (12, 24, 26),
)


@dataclass(frozen=True)
class FeatureSequence:
    times: np.ndarray
    angles: np.ndarray
    angle_confidence: np.ndarray
    positions: np.ndarray
    position_confidence: np.ndarray
    velocity: np.ndarray
    velocity_confidence: np.ndarray
    usable: np.ndarray


def mirror_landmarks(landmarks: np.ndarray) -> np.ndarray:
    mirrored = landmarks.copy()
    mirrored[:, 0] = 1.0 - mirrored[:, 0]
    for left, right in LEFT_RIGHT_PAIRS:
        mirrored[[left, right]] = mirrored[[right, left]]
    return mirrored


def _normalized_geometry(landmarks: np.ndarray, width: int, height: int) -> np.ndarray | None:
    xy = landmarks[:, :2].copy()
    xy[:, 0] *= width / height
    hip_mid = (xy[23] + xy[24]) / 2.0
    shoulder_mid = (xy[11] + xy[12]) / 2.0
    torso = float(np.linalg.norm(shoulder_mid - hip_mid))
    if torso < 1e-5:
        return None
    return (xy - hip_mid) / torso


def _angle(a: np.ndarray, b: np.ndarray, c: np.ndarray) -> float:
    ba = a - b
    bc = c - b
    denominator = float(np.linalg.norm(ba) * np.linalg.norm(bc))
    if denominator < 1e-8:
        return np.nan
    cosine = float(np.clip(np.dot(ba, bc) / denominator, -1.0, 1.0))
    return float(np.degrees(np.arccos(cosine)))


def build_features(
    sequence: PoseSequence,
    config: ScorerConfig,
    *,
    mirrored: bool = False,
) -> FeatureSequence:
    start = sequence.frames[0].time_sec
    end = sequence.frames[-1].time_sec
    times = np.arange(start, end + 0.5 / config.target_fps, 1.0 / config.target_fps)
    source_times = np.asarray([frame.time_sec for frame in sequence.frames])

    angle_rows: list[np.ndarray] = []
    angle_confidence_rows: list[np.ndarray] = []
    position_rows: list[np.ndarray] = []
    position_confidence_rows: list[np.ndarray] = []
    usable_rows: list[bool] = []

    for time_sec in times:
        insertion = int(np.searchsorted(source_times, time_sec))
        candidates = [
            index for index in (insertion - 1, insertion) if 0 <= index < len(source_times)
        ]
        nearest = min(candidates, key=lambda index: abs(source_times[index] - time_sec))
        frame = sequence.frames[nearest]
        tolerance = max(0.5 / sequence.fps, 0.5 / config.target_fps)
        landmarks = frame.landmarks if abs(frame.time_sec - time_sec) <= tolerance else None

        if landmarks is None:
            angle_rows.append(np.full(len(ANGLE_TRIPLETS), np.nan))
            angle_confidence_rows.append(np.zeros(len(ANGLE_TRIPLETS)))
            position_rows.append(np.full((len(SCORED_LANDMARKS), 2), np.nan))
            position_confidence_rows.append(np.zeros(len(SCORED_LANDMARKS)))
            usable_rows.append(False)
            continue

        if mirrored:
            landmarks = mirror_landmarks(landmarks)
        geometry = _normalized_geometry(landmarks, sequence.width, sequence.height)
        if geometry is None:
            angle_rows.append(np.full(len(ANGLE_TRIPLETS), np.nan))
            angle_confidence_rows.append(np.zeros(len(ANGLE_TRIPLETS)))
            position_rows.append(np.full((len(SCORED_LANDMARKS), 2), np.nan))
            position_confidence_rows.append(np.zeros(len(SCORED_LANDMARKS)))
            usable_rows.append(False)
            continue

        visibility = np.clip(landmarks[:, 3], 0.0, 1.0)
        angles = np.asarray(
            [_angle(geometry[a], geometry[b], geometry[c]) for a, b, c in ANGLE_TRIPLETS]
        )
        angle_confidence = np.asarray(
            [min(visibility[a], visibility[b], visibility[c]) for a, b, c in ANGLE_TRIPLETS]
        )
        positions = geometry[SCORED_LANDMARKS]
        position_confidence = visibility[SCORED_LANDMARKS]
        visible_fraction = float(np.mean(position_confidence >= config.min_joint_visibility))

        angle_rows.append(angles)
        angle_confidence_rows.append(angle_confidence)
        position_rows.append(positions)
        position_confidence_rows.append(position_confidence)
        usable_rows.append(visible_fraction >= config.min_visible_joint_fraction)

    angles_array = np.asarray(angle_rows)
    angle_confidence_array = np.asarray(angle_confidence_rows)
    positions_array = np.asarray(position_rows)
    position_confidence_array = np.asarray(position_confidence_rows)
    velocity = np.diff(positions_array, axis=0, prepend=positions_array[:1])
    velocity_confidence = np.minimum(
        position_confidence_array,
        np.concatenate((position_confidence_array[:1], position_confidence_array[:-1])),
    )
    return FeatureSequence(
        times=times,
        angles=angles_array,
        angle_confidence=angle_confidence_array,
        positions=positions_array,
        position_confidence=position_confidence_array,
        velocity=velocity,
        velocity_confidence=velocity_confidence,
        usable=np.asarray(usable_rows, dtype=bool),
    )
