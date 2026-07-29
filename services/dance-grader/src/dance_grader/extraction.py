from __future__ import annotations

import hashlib
from collections.abc import Iterable
from dataclasses import dataclass
from pathlib import Path
from typing import Any, Protocol

import numpy as np

from .features import SCORED_LANDMARKS, build_features
from .models import PoseSequence, ScorerConfig


class ExtractionError(ValueError):
    def __init__(self, code: str, message: str):
        super().__init__(message)
        self.code = code


@dataclass(frozen=True)
class ExtractionCaps:
    max_duration_sec: float = 90.0
    max_decoded_frames: int = 5_400
    max_width: int = 2_160
    max_height: int = 2_160
    max_total_pixels: int = 12_000_000_000
    inference_fps: float = 15.0
    min_pose_presence: float = 0.90
    min_usable_coverage: float = 0.80
    min_joint_visibility: float = 0.50
    min_visible_joint_fraction: float = 8 / 14
    max_missing_gap_sec: float = 0.50
    min_motion_energy: float = 0.002


@dataclass(frozen=True)
class DecodedFrame:
    time_sec: float
    rgb: np.ndarray


@dataclass(frozen=True)
class VideoMetadata:
    width: int
    height: int
    nominal_fps: float
    rotation_degrees: int
    codec: str


class VideoDecoder(Protocol):
    def inspect(self, path: Path, caps: ExtractionCaps) -> VideoMetadata: ...

    def decode_frames(
        self,
        path: Path,
        metadata: VideoMetadata,
        caps: ExtractionCaps,
    ) -> Iterable[DecodedFrame]: ...


@dataclass(frozen=True)
class DetectedLandmark:
    x: float
    y: float
    z: float
    visibility: float
    presence: float


class PoseDetector(Protocol):
    model_version: str
    model_sha256: str
    runtime_version: str

    def detect(
        self,
        rgb: np.ndarray,
        timestamp_ms: int,
    ) -> tuple[tuple[DetectedLandmark, ...], ...]: ...

    def close(self) -> None: ...


@dataclass(frozen=True)
class ExtractionMetrics:
    duration_ms: int
    decoded_frame_count: int
    sampled_frame_count: int
    pose_detection_bps: int
    usable_coverage_bps: int
    max_missing_gap_ms: int
    maximum_pose_count: int
    motion_energy_bps: int


@dataclass(frozen=True)
class ExtractionResult:
    pose_sequence: PoseSequence
    metrics: ExtractionMetrics
    pose_model_version: str
    pose_model_sha256: str
    pose_runtime_version: str
    feature_schema_version: str


def _rotation_from_metadata(metadata: dict[str, str]) -> int:
    raw = metadata.get("rotate", "0")
    try:
        rotation = int(float(raw)) % 360
    except ValueError as error:
        raise ExtractionError("video_invalid", "invalid video rotation metadata") from error
    if rotation not in (0, 90, 180, 270):
        raise ExtractionError("video_invalid", "unsupported video rotation metadata")
    return rotation


def _rotate_rgb(rgb: np.ndarray, rotation_degrees: int) -> np.ndarray:
    if rotation_degrees == 0:
        return np.ascontiguousarray(rgb)
    # Display rotation is clockwise; np.rot90 uses counter-clockwise turns.
    turns = {90: 3, 180: 2, 270: 1}[rotation_degrees]
    return np.ascontiguousarray(np.rot90(rgb, turns))


