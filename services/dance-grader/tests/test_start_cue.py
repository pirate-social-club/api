from __future__ import annotations

import numpy as np
import pytest

from dance_grader.models import PoseFrame, PoseSequence
from dance_grader.start_cue import StartCueError, verify_and_exclude_start_cue


def frame(time_sec: float, *, cue: bool) -> PoseFrame:
    landmarks = np.zeros((33, 4), dtype=np.float64)
    landmarks[:, 3] = 1.0
    landmarks[11, :2] = (0.4, 0.4)
    landmarks[12, :2] = (0.6, 0.4)
    landmarks[7, :2] = (0.43, 0.2)
    landmarks[8, :2] = (0.57, 0.2)
    landmarks[15, :2] = (0.43, 0.2) if cue else (0.2, 0.8)
    landmarks[16, :2] = (0.57, 0.2) if cue else (0.8, 0.8)
    return PoseFrame(time_sec=time_sec, landmarks=landmarks)


def sequence(*, cue: bool) -> PoseSequence:
    return PoseSequence(
        frames=tuple(frame(index / 10, cue=cue) for index in range(31)),
        fps=10,
        width=720,
        height=1280,
    )


def test_verifies_hold_and_excludes_cue_window() -> None:
    scored, observation = verify_and_exclude_start_cue(
        sequence(cue=True),
        policy_version="dance_start_cue_gross_body_v1",
        kind="hands_on_head",
        minimum_hold_ms=500,
        observation_window_ms=2500,
    )
    assert observation.outcome == "passed"
    assert observation.scored_window_start_ms == 500
    assert scored.frames[0].time_sec > 0
    assert scored.duration_sec < sequence(cue=True).duration_sec


def test_rejects_when_cue_is_not_observed() -> None:
    with pytest.raises(StartCueError, match="not observed"):
        verify_and_exclude_start_cue(
            sequence(cue=False),
            policy_version="dance_start_cue_gross_body_v1",
            kind="hands_on_head",
            minimum_hold_ms=500,
            observation_window_ms=2500,
        )
