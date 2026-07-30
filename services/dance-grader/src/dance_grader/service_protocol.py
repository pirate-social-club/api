from __future__ import annotations

import hashlib
import hmac
import json
import time
from pathlib import Path
from urllib.parse import urlsplit

REFERENCE_PERMANENT_FAILURE_CODES = frozenset(
    {
        "video_invalid",
        "video_limits_exceeded",
        "invalid_timeline",
        "multiple_people",
        "pose_result_invalid",
        "insufficient_pose_presence",
        "insufficient_coverage",
        "insufficient_motion",
    }
)

ATTEMPT_REJECTION_CODE_MAP = {
    "content_hash_mismatch": "upload_invalid",
    "download_limit_exceeded": "upload_invalid",
    "video_invalid": "video_invalid",
    "video_limits_exceeded": "duration_out_of_range",
    "invalid_timeline": "video_invalid",
    "multiple_people": "multiple_people",
    "pose_result_invalid": "video_invalid",
    "insufficient_pose_presence": "insufficient_pose_presence",
    "insufficient_coverage": "insufficient_coverage",
    "insufficient_motion": "insufficient_motion",
}

class DownloadVerificationError(ValueError):
    def __init__(self, code: str, message: str) -> None:
        super().__init__(message)
        self.code = code


def reference_failure_reason(error: BaseException) -> str:
    code = getattr(error, "code", None)
    return (
        code
        if isinstance(code, str) and code in REFERENCE_PERMANENT_FAILURE_CODES
        else ("scoring_unavailable")
    )


def attempt_failure_reason(error: BaseException) -> str:
    code = getattr(error, "code", None)
    return (
        ATTEMPT_REJECTION_CODE_MAP.get(code, "scoring_unavailable")
        if isinstance(code, str)
        else "scoring_unavailable"
    )


def canonical_json(value: dict) -> bytes:
    return json.dumps(value, sort_keys=True, separators=(",", ":"), allow_nan=False).encode()


def signature_payload(
    *,
    method: str,
    path: str,
    timestamp: int,
    subject: str,
    body: bytes,
) -> bytes:
    body_sha256 = hashlib.sha256(body).hexdigest()
    return f"{method.upper()}\n{path}\n{timestamp}\n{subject}\n{body_sha256}".encode()


def sign_request(
    *,
    key: bytes,
    method: str,
    url_or_path: str,
    timestamp: int,
    subject: str,
    body: bytes,
) -> str:
    path = urlsplit(url_or_path).path if "://" in url_or_path else url_or_path
    payload = signature_payload(
        method=method,
        path=path,
        timestamp=timestamp,
        subject=subject,
        body=body,
    )
    return hmac.new(key, payload, hashlib.sha256).hexdigest()


def verify_request(
    *,
    key: bytes,
    method: str,
    path: str,
    timestamp: int,
    subject: str,
    body: bytes,
    signature: str,
    now: int | None = None,
    clock_window_sec: int = 300,
) -> bool:
    current = int(time.time()) if now is None else now
    if abs(current - timestamp) > clock_window_sec:
        return False
    expected = sign_request(
        key=key,
        method=method,
        url_or_path=path,
        timestamp=timestamp,
        subject=subject,
        body=body,
    )
    return hmac.compare_digest(expected, signature)


def download_verified(
    *,
    url: str,
    destination: Path,
    expected_sha256: str,
    max_bytes: int,
) -> int:
    import httpx

    digest = hashlib.sha256()
    size = 0
    with httpx.stream("GET", url, follow_redirects=False, timeout=60.0) as response:
        response.raise_for_status()
        with destination.open("xb") as output:
            for chunk in response.iter_bytes():
                size += len(chunk)
                if size > max_bytes:
                    raise DownloadVerificationError(
                        "download_limit_exceeded", "download exceeds byte cap"
                    )
                digest.update(chunk)
                output.write(chunk)
    if digest.hexdigest() != expected_sha256:
        destination.unlink(missing_ok=True)
        raise DownloadVerificationError(
            "content_hash_mismatch",
            "download SHA-256 does not match expected content",
        )
    return size


def upload_bytes(*, url: str, body: bytes, content_type: str) -> None:
    import httpx

    response = httpx.put(
        url,
        content=body,
        headers={"content-type": content_type},
        follow_redirects=False,
        timeout=60.0,
    )
    response.raise_for_status()


def post_signed_callback(
    *,
    url: str,
    subject: str,
    payload: dict,
    key: bytes,
    key_version: str,
) -> None:
    import httpx

    body = canonical_json(payload)
    timestamp = int(time.time())
    signature = sign_request(
        key=key,
        method="POST",
        url_or_path=url,
        timestamp=timestamp,
        subject=subject,
        body=body,
    )
    response = httpx.post(
        url,
        content=body,
        headers={
            "content-type": "application/json",
            "x-dance-grader-key-version": key_version,
            "x-dance-grader-timestamp": str(timestamp),
            "x-dance-grader-signature": signature,
        },
        follow_redirects=False,
        timeout=30.0,
    )
    response.raise_for_status()
