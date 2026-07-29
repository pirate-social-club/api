from __future__ import annotations

import numpy as np
from conftest import make_sequence, mirror_sequence

from dance_grader import MirrorPolicy, grade_dance


def _reordered(sequence, order):
    frames = []
    source = list(sequence.frames)
    for target, source_index in zip(source, order):
        landmarks = source[source_index].landmarks
        frames.append(
            {
                "time_sec": target.time_sec,
                "landmarks": [
                    {"x": row[0], "y": row[1], "z": row[2], "visibility": row[3]}
                    for row in landmarks
                ],
            }
        )
    return type(sequence).from_dict(
        {"fps": sequence.fps, "width": sequence.width, "height": sequence.height, "frames": frames}
    )


def test_self_score_is_deterministic_and_explicitly_uncalibrated() -> None:
    reference = make_sequence()

    first = grade_dance(reference, reference, enforce_reference_replay=False)
    second = grade_dance(reference, reference, enforce_reference_replay=False)

    assert first == second
    assert first.outcome == "scored"
    assert first.score_bps == 10_000
    assert first.calibration_admitted is False
    assert first.versions["calibration"].endswith("provisional_v1")


def test_global_offset_recovers_delayed_honest_motion() -> None:
    reference = make_sequence()
    honest = make_sequence(noise=0.01)
    delayed = make_sequence(time_transform=lambda time_sec: max(0.0, time_sec - 0.5), noise=0.01)

    honest_result = grade_dance(reference, honest)
    delayed_result = grade_dance(reference, delayed)

    assert honest_result.score_bps is not None
    assert delayed_result.score_bps is not None
    assert delayed_result.alignment is not None
    assert abs(delayed_result.alignment.global_offset_ms) >= 400
    assert delayed_result.score_bps >= honest_result.score_bps - 1200


def test_constrained_dtw_recovers_moderate_tempo_variation() -> None:
    reference = make_sequence()
    slow = make_sequence(
        duration_sec=11.0,
        time_transform=lambda time_sec: time_sec / 1.1,
        noise=0.01,
    )
    fast = make_sequence(
        duration_sec=9.0,
        time_transform=lambda time_sec: time_sec / 0.9,
        noise=0.01,
    )

    slow_result = grade_dance(reference, slow)
    fast_result = grade_dance(reference, fast)

    assert slow_result.score_bps is not None and slow_result.score_bps >= 7000
    assert fast_result.score_bps is not None and fast_result.score_bps >= 7000
    assert slow_result.alignment is not None and slow_result.alignment.total_warp_bps > 0
    assert fast_result.alignment is not None and fast_result.alignment.total_warp_bps > 0
    assert slow_result.alignment.total_warp_bps <= 10_000
    assert fast_result.alignment.total_warp_bps <= 10_000


def test_tempo_resampled_reference_is_rejected_after_dtw() -> None:
    reference = make_sequence()
    slow_replay = make_sequence(
        duration_sec=11.0,
        time_transform=lambda time_sec: time_sec / 1.1,
    )
    fast_replay = make_sequence(
        duration_sec=9.0,
        time_transform=lambda time_sec: time_sec / 0.9,
    )

    slow_result = grade_dance(reference, slow_replay)
    fast_result = grade_dance(reference, fast_replay)

    assert slow_result.outcome == "rejected"
    assert slow_result.reason == "reference_replay"
    assert slow_result.score_bps is None
    assert slow_result.alignment is not None and slow_result.alignment.total_warp_bps > 0
    assert fast_result.outcome == "rejected"
    assert fast_result.reason == "reference_replay"
    assert fast_result.score_bps is None
    assert fast_result.alignment is not None and fast_result.alignment.total_warp_bps > 0


def test_full_length_still_pose_is_rejected_before_similarity() -> None:
    result = grade_dance(make_sequence(), make_sequence(time_transform=lambda _: 0.0))

    assert result.outcome == "rejected"
    assert result.reason == "insufficient_motion"
    assert result.score_bps is None


def test_reverse_and_shuffled_reference_motion_are_rejected_as_replay() -> None:
    duration = 10.0
    reference = make_sequence(duration_sec=duration)
    honest = grade_dance(reference, make_sequence(noise=0.01))
    reversed_result = grade_dance(reference, _reordered(reference, reversed(range(300))))
    shuffled = grade_dance(
        reference, _reordered(reference, ((index * 7) % 300 for index in range(300)))
    )

    assert honest.score_bps is not None
    assert reversed_result.outcome == "rejected"
    assert reversed_result.reason == "reference_replay"
    assert shuffled.outcome == "rejected"
    assert shuffled.reason == "reference_replay"


def test_mirror_policy_selects_one_whole_sequence_variant() -> None:
    reference = make_sequence()
    mirrored = mirror_sequence(make_sequence(noise=0.01))

    strict = grade_dance(reference, mirrored, mirror_policy=MirrorPolicy.STRICT)
    allowed = grade_dance(reference, mirrored, mirror_policy=MirrorPolicy.ALLOWED)

    assert strict.score_bps is not None
    assert allowed.score_bps is not None
    assert allowed.selected_mirror == "mirrored"
    assert allowed.score_bps >= strict.score_bps + 1000


def test_mirrored_reference_is_rejected_before_allowed_mirror_scoring() -> None:
    reference = make_sequence()
    mirrored_reference = mirror_sequence(reference)

    result = grade_dance(
        reference,
        mirrored_reference,
        mirror_policy=MirrorPolicy.ALLOWED,
    )

    assert result.outcome == "rejected"
    assert result.reason == "reference_replay"
    assert result.score_bps is None


def test_epsilon_jitter_does_not_bypass_mirrored_reference_replay() -> None:
    reference = make_sequence()
    mirrored_reference = mirror_sequence(reference)
    rng = np.random.default_rng(9)
    frames = []
    for frame in mirrored_reference.frames:
        landmarks = frame.landmarks.copy()
        landmarks[:, :2] += rng.normal(0, 0.003, landmarks[:, :2].shape)
        frames.append(
            {
                "time_sec": frame.time_sec,
                "landmarks": [
                    {"x": row[0], "y": row[1], "z": row[2], "visibility": row[3]}
                    for row in landmarks
                ],
            }
        )
    jittered = type(reference).from_dict(
        {
            "fps": reference.fps,
            "width": reference.width,
            "height": reference.height,
            "frames": frames,
        }
    )

    result = grade_dance(reference, jittered, mirror_policy=MirrorPolicy.ALLOWED)

    assert result.outcome == "rejected"
    assert result.reason == "reference_replay"
    assert result.score_bps is None


def test_random_movement_scores_well_below_honest_attempt() -> None:
    reference = make_sequence()
    honest = grade_dance(reference, make_sequence(noise=0.01))
    random_attempt = make_sequence()
    rng = np.random.default_rng(17)
    frames = []
    for frame in random_attempt.frames:
        landmarks = frame.landmarks.copy()
        landmarks[11:33, :2] += rng.normal(0, 0.12, landmarks[11:33, :2].shape)
        frames.append(
            {
                "time_sec": frame.time_sec,
                "landmarks": [
                    {"x": row[0], "y": row[1], "z": row[2], "visibility": row[3]}
                    for row in landmarks
                ],
            }
        )
    unrelated = type(reference).from_dict(
        {
            "fps": reference.fps,
            "width": reference.width,
            "height": reference.height,
            "frames": frames,
        }
    )

    result = grade_dance(reference, unrelated)

    assert honest.score_bps is not None
    assert result.score_bps is not None
    assert result.score_bps <= honest.score_bps - 2000
