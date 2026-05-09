import argparse
import base64
import json
import subprocess
import sys
import time
import urllib.error
import urllib.request
from pathlib import Path


def _request(method: str, url: str, body: bytes | None = None) -> tuple[int, bytes]:
    request = urllib.request.Request(url, data=body, method=method)
    if body is not None:
        request.add_header("content-type", "application/octet-stream")
    try:
        with urllib.request.urlopen(request, timeout=30) as response:
            return response.status, response.read()
    except urllib.error.HTTPError as exc:
        return exc.code, exc.read()


def _json_response(method: str, url: str, body: bytes | None = None) -> dict:
    status, payload = _request(method, url, body)
    if status < 200 or status >= 300:
        raise RuntimeError(f"{method} {url} returned {status}: {payload.decode('utf8', errors='replace')}")
    parsed = json.loads(payload.decode("utf8"))
    if not isinstance(parsed, dict):
        raise RuntimeError(f"{method} {url} returned non-object JSON")
    return parsed


def _wait_for_server(base_url: str, timeout_seconds: int) -> None:
    deadline = time.monotonic() + timeout_seconds
    last_error = "not attempted"
    while time.monotonic() < deadline:
        try:
            status, _ = _request("GET", f"{base_url}/health")
            if status == 200:
                return
            last_error = f"status {status}"
        except Exception as exc:
            last_error = str(exc)
        time.sleep(0.5)
    raise RuntimeError(f"subs-prover server did not become healthy: {last_error}")


def _wait_for_job(base_url: str, job_id: str, timeout_seconds: int, poll_seconds: float) -> None:
    deadline = time.monotonic() + timeout_seconds
    while time.monotonic() < deadline:
        status = _json_response("GET", f"{base_url}/jobs/{job_id}")
        state = str(status.get("status", "")).lower()
        if state == "complete":
            return
        if state == "failed":
            raise RuntimeError(f"subs-prover job failed: {status.get('error')}")
        time.sleep(poll_seconds)
    raise RuntimeError(f"subs-prover job {job_id} exceeded timeout")


def prove_with_server(input_path: Path, output_path: Path, port: int, timeout_seconds: int, poll_seconds: float) -> None:
    server = subprocess.Popen(
        ["subs-prover", "--server", "--server-port", str(port)],
        stdout=sys.stderr,
        stderr=sys.stderr,
        text=False,
    )
    base_url = f"http://127.0.0.1:{port}"
    try:
        _wait_for_server(base_url, 120)
        submitted = _json_response("POST", f"{base_url}/prove", input_path.read_bytes())
        job_id = submitted.get("job_id")
        if not isinstance(job_id, str) or not job_id:
            raise RuntimeError("subs-prover /prove response did not include job_id")
        _wait_for_job(base_url, job_id, timeout_seconds, poll_seconds)
        status, receipt = _request("GET", f"{base_url}/jobs/{job_id}/receipt")
        if status < 200 or status >= 300:
            raise RuntimeError(f"receipt download returned {status}: {receipt.decode('utf8', errors='replace')}")
        output_path.write_text(base64.b64encode(receipt).decode("ascii"), encoding="utf8")
    finally:
        server.terminate()
        try:
            server.wait(timeout=30)
        except subprocess.TimeoutExpired:
            server.kill()
            server.wait(timeout=30)


def main() -> None:
    parser = argparse.ArgumentParser(description="Run subs-prover server against one Borsh ProvingRequest")
    parser.add_argument("--input", required=True, type=Path)
    parser.add_argument("--output", required=True, type=Path)
    parser.add_argument("--port", type=int, default=8888)
    parser.add_argument("--timeout-seconds", type=int, default=604800)
    parser.add_argument("--poll-seconds", type=float, default=5.0)
    args = parser.parse_args()
    prove_with_server(args.input, args.output, args.port, args.timeout_seconds, args.poll_seconds)


if __name__ == "__main__":
    main()