class PyAvVideoDecoder:
    """Decode presentation timestamps and apply stream rotation before inference."""

    @staticmethod
    def _import_av():
        try:
            import av
        except ImportError as error:
            raise RuntimeError("install the dance-grader runtime extra to decode video") from error
        return av

    def inspect(self, path: Path, caps: ExtractionCaps) -> VideoMetadata:
        av = self._import_av()
        try:
            with av.open(str(path), mode="r") as container:
                if len(container.streams.video) != 1:
                    raise ExtractionError(
                        "video_invalid", "video must contain exactly one video stream"
                    )
                stream = container.streams.video[0]
                first_frame = next(container.decode(stream), None)
                if first_frame is None:
                    raise ExtractionError("video_invalid", "video contains no decodable frames")
                # PyAV exposes DISPLAYMATRIX rotation counter-clockwise; the legacy metadata tag
                # is conventionally clockwise. Normalize both into clockwise degrees.
                display_rotation = int(first_frame.rotation)
                rotation = (
                    (-display_rotation) % 360
                    if display_rotation
                    else _rotation_from_metadata(dict(stream.metadata))
                )
                if rotation not in (0, 90, 180, 270):
                    raise ExtractionError("video_invalid", "unsupported video display rotation")
                nominal_fps = float(stream.average_rate or stream.base_rate or 0.0)
                codec = str(stream.codec_context.name or "unknown")
                source_width = int(stream.codec_context.width)
                source_height = int(stream.codec_context.height)
                output_width = source_height if rotation in (90, 270) else source_width
                output_height = source_width if rotation in (90, 270) else source_height
                if output_width <= 0 or output_height <= 0:
                    raise ExtractionError("video_invalid", "video dimensions are unavailable")
                if output_width > caps.max_width or output_height > caps.max_height:
                    raise ExtractionError(
                        "video_limits_exceeded", "video resolution exceeds extraction cap"
                    )
                return VideoMetadata(
                    width=output_width,
                    height=output_height,
                    nominal_fps=nominal_fps,
                    rotation_degrees=rotation,
                    codec=codec,
                )
        except ExtractionError:
            raise
        except Exception as error:
            raise ExtractionError("video_invalid", "video inspection failed") from error

    def decode_frames(
        self,
        path: Path,
        metadata: VideoMetadata,
        caps: ExtractionCaps,
    ) -> Iterable[DecodedFrame]:
        av = self._import_av()
        try:
            with av.open(str(path), mode="r") as container:
                stream = container.streams.video[0]
                first_time: float | None = None
                previous_time = -1.0
                for decoded_count, frame in enumerate(container.decode(stream), start=1):
                    if decoded_count > caps.max_decoded_frames:
                        raise ExtractionError(
                            "video_limits_exceeded", "decoded frame count exceeds cap"
                        )
                    if decoded_count * metadata.width * metadata.height > caps.max_total_pixels:
                        raise ExtractionError(
                            "video_limits_exceeded", "decoded pixel count exceeds cap"
                        )
                    if frame.time is None:
                        raise ExtractionError(
                            "invalid_timeline", "decoded frame is missing presentation time"
                        )
                    absolute_time = float(frame.time)
                    if first_time is None:
                        first_time = absolute_time
                    relative_time = absolute_time - first_time
                    if relative_time <= previous_time:
                        raise ExtractionError(
                            "invalid_timeline",
                            "decoded presentation timestamps must be strictly increasing",
                        )
                    if relative_time > caps.max_duration_sec:
                        raise ExtractionError("video_limits_exceeded", "video duration exceeds cap")
                    previous_time = relative_time
                    yield DecodedFrame(
                        time_sec=relative_time,
                        rgb=_rotate_rgb(
                            frame.to_ndarray(format="rgb24"),
                            metadata.rotation_degrees,
                        ),
                    )
        except ExtractionError:
            raise
        except Exception as error:
            raise ExtractionError("video_invalid", "video decoding failed") from error


