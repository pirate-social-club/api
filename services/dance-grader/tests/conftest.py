from __future__ import annotations

import math
from collections.abc import Callable

import numpy as np

from dance_grader import PoseSequence
from dance_grader.features import LEFT_RIGHT_PAIRS


def _landmarks_at(time_sec: float) -> list[dict[str, float]]:
    landmarks = np.zeros((33, 4), dtype=np.float64)
    landmarks[:, 0] = 0.5
    landmarks[:, 1] = 0.5
    landmarks[:, 3] = 0.99

    sway = 0.035 * math.sin(2 * math.pi * time_sec / 2.4)
    arm = 0.16 * math.sin(2 * math.pi * time_sec / 1.6)
    arm_y = 0.11 * math.cos(2 * math.pi * time_sec / 1.6)
    knee = 0.045 * max(0.0, math.sin(2 * math.pi * time_sec / 1.2))

    points = {
        11: (0.42 + sway, 0.34),
        12: (0.58 + sway, 0.34),
        13: (0.35 + sway - arm * 0.55, 0.46 - arm_y),
        14: (0.65 + sway + arm * 0.55, 0.46 + arm_y),
        15: (0.29 + sway - arm, 0.58 - arm_y * 1.4),
        16: (0.71 + sway + arm, 0.58 + arm_y * 1.4),
        23: (0.45 + sway, 0.57),
        24: (0.55 + sway, 0.57),
        25: (0.43 + sway - knee, 0.74),
        26: (0.57 + sway + knee, 0.74),
        27: (0.42 + sway - knee * 0.6, 0.91),
        28: (0.58 + sway + knee * 0.6, 0.91),
        29: (0.40 + sway - knee * 0.6, 0.93),
        30: (0.60 + sway + knee * 0.6, 0.93),
        31: (0.39 + sway - knee * 0.6, 0.94),
        32: (0.61 + sway + knee * 0.6, 0.94),
    }
    for index, (x, y) in points.items():
        landmarks[index, 0] = x
        landmarks[index, 1] = y
    return [{"x": row[0], "y": row[1], "z": row[2], "visibility": row[3]} for row in landmarks]


def make_sequence(
    *,
    duration_sec: float = 10.0,
    fps: float = 30.0,
    time_transform: Callable[[float], float] = lambda value: value,
    visibility: float = 0.99,
    noise: float = 0.0,
    seed: int = 1,
) -> PoseSequence:
    rng = np.random.default_rng(seed)
    frames = []
    for index in range(round(duration_sec * fps)):
        time_sec = index / fps
        landmarks = _landmarks_at(time_transform(time_sec))
        for landmark in landmarks:
            landmark["visibility"] = visibility
            if noise:
                landmark["x"] += float(rng.normal(0, noise))
                landmark["y"] += float(rng.normal(0, noise))
        frames.append({"time_sec": time_sec, "landmarks": landmarks})
    return PoseSequence.from_dict({"fps": fps, "width": 576, "height": 1024, "frames": frames})


def make_human_attempt(
    *,
    duration_sec: float = 10.0,
    fps: float = 30.0,
    time_transform: Callable[[float], float] = lambda value: value,
) -> PoseSequence:
    """Make a similar performance without copying the reference's exact geometry."""
    frames = []
    for index in range(round(duration_sec * fps)):
        time_sec = index / fps
        motion_time = time_transform(time_sec)
        landmarks = _landmarks_at(motion_time)
        breath = math.sin(2 * math.pi * motion_time / 3.7)
        reach = math.sin(2 * math.pi * (motion_time + 0.11) / 1.6)
        for joint in (13, 15):
            landmarks[joint]["x"] -= 0.078 + 0.040 * reach
            landmarks[joint]["y"] += 0.031 * breath
        for joint in (14, 16):
            landmarks[joint]["x"] += 0.062 + 0.031 * reach
            landmarks[joint]["y"] -= 0.024 * breath
        for joint in (25, 27, 29, 31):
            landmarks[joint]["x"] -= 0.040
            landmarks[joint]["y"] += 0.026 * breath
        for joint in (26, 28, 30, 32):
            landmarks[joint]["x"] += 0.049
            landmarks[joint]["y"] -= 0.020 * breath
        frames.append({"time_sec": time_sec, "landmarks": landmarks})
    return PoseSequence.from_dict({"fps": fps, "width": 576, "height": 1024, "frames": frames})


def discrete_tempo_resample(sequence: PoseSequence, factor: float) -> PoseSequence:
    """Change tempo by dropping/duplicating extracted frames, as a replay tool would."""
    source = list(sequence.frames)
    target_count = round(len(source) * factor)
    frames = []
    for target_index in range(target_count):
        source_index = min(round(target_index / factor), len(source) - 1)
        landmarks = source[source_index].landmarks
        assert landmarks is not None
        frames.append(
            {
                "time_sec": target_index / sequence.fps,
                "landmarks": [
                    {"x": row[0], "y": row[1], "z": row[2], "visibility": row[3]}
                    for row in landmarks
                ],
            }
        )
    return PoseSequence.from_dict(
        {
            "fps": sequence.fps,
            "width": sequence.width,
            "height": sequence.height,
            "frames": frames,
        }
    )


def mirror_sequence(sequence: PoseSequence) -> PoseSequence:
    frames = []
    for frame in sequence.frames:
        assert frame.landmarks is not None
        landmarks = frame.landmarks.copy()
        landmarks[:, 0] = 1.0 - landmarks[:, 0]
        for left, right in LEFT_RIGHT_PAIRS:
            landmarks[[left, right]] = landmarks[[right, left]]
        frames.append(
            {
                "time_sec": frame.time_sec,
                "landmarks": [
                    {"x": row[0], "y": row[1], "z": row[2], "visibility": row[3]}
                    for row in landmarks
                ],
            }
        )
    return PoseSequence.from_dict(
        {
            "fps": sequence.fps,
            "width": sequence.width,
            "height": sequence.height,
            "frames": frames,
        }
    )
