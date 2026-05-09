#!/usr/bin/env python3
"""Submit a subsd proving request to RunPod and fulfill it back into subsd.

This is a targeted hard-gate smoke helper. It expects the raw response from
GET /spaces/:space/proving/next, including the outer Borsh Option tag.
"""

from __future__ import annotations

import base64
import json
import os
import sys
import time
import urllib.error
import urllib.request
from pathlib import Path


def env(*names: str) -> str:
    for name in names:
        value = os.environ.get(name)
        if value:
            return value
    joined = " or ".join(names)
    raise SystemExit(f"missing required env var: {joined}")


def http_json(method: str, url: str, payload: object | None, api_key: str | None = None) -> object:
    body = None if payload is None else json.dumps(payload).encode("utf8")
    request = urllib.request.Request(url, data=body, method=method)
    request.add_header("content-type", "application/json")
    if api_key:
        request.add_header("authorization", f"Bearer {api_key}")
    try:
        with urllib.request.urlopen(request, timeout=60) as response:
            return json.loads(response.read().decode("utf8"))
    except urllib.error.HTTPError as error:
        detail = error.read().decode("utf8", errors="replace")
        raise SystemExit(f"{method} {url} failed: {error.code} {detail}") from error


def http_binary_post(url: str, payload: bytes) -> bytes:
    request = urllib.request.Request(url, data=payload, method="POST")
    request.add_header("content-type", "application/octet-stream")
    try:
        with urllib.request.urlopen(request, timeout=60) as response:
            return response.read()
    except urllib.error.HTTPError as error:
        detail = error.read().decode("utf8", errors="replace")
        raise SystemExit(f"POST {url} failed: {error.code} {detail}") from error


def main() -> None:
    proving_path = Path(sys.argv[1] if len(sys.argv) > 1 else "/tmp/proving-next.bin")
    space = os.environ.get("SUBSD_SPACE", "@test10000")
    subsd_base_url = os.environ.get("SUBSD_BASE_URL", "http://127.0.0.1:7777").rstrip("/")
    endpoint_id = env("RUNPOD_PROVER_ENDPOINT_ID", "COMMUNITY_PROTOCOL_ISSUER_RUNPOD_ENDPOINT_ID")
    api_key = env("RUNPOD_API_KEY", "COMMUNITY_PROTOCOL_ISSUER_RUNPOD_API_KEY")

    option_payload = proving_path.read_bytes()
    if option_payload == b"\x00":
        raise SystemExit("subsd returned Option::None; no proving request is pending")
    if not option_payload or option_payload[0] != 1:
        raise SystemExit(f"unexpected Borsh Option tag: {option_payload[0] if option_payload else 'empty'}")

    proving_request = option_payload[1:]
    if len(proving_request) < 9:
        raise SystemExit("inner ProvingRequest is too short")

    run_url = f"https://api.runpod.ai/v2/{endpoint_id}/run"
    status_url = f"https://api.runpod.ai/v2/{endpoint_id}/status"
    payload = {
        "input": {
            "batch_id": "local-subsd-hard-gate",
            "parent_space": space,
            "proof_input_ref": f"file://{proving_path}",
            "proof_input_base64": base64.b64encode(proving_request).decode("ascii"),
        }
    }

    submitted = http_json("POST", run_url, payload, api_key)
    job_id = str(submitted.get("id") or submitted.get("jobId") or "")
    if not job_id:
        raise SystemExit(f"RunPod did not return a job id: {submitted}")
    print(json.dumps({"submitted": True, "job_id": job_id}, sort_keys=True))

    deadline = time.monotonic() + int(os.environ.get("RUNPOD_SMOKE_TIMEOUT_SECONDS", "7200"))
    while time.monotonic() < deadline:
        status = http_json("GET", f"{status_url}/{job_id}", None, api_key)
        state = str(status.get("status") or "").upper()
        print(json.dumps({"job_id": job_id, "status": state}, sort_keys=True))
        if state in {"COMPLETED", "FAILED", "CANCELLED", "TIMED_OUT"}:
            break
        time.sleep(int(os.environ.get("RUNPOD_SMOKE_POLL_SECONDS", "30")))
    else:
        raise SystemExit(f"RunPod job did not complete before timeout: {job_id}")

    if state != "COMPLETED":
        raise SystemExit(f"RunPod job ended with {state}: {status}")

    output = status.get("output")
    if not isinstance(output, dict):
        raise SystemExit(f"RunPod completed without object output: {status}")
    fulfill_payload_base64 = output.get("fulfill_payload_base64")
    if not isinstance(fulfill_payload_base64, str):
        raise SystemExit(f"RunPod output missing fulfill_payload_base64: {output}")

    fulfill_payload = base64.b64decode(fulfill_payload_base64, validate=True)
    fulfill_url = f"{subsd_base_url}/spaces/{space}/proving/fulfill"
    fulfill_response = http_binary_post(fulfill_url, fulfill_payload)
    print(json.dumps({
        "fulfilled": True,
        "job_id": job_id,
        "fulfill_payload_bytes": len(fulfill_payload),
        "subsd_response": fulfill_response.decode("utf8", errors="replace"),
    }, sort_keys=True))


if __name__ == "__main__":
    main()
