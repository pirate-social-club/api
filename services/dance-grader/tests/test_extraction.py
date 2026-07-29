from __future__ import annotations

from pathlib import Path

import numpy as np
import pytest
from conftest import make_sequence

from dance_grader import (
    ExtractionCaps,
    ExtractionError,
    MediaPipeTasksPoseDetector,
    ReferenceFeatureArtifact,
    build_reference_artifact,
    extract_pose_sequence,
    grade_dance_against_features,
)
from dance_grader.extraction import (
    DecodedFrame,
    DetectedLandmark,
    VideoMetadata,
    _rotate_rgb,
)


class FakeDecoder:
    def __init__(self, metadata: VideoMetadata, frames: tuple[DecodedFrame, ...]):
        self.metadata = metadata
        self.frames = frames

    def inspect(self, path: Path, caps: ExtractionCaps) -> VideoMetadata:
        assert path.name == "fixture.mp4"
        return self.metadata

    def decode_frames(
        self,
        path: Path,
        metadata: VideoMetadata,
        caps: ExtractionCaps,
    ):
        assert metadata == self.metadata
        yield from self.frames


class FakeDetector:
    model_version = "pose_landmarker_full_test_v1"
    model_sha256 = "a" * 64
    runtime_version = "mediapipe-test"

    def __init__(self, outputs):
        self.outputs = iter(outputs)
        self.timestamps: list[int] = []
        self.closed = False

    def detect(self, rgb: np.ndarray, timestamp_ms: int):
        assert rgb.flags.c_contiguous
        self.timestamps.append(timestamp_ms)
        return next(self.outputs)

    def close(self) -> None:
        self.closed = True


def _detected_pose(landmarks) -> tuple[DetectedLandmark, ...]:
    return tuple(
        DetectedLandmark(
            x=float(row[0]),
            y=float(row[1]),
            z=float(row[2]),
            visibility=float(row[3]),
            presence=0.99,
        )
        for row in landmarks
    )


def _fixture(
    *,
    duration_sec: float = 4.0,
    missing_indices: set[int] | None = None,
    visibility: float = 0.99,
):
    sequence = make_sequence(duration_sec=duration_sec, fps=15.0, visibility=visibility)
    frames = tuple(
        DecodedFrame(
            time_sec=frame.time_sec,
            rgb=np.zeros((16, 12, 3), dtype=np.uint8),
        )
        for frame in sequence.frames
    )
    metadata = VideoMetadata(
        width=12,
        height=16,
        nominal_fps=15.0,
        rotation_degrees=0,
        codec="test",
    )
    missing_indices = missing_indices or set()
    outputs = [
        () if index in missing_indices else (_detected_pose(frame.landmarks),)
        for index, frame in enumerate(sequence.frames)
    ]
    return metadata, frames, outputs


def test_extraction_preserves_timeline_and_builds_deterministic_reference_artifact() -> None:
    metadata, frames, outputs = _fixture(missing_indices={10})
    detector = FakeDetector(outputs)

    extraction = extract_pose_sequence(
        Path("fixture.mp4"),
        decoder=FakeDecoder(metadata, frames),
        detector=detector,
    )
    artifact = build_reference_artifact(extraction, reference_content_sha256="b" * 64)
    rebuilt = build_reference_artifact(extraction, reference_content_sha256="b" * 64)

    assert detector.closed is True
    assert detector.timestamps == sorted(set(detector.timestamps))
    assert len(extraction.pose_sequence.frames) == len(frames)
    assert extraction.pose_sequence.frames[10].landmarks is None
    assert extraction.metrics.pose_detection_bps > 9_500
    assert artifact.sha256 == rebuilt.sha256
    assert artifact.canonical_json() == rebuilt.canonical_json()
    assert b"landmarks" not in artifact.canonical_json()
    assert artifact.pose_model_sha256 == "a" * 64
    restored = ReferenceFeatureArtifact.from_json(artifact.canonical_json())
    restored_features = restored.to_feature_sequence()
    assert len(restored_features.times) == len(artifact.times_ms)
    assert np.isfinite(restored_features.positions).any()
    attempt = make_sequence(duration_sec=4.0, fps=15.0, noise=0.01)
    grade = grade_dance_against_features(
        restored_features,
        artifact.duration_ms / 1000,
        attempt,
    )
    assert grade.outcome == "scored"


