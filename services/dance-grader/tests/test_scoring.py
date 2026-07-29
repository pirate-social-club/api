from __future__ import annotations

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
    honest = make_sequence(noise=0.002)
    delayed = make_sequence(time_transform=lambda time_sec: max(0.0, time_sec - 0.5), noise=0.002)

    honest_result = grade_dance(reference, honest)
    delayed_result = grade_dance(reference, delayed)

    assert honest_result.score_bps is not None
    assert delayed_result.score_bps is not None
    assert delayed_result.alignment is not None
    assert abs(delayed_result.alignment.global_offset_ms) >= 400
    assert delayed_result.score_bps >= honest_result.score_bps - 1200


def test_reverse_and_shuffled_reference_motion_are_rejected_as_replay() -> None:
    duration = 10.0
    reference = make_sequence(duration_sec=duration)
    honest = grade_dance(reference, make_sequence(noise=0.003))
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
    mirrored = mirror_sequence(make_sequence(noise=0.002))

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
