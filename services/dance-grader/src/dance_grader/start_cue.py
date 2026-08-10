from __future__ import annotations

from dataclasses import dataclass

import numpy as np

from .models import PoseFrame, PoseSequence

START_CUE_POLICY_VERSION = "dance_start_cue_gross_body_v1"
START_CUE_KINDS = frozenset({"hands_on_head", "arms_t", "hands_on_hips"})


class StartCueError(ValueError):
    code = "start_cue_mismatch"


@dataclass(frozen=True)
class StartCueObservation:
    policy_version: str
    kind: str
    outcome: str
    scored_window_start_ms: int


def _distance(a: np.ndarray, b: np.ndarray) -> float:
    return float(np.linalg.norm(a[:2] - b[:2]))


def _matches(kind: str, landmarks: np.ndarray) -> bool:
    visible = landmarks[:, 3]
    shoulders = _distance(landmarks[11], landmarks[12])
    if shoulders <= 1e-6:
        return False
    required = {
        "hands_on_head": (7, 8, 15, 16),
        "arms_t": (11, 12, 13, 14, 15, 16),
        "hands_on_hips": (15, 16, 23, 24),
    }[kind]
    if any(visible[index] < 0.5 for index in required):
        return False
    if kind == "hands_on_head":
        canonical = _distance(landmarks[15], landmarks[7]) + _distance(landmarks[16], landmarks[8])
        mirrored = _distance(landmarks[15], landmarks[8]) + _distance(landmarks[16], landmarks[7])
        return min(canonical, mirrored) <= shoulders * 1.1
    if kind == "hands_on_hips":
        canonical = _distance(landmarks[15], landmarks[23]) + _distance(
            landmarks[16], landmarks[24]
        )
        mirrored = _distance(landmarks[15], landmarks[24]) + _distance(landmarks[16], landmarks[23])
        return min(canonical, mirrored) <= shoulders * 1.1
    shoulder_y = float((landmarks[11, 1] + landmarks[12, 1]) / 2)
    horizontal = all(
        abs(float(landmarks[index, 1]) - shoulder_y) <= shoulders * 0.35
        for index in (13, 14, 15, 16)
    )
    extended = all(
        _distance(landmarks[wrist], landmarks[shoulder]) >= shoulders * 0.8
        for wrist, shoulder in ((15, 11), (16, 12))
    )
    return horizontal and bool(extended)


def verify_and_exclude_start_cue(
    sequence: PoseSequence,
    *,
    policy_version: str,
    kind: str,
    minimum_hold_ms: int,
    observation_window_ms: int,
) -> tuple[PoseSequence, StartCueObservation]:
    if policy_version != START_CUE_POLICY_VERSION or kind not in START_CUE_KINDS:
        raise StartCueError("unsupported start cue contract")
    if not 250 <= minimum_hold_ms < observation_window_ms <= 5000:
        raise StartCueError("invalid start cue timing contract")

    origin = sequence.frames[0].time_sec
    hold_started: float | None = None
    boundary: float | None = None
    for frame in sequence.frames:
        elapsed_ms = round((frame.time_sec - origin) * 1000)
        if elapsed_ms > observation_window_ms:
            break
        matched = frame.landmarks is not None and _matches(kind, frame.landmarks)
        if not matched:
            hold_started = None
            continue
        hold_started = frame.time_sec if hold_started is None else hold_started
        if (frame.time_sec - hold_started) * 1000 >= minimum_hold_ms:
            boundary = frame.time_sec
            break
    if boundary is None:
        raise StartCueError("required start cue was not observed")

    scored_frames = tuple(
        PoseFrame(time_sec=frame.time_sec - boundary, landmarks=frame.landmarks)
        for frame in sequence.frames
        if frame.time_sec > boundary
    )
    if not scored_frames:
        raise StartCueError("start cue leaves no scored frames")
    normalized = PoseSequence(
        frames=scored_frames,
        fps=sequence.fps,
        width=sequence.width,
        height=sequence.height,
    )
    boundary_ms = round((boundary - origin) * 1000)
    return normalized, StartCueObservation(
        policy_version=policy_version,
        kind=kind,
        outcome="passed",
        scored_window_start_ms=boundary_ms,
    )