def test_multiple_people_fails_closed_and_closes_detector() -> None:
    metadata, frames, outputs = _fixture()
    outputs[5] = (outputs[5][0], outputs[5][0])
    detector = FakeDetector(outputs)

    with pytest.raises(ExtractionError, match="multiple poses") as error:
        extract_pose_sequence(
            Path("fixture.mp4"),
            decoder=FakeDecoder(metadata, frames),
            detector=detector,
        )

    assert error.value.code == "multiple_people"
    assert detector.closed is True


def test_decoder_frames_are_sampled_before_pose_inference() -> None:
    sequence = make_sequence(duration_sec=4.0, fps=30.0)
    frames = tuple(
        DecodedFrame(
            time_sec=frame.time_sec,
            rgb=np.zeros((16, 12, 3), dtype=np.uint8),
        )
        for frame in sequence.frames
    )
    metadata = VideoMetadata(12, 16, 30.0, 0, "test")
    sampled_landmarks = sequence.frames[::2]
    detector = FakeDetector([(_detected_pose(frame.landmarks),) for frame in sampled_landmarks])

    extraction = extract_pose_sequence(
        Path("fixture.mp4"),
        decoder=FakeDecoder(metadata, frames),
        detector=detector,
    )

    assert extraction.metrics.decoded_frame_count == 120
    assert extraction.metrics.sampled_frame_count == 60
    assert len(detector.timestamps) == 60


def test_zero_visibility_reference_fails_quality_gate() -> None:
    metadata, frames, outputs = _fixture(visibility=0.0)

    with pytest.raises(ExtractionError, match="visibility") as error:
        extract_pose_sequence(
            Path("fixture.mp4"),
            decoder=FakeDecoder(metadata, frames),
            detector=FakeDetector(outputs),
        )

    assert error.value.code == "insufficient_coverage"


def test_long_pose_gap_fails_reference_quality_gate() -> None:
    metadata, frames, outputs = _fixture(missing_indices=set(range(15, 27)))

    with pytest.raises(ExtractionError) as error:
        extract_pose_sequence(
            Path("fixture.mp4"),
            decoder=FakeDecoder(metadata, frames),
            detector=FakeDetector(outputs),
        )

    assert error.value.code == "insufficient_pose_presence"


def test_invalid_decoded_timeline_stops_inference_and_closes_detector() -> None:
    metadata, source_frames, outputs = _fixture()
    frames = list(source_frames)
    frames[4] = DecodedFrame(time_sec=frames[3].time_sec, rgb=frames[4].rgb)
    detector = FakeDetector(outputs)

    with pytest.raises(ExtractionError, match="strictly increasing") as error:
        extract_pose_sequence(
            Path("fixture.mp4"),
            decoder=FakeDecoder(metadata, tuple(frames)),
            detector=detector,
        )

    assert error.value.code == "invalid_timeline"
    assert detector.timestamps == [0, 67, 133, 200]
    assert detector.closed is True


def test_model_checksum_is_verified_before_mediapipe_import(tmp_path: Path) -> None:
    model = tmp_path / "pose.task"
    model.write_bytes(b"not-the-pinned-model")

    with pytest.raises(ExtractionError, match="checksum") as error:
        MediaPipeTasksPoseDetector(
            model_path=model,
            expected_model_sha256="0" * 64,
            model_version="test",
        )

    assert error.value.code == "model_invalid"


def test_clockwise_rotation_is_applied_before_inference() -> None:
    rgb = np.asarray(
        [
            [[1, 0, 0], [2, 0, 0]],
            [[3, 0, 0], [4, 0, 0]],
            [[5, 0, 0], [6, 0, 0]],
        ],
        dtype=np.uint8,
    )

    rotated = _rotate_rgb(rgb, 90)

    assert rotated.shape == (2, 3, 3)
    assert rotated[:, :, 0].tolist() == [[5, 3, 1], [6, 4, 2]]
    assert rotated.flags.c_contiguous