class MediaPipeTasksPoseDetector:
    """Thin Pose Landmarker VIDEO-mode adapter with pinned model verification."""

    def __init__(
        self,
        *,
        model_path: Path,
        expected_model_sha256: str,
        model_version: str,
        num_poses: int = 2,
        min_detection_confidence: float = 0.5,
        min_presence_confidence: float = 0.5,
        min_tracking_confidence: float = 0.5,
    ):
        actual_sha256 = hashlib.sha256(model_path.read_bytes()).hexdigest()
        if actual_sha256 != expected_model_sha256:
            raise ExtractionError(
                "model_invalid", "pose model checksum does not match pinned value"
            )
        try:
            import mediapipe as mp
        except ImportError as error:
            raise RuntimeError("install the dance-grader runtime extra to run MediaPipe") from error

        options = mp.tasks.vision.PoseLandmarkerOptions(
            base_options=mp.tasks.BaseOptions(model_asset_path=str(model_path)),
            running_mode=mp.tasks.vision.RunningMode.VIDEO,
            num_poses=num_poses,
            min_pose_detection_confidence=min_detection_confidence,
            min_pose_presence_confidence=min_presence_confidence,
            min_tracking_confidence=min_tracking_confidence,
            output_segmentation_masks=False,
        )
        self._mp = mp
        self._landmarker = mp.tasks.vision.PoseLandmarker.create_from_options(options)
        self.model_version = model_version
        self.model_sha256 = actual_sha256
        self.runtime_version = str(mp.__version__)

    def detect(
        self,
        rgb: np.ndarray,
        timestamp_ms: int,
    ) -> tuple[tuple[DetectedLandmark, ...], ...]:
        image = self._mp.Image(image_format=self._mp.ImageFormat.SRGB, data=rgb)
        result = self._landmarker.detect_for_video(image, timestamp_ms)
        return tuple(
            tuple(
                DetectedLandmark(
                    x=float(landmark.x),
                    y=float(landmark.y),
                    z=float(landmark.z),
                    visibility=float(landmark.visibility or 0.0),
                    presence=float(landmark.presence or 0.0),
                )
                for landmark in pose
            )
            for pose in result.pose_landmarks
        )

    def close(self) -> None:
        self._landmarker.close()


def _validate_video_metadata(metadata: VideoMetadata, caps: ExtractionCaps) -> None:
    if metadata.width <= 0 or metadata.height <= 0:
        raise ExtractionError("video_invalid", "video dimensions are unavailable")
    if metadata.width > caps.max_width or metadata.height > caps.max_height:
        raise ExtractionError("video_limits_exceeded", "video resolution exceeds extraction cap")


def _landmarks_payload(
    poses: tuple[tuple[DetectedLandmark, ...], ...],
) -> list[dict[str, float]] | None:
    if not poses:
        return None
    pose = poses[0]
    if len(pose) != 33:
        raise ExtractionError("pose_result_invalid", "MediaPipe pose must contain 33 landmarks")
    return [
        {
            "x": landmark.x,
            "y": landmark.y,
            "z": landmark.z,
            "visibility": min(landmark.visibility, landmark.presence),
        }
        for landmark in pose
    ]


def _coverage_metrics(
    sequence: PoseSequence,
    caps: ExtractionCaps,
    decoded_count: int,
    maximum_pose_count: int,
) -> ExtractionMetrics:
    detected = [frame.landmarks is not None for frame in sequence.frames]
    usable = []
    current_gap = 0.0
    maximum_gap = 0.0
    previous_time = sequence.frames[0].time_sec
    for frame in sequence.frames:
        step = max(frame.time_sec - previous_time, 1.0 / sequence.fps)
        previous_time = frame.time_sec
        if frame.landmarks is None:
            current_gap += step
            maximum_gap = max(maximum_gap, current_gap)
            usable.append(False)
            continue
        current_gap = 0.0
        visibility = frame.landmarks[SCORED_LANDMARKS, 3]
        usable.append(
            float(np.mean(visibility >= caps.min_joint_visibility))
            >= caps.min_visible_joint_fraction
        )

    features = build_features(
        sequence,
        ScorerConfig(
            target_fps=caps.inference_fps,
            min_joint_visibility=caps.min_joint_visibility,
            min_visible_joint_fraction=caps.min_visible_joint_fraction,
        ),
    )
    motion = np.linalg.norm(np.nan_to_num(features.velocity, nan=0.0), axis=2)
    motion_energy = float(np.mean(motion))
    return ExtractionMetrics(
        duration_ms=round(sequence.duration_sec * 1000),
        decoded_frame_count=decoded_count,
        sampled_frame_count=len(sequence.frames),
        pose_detection_bps=round(float(np.mean(detected)) * 10_000),
        usable_coverage_bps=round(float(np.mean(usable)) * 10_000),
        max_missing_gap_ms=round(maximum_gap * 1000),
        maximum_pose_count=maximum_pose_count,
        motion_energy_bps=round(min(motion_energy, 1.0) * 10_000),
    )


