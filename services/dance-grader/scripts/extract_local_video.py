from __future__ import annotations

import argparse
import hashlib
import json
import os
import tempfile
from dataclasses import asdict
from pathlib import Path

from dance_grader import (
    MediaPipeTasksPoseDetector,
    PyAvVideoDecoder,
    ScorerConfig,
    build_reference_artifact,
    extract_pose_sequence,
)


def _sha256(path: Path) -> str:
    digest = hashlib.sha256()
    with path.open("rb") as source:
        while chunk := source.read(1024 * 1024):
            digest.update(chunk)
    return digest.hexdigest()


def _atomic_private_write(path: Path, body: bytes) -> None:
    path.parent.mkdir(mode=0o700, parents=True, exist_ok=True)
    descriptor, temporary_name = tempfile.mkstemp(prefix=f".{path.name}.", dir=path.parent)
    temporary = Path(temporary_name)
    try:
        os.fchmod(descriptor, 0o600)
        with os.fdopen(descriptor, "wb") as destination:
            destination.write(body)
            destination.flush()
            os.fsync(destination.fileno())
        temporary.replace(path)
    except BaseException:
        temporary.unlink(missing_ok=True)
        raise


def _pose_json(extraction) -> bytes:
    frames = []
    for frame in extraction.pose_sequence.frames:
        landmarks = None
        if frame.landmarks is not None:
            landmarks = [
                {"x": row[0], "y": row[1], "z": row[2], "visibility": row[3]}
                for row in frame.landmarks
            ]
        frames.append({"time_sec": frame.time_sec, "landmarks": landmarks})
    return json.dumps(
        {
            "fps": extraction.pose_sequence.fps,
            "width": extraction.pose_sequence.width,
            "height": extraction.pose_sequence.height,
            "frames": frames,
        },
        sort_keys=True,
        separators=(",", ":"),
        allow_nan=False,
    ).encode()


def main() -> None:
    parser = argparse.ArgumentParser(
        description="Extract one consented local corpus video without uploading it."
    )
    parser.add_argument("--video", required=True, type=Path)
    parser.add_argument("--model", required=True, type=Path)
    parser.add_argument(
        "--model-pin",
        type=Path,
        default=Path("models/pose_landmarker_full_float16_v1.json"),
    )
    parser.add_argument("--pose-output", required=True, type=Path)
    parser.add_argument(
        "--reference-artifact-output",
        type=Path,
        help="Also write immutable reference features for a reference video.",
    )
    parser.add_argument("--report-output", required=True, type=Path)
    args = parser.parse_args()

    pin = json.loads(args.model_pin.read_text())
    model_sha256 = _sha256(args.model)
    if model_sha256 != pin["sha256"]:
        raise SystemExit("pose model checksum does not match the repository pin")

    extraction = extract_pose_sequence(
        args.video,
        decoder=PyAvVideoDecoder(),
        detector=MediaPipeTasksPoseDetector(
            model_path=args.model,
            expected_model_sha256=pin["sha256"],
            model_version=pin["model_version"],
        ),
    )
    video_sha256 = _sha256(args.video)
    _atomic_private_write(args.pose_output, _pose_json(extraction))

    reference_artifact = None
    if args.reference_artifact_output:
        reference_artifact = build_reference_artifact(
            extraction,
            reference_content_sha256=video_sha256,
            config=ScorerConfig(),
        )
        _atomic_private_write(
            args.reference_artifact_output,
            reference_artifact.canonical_json(),
        )

    report = {
        "video_sha256": video_sha256,
        "pose_output_sha256": _sha256(args.pose_output),
        "reference_feature_sha256": (
            reference_artifact.sha256 if reference_artifact is not None else None
        ),
        "metrics": asdict(extraction.metrics),
        "versions": {
            "pose_model": extraction.pose_model_version,
            "pose_model_sha256": extraction.pose_model_sha256,
            "pose_runtime": extraction.pose_runtime_version,
            "feature_schema": extraction.feature_schema_version,
            "scorer": ScorerConfig().version,
        },
    }
    _atomic_private_write(
        args.report_output,
        json.dumps(report, sort_keys=True, indent=2).encode() + b"\n",
    )


if __name__ == "__main__":
    main()
