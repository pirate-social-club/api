from __future__ import annotations

from conftest import make_sequence

from dance_grader import grade_dance


def test_first_second_only_is_rejected_before_similarity() -> None:
    result = grade_dance(make_sequence(), make_sequence(duration_sec=1.0))

    assert result.outcome == "rejected"
    assert result.reason == "duration_out_of_range"
    assert result.score_bps is None


def test_visibility_zero_cannot_improve_score() -> None:
    result = grade_dance(make_sequence(), make_sequence(visibility=0.0))

    assert result.outcome == "rejected"
    assert result.reason == "insufficient_coverage"
    assert result.score_bps is None
    assert result.quality.usable_coverage_bps == 0


def test_long_missing_detection_gap_is_rejected() -> None:
    reference = make_sequence()
    attempt = make_sequence()
    frames = []
    for frame in attempt.frames:
        frames.append(
            {
                "time_sec": frame.time_sec,
                "landmarks": None
                if 4.0 <= frame.time_sec <= 4.8
                else [
                    {"x": row[0], "y": row[1], "z": row[2], "visibility": row[3]}
                    for row in frame.landmarks
                ],
            }
        )
    damaged = type(attempt).from_dict(
        {"fps": attempt.fps, "width": attempt.width, "height": attempt.height, "frames": frames}
    )

    result = grade_dance(reference, damaged)
    assert result.outcome == "rejected"
    assert result.reason == "insufficient_pose_presence"
    assert result.quality.max_missing_gap_ms > 500