def extract_pose_sequence(
    path: Path,
    *,
    decoder: VideoDecoder,
    detector: PoseDetector,
    caps: ExtractionCaps | None = None,
    feature_schema_version: str = "dance_pose_2d_gate0_v1",
) -> ExtractionResult:
    caps = caps or ExtractionCaps()
    frames: list[dict[str, Any]] = []
    decoded_count = 0
    previous_timestamp_ms = -1
    previous_decoded_time = -1.0
    next_sample_time = 0.0
    maximum_pose_count = 0
    try:
        metadata = decoder.inspect(path, caps)
        _validate_video_metadata(metadata, caps)
        for frame in decoder.decode_frames(path, metadata, caps):
            decoded_count += 1
            if decoded_count > caps.max_decoded_frames:
                raise ExtractionError("video_limits_exceeded", "decoded frame count exceeds cap")
            if decoded_count * metadata.width * metadata.height > caps.max_total_pixels:
                raise ExtractionError("video_limits_exceeded", "decoded pixel count exceeds cap")
            if not np.isfinite(frame.time_sec) or frame.time_sec <= previous_decoded_time:
                raise ExtractionError(
                    "invalid_timeline",
                    "decoded presentation timestamps must be finite and strictly increasing",
                )
            if frame.time_sec > caps.max_duration_sec:
                raise ExtractionError("video_limits_exceeded", "video duration exceeds cap")
            if frame.rgb.ndim != 3 or frame.rgb.shape[2] != 3:
                raise ExtractionError("video_invalid", "decoded frame must be RGB")
            if frame.rgb.shape[:2] != (metadata.height, metadata.width):
                raise ExtractionError("video_invalid", "decoded frame dimensions are inconsistent")
            previous_decoded_time = frame.time_sec
            if frame.time_sec + 1e-9 < next_sample_time:
                continue
            next_sample_time = frame.time_sec + 1.0 / caps.inference_fps
            timestamp_ms = round(frame.time_sec * 1000)
            if timestamp_ms <= previous_timestamp_ms:
                raise ExtractionError(
                    "invalid_timeline",
                    "inference timestamps must be strictly increasing milliseconds",
                )
            previous_timestamp_ms = timestamp_ms
            poses = detector.detect(frame.rgb, timestamp_ms)
            maximum_pose_count = max(maximum_pose_count, len(poses))
            if len(poses) > 1:
                raise ExtractionError("multiple_people", "multiple poses detected in video")
            frames.append(
                {
                    "time_sec": frame.time_sec,
                    "landmarks": _landmarks_payload(poses),
                }
            )
    finally:
        detector.close()

    if decoded_count < 2 or len(frames) < 2:
        raise ExtractionError("video_invalid", "video has too few decoded or sampleable frames")
    sequence = PoseSequence.from_dict(
        {
            "fps": caps.inference_fps,
            "width": metadata.width,
            "height": metadata.height,
            "frames": frames,
        }
    )
    metrics = _coverage_metrics(sequence, caps, decoded_count, maximum_pose_count)
    if metrics.pose_detection_bps < round(caps.min_pose_presence * 10_000):
        raise ExtractionError(
            "insufficient_pose_presence", "pose presence is below required coverage"
        )
    if metrics.usable_coverage_bps < round(caps.min_usable_coverage * 10_000):
        raise ExtractionError(
            "insufficient_coverage", "full-body visibility is below required coverage"
        )
    if metrics.max_missing_gap_ms > round(caps.max_missing_gap_sec * 1000):
        raise ExtractionError(
            "insufficient_pose_presence", "missing-pose gap exceeds allowed duration"
        )
    if metrics.motion_energy_bps < round(caps.min_motion_energy * 10_000):
        raise ExtractionError("insufficient_motion", "reference contains insufficient motion")

    return ExtractionResult(
        pose_sequence=sequence,
        metrics=metrics,
        pose_model_version=detector.model_version,
        pose_model_sha256=detector.model_sha256,
        pose_runtime_version=detector.runtime_version,
        feature_schema_version=feature_schema_version,
    )
