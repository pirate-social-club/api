from __future__ import annotations

import hashlib
import json
import os
import tempfile
import time
import urllib.request
from pathlib import Path

import modal
from fastapi import Request

MODEL_PATH = Path("/models/pose_landmarker_full.task")
MODEL_SHA256 = "5134a3aad27a58b93da0088d431f366da362b44e3ccfbe3462b3827a839011b1"
MODEL_VERSION = "pose_landmarker_full_float16_v1"
APP_NAME = "pirate-dance-grader"


def _install_pose_model() -> None:
    url = (
        "https://storage.googleapis.com/mediapipe-models/pose_landmarker/"
        "pose_landmarker_full/float16/1/pose_landmarker_full.task"
    )
    destination = Path("/models/pose_landmarker_full.task")
    destination.parent.mkdir(parents=True, exist_ok=True)
    with urllib.request.urlopen(url, timeout=60) as response:
        body = response.read(10_000_000)
    if len(body) != 9_398_198:
        raise RuntimeError("unexpected pose model byte length")
    if hashlib.sha256(body).hexdigest() != (
        "5134a3aad27a58b93da0088d431f366da362b44e3ccfbe3462b3827a839011b1"
    ):
        raise RuntimeError("pose model checksum mismatch")
    destination.write_bytes(body)


image = (
    modal.Image.debian_slim(python_version="3.12")
    .uv_sync(extras=["runtime", "service"])
    .add_local_python_source("dance_grader")
    .run_function(_install_pose_model)
)
app = modal.App(APP_NAME)
service_secret = modal.Secret.from_name("dance-grader-service")


def _callback(payload: dict, result: dict) -> None:
    from dance_grader.service_protocol import canonical_json, post_signed_callback

    result["completed_at"] = int(time.time())
    result["result_digest"] = hashlib.sha256(canonical_json(result)).hexdigest()

    post_signed_callback(
        url=payload["callback_url"],
        subject=payload["subject"],
        payload=result,
        key=os.environ["DANCE_GRADER_CALLBACK_HMAC_KEY"].encode(),
        key_version=os.environ["DANCE_GRADER_CALLBACK_KEY_VERSION"],
    )


def _extract(path: Path):
    from dance_grader import (
        MediaPipeTasksPoseDetector,
        PyAvVideoDecoder,
        extract_pose_sequence,
    )

    detector = MediaPipeTasksPoseDetector(
        model_path=MODEL_PATH,
        expected_model_sha256=MODEL_SHA256,
        model_version=MODEL_VERSION,
    )
    return extract_pose_sequence(path, decoder=PyAvVideoDecoder(), detector=detector)


@app.function(image=image, secrets=[service_secret], cpu=1.0, memory=4096, timeout=300)
def extract_reference_features(payload: dict) -> None:
    from dance_grader import ScorerConfig, build_reference_artifact
    from dance_grader.service_protocol import (
        download_verified,
        reference_failure_reason,
        upload_bytes,
    )

    result: dict
    try:
        config = ScorerConfig()
        if payload["pose_model_version"] != MODEL_VERSION:
            raise ValueError("unsupported pose model version")
        if payload["pose_model_sha256"] != MODEL_SHA256:
            raise ValueError("unsupported pose model checksum")
        if payload["feature_schema_version"] != config.feature_schema_version:
            raise ValueError("unsupported feature schema version")
        if payload["scorer_version"] != config.version:
            raise ValueError("unsupported scorer version")
        with tempfile.TemporaryDirectory(prefix="dance-reference-") as temporary:
            video = Path(temporary) / "reference.video"
            download_verified(
                url=payload["media_get_url"],
                destination=video,
                expected_sha256=payload["reference_content_sha256"],
                max_bytes=int(payload["max_media_bytes"]),
            )
            extraction = _extract(video)
            artifact = build_reference_artifact(
                extraction,
                reference_content_sha256=payload["reference_content_sha256"],
                config=config,
            )
            body = artifact.canonical_json()
            upload_bytes(
                url=payload["artifact_put_url"],
                body=body,
                content_type="application/json",
            )
            result = {
                "subject": payload["subject"],
                "outcome": "ready",
                "reference_feature_sha256": artifact.sha256,
                "reference_feature_size_bytes": len(body),
                "metrics": {
                    **extraction.metrics.__dict__,
                    "width": extraction.pose_sequence.width,
                    "height": extraction.pose_sequence.height,
                    "fps_millihertz": round(extraction.pose_sequence.fps * 1000),
                },
                "versions": {
                    "pose_model": extraction.pose_model_version,
                    "pose_model_sha256": extraction.pose_model_sha256,
                    "pose_runtime": extraction.pose_runtime_version,
                    "feature_schema": extraction.feature_schema_version,
                    "scorer": config.version,
                    "artifact": artifact.artifact_version,
                },
            }
    except Exception as error:  # noqa: BLE001 - terminal job boundary must callback on all failures
        result = {
            "subject": payload["subject"],
            "outcome": "failed",
            "reason": reference_failure_reason(error),
        }
    _callback(payload, result)


@app.function(image=image, secrets=[service_secret], cpu=1.0, memory=4096, timeout=300)
def grade_attempt(payload: dict) -> None:
    from dance_grader import (
        MirrorPolicy,
        ReferenceFeatureArtifact,
        ScorerConfig,
        grade_dance_against_features,
    )
    from dance_grader.service_protocol import download_verified

    result: dict
    try:
        with tempfile.TemporaryDirectory(prefix="dance-attempt-") as temporary:
            root = Path(temporary)
            attempt_path = root / "attempt.video"
            artifact_path = root / "reference-features.json"
            download_verified(
                url=payload["media_get_url"],
                destination=attempt_path,
                expected_sha256=payload["attempt_content_sha256"],
                max_bytes=int(payload["max_media_bytes"]),
            )
            download_verified(
                url=payload["artifact_get_url"],
                destination=artifact_path,
                expected_sha256=payload["reference_feature_sha256"],
                max_bytes=int(payload["max_artifact_bytes"]),
            )
            artifact = ReferenceFeatureArtifact.from_json(artifact_path.read_bytes())
            if artifact.reference_content_sha256 != payload["reference_content_sha256"]:
                raise ValueError("reference content binding mismatch")
            config = ScorerConfig()
            expected = {
                "pose_model_version": artifact.pose_model_version,
                "pose_model_sha256": artifact.pose_model_sha256,
                "feature_schema_version": artifact.feature_schema_version,
                "scorer_version": config.version,
                "artifact_version": artifact.artifact_version,
            }
            for key, actual in expected.items():
                if payload[key] != actual:
                    raise ValueError(f"{key} binding mismatch")
            if artifact.pose_model_version != MODEL_VERSION:
                raise ValueError("reference artifact pose model is unsupported")
            if artifact.pose_model_sha256 != MODEL_SHA256:
                raise ValueError("reference artifact model checksum is unsupported")
            extraction = _extract(attempt_path)
            grade = grade_dance_against_features(
                artifact.to_feature_sequence(),
                artifact.duration_ms / 1000,
                extraction.pose_sequence,
                mirror_policy=MirrorPolicy(payload["mirror_policy"]),
                config=config,
                reference_versions={
                    "pose_model": artifact.pose_model_version,
                    "pose_model_sha256": artifact.pose_model_sha256,
                    "pose_runtime": artifact.pose_runtime_version,
                    "reference_artifact": artifact.artifact_version,
                    "reference_feature_sha256": payload["reference_feature_sha256"],
                },
            )
            result = {
                "subject": payload["subject"],
                "outcome": grade.outcome,
                "reason": grade.reason,
                "grade": grade.to_dict(),
                "extraction_metrics": extraction.metrics.__dict__,
            }
    except Exception:  # noqa: BLE001 - terminal job boundary must callback on all failures
        result = {
            "subject": payload["subject"],
            "outcome": "failed",
            "reason": "scoring_unavailable",
        }
    _callback(payload, result)


async def _authenticated_payload(request) -> dict:
    from fastapi import HTTPException

    from dance_grader.service_protocol import verify_request

    body = await request.body()
    try:
        payload = json.loads(body)
        timestamp = int(request.headers["x-dance-grader-timestamp"])
        signature = request.headers["x-dance-grader-signature"]
        key_version = request.headers["x-dance-grader-key-version"]
        subject = str(payload["subject"])
    except (KeyError, TypeError, ValueError, json.JSONDecodeError) as error:
        raise HTTPException(status_code=400, detail="invalid dispatch request") from error
    if key_version != os.environ["DANCE_GRADER_DISPATCH_KEY_VERSION"] or not verify_request(
        key=os.environ["DANCE_GRADER_DISPATCH_HMAC_KEY"].encode(),
        method="POST",
        path=request.url.path,
        timestamp=timestamp,
        subject=subject,
        body=body,
        signature=signature,
    ):
        raise HTTPException(status_code=401, detail="invalid dispatch signature")
    return payload


@app.function(image=image, secrets=[service_secret])
@modal.fastapi_endpoint(method="POST")
async def dispatch_extract_reference_features(request: Request):
    payload = await _authenticated_payload(request)
    call = extract_reference_features.spawn(payload)
    return {"dispatch_id": call.object_id}


@app.function(image=image, secrets=[service_secret])
@modal.fastapi_endpoint(method="POST")
async def dispatch_grade_attempt(request: Request):
    payload = await _authenticated_payload(request)
    call = grade_attempt.spawn(payload)
    return {"dispatch_id": call.object_id}
