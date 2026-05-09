import base64
import json
import os
import shlex
import subprocess
import tempfile
from pathlib import Path
from typing import Any


class ProofWorkerError(RuntimeError):
    pass


def _fulfill_prefix_from_proving_request(proving_request: bytes) -> bytes:
    if len(proving_request) < 9:
        raise ProofWorkerError("proof_input_base64 is too short to contain a ProvingRequest tag and commitment_id")
    request_type = proving_request[0]
    if request_type not in (0, 1):
        raise ProofWorkerError(f"unsupported ProvingRequest variant tag: {request_type}")
    commitment_id_le = proving_request[1:9]
    return commitment_id_le + bytes([request_type])


def _strict_base64(value: Any, field_name: str) -> str:
    if not isinstance(value, str) or not value.strip():
        raise ProofWorkerError(f"{field_name} is required")
    normalized = value.strip()
    try:
        base64.b64decode(normalized, validate=True)
    except Exception as exc:
        raise ProofWorkerError(f"{field_name} must be valid base64") from exc
    return normalized


def _command_template(env: dict[str, str]) -> list[str]:
    raw_json = env.get("SUBS_PROVER_COMMAND_JSON", "").strip()
    if raw_json:
        parsed = json.loads(raw_json)
        if not isinstance(parsed, list) or not all(isinstance(part, str) and part for part in parsed):
            raise ProofWorkerError("SUBS_PROVER_COMMAND_JSON must be a JSON array of non-empty strings")
        return parsed

    raw = env.get("SUBS_PROVER_COMMAND", "").strip()
    if not raw:
        raise ProofWorkerError("SUBS_PROVER_COMMAND_JSON or SUBS_PROVER_COMMAND is required")
    return shlex.split(raw)


def _format_command(template: list[str], input_path: Path, output_path: Path) -> list[str]:
    return [
        part
        .replace("{input_path}", str(input_path))
        .replace("{output_path}", str(output_path))
        for part in template
    ]


def _read_payload(stdout: str, output_path: Path) -> str:
    if output_path.exists():
        output_text = output_path.read_text(encoding="utf8")
        if output_text.strip():
            return _strict_base64(output_text, "fulfill_payload_base64")

    text = stdout.strip()
    if not text:
        raise ProofWorkerError("prover did not write an output file or stdout payload")
    if not text.startswith("{"):
        raise ProofWorkerError("prover stdout must be JSON when no output file is written")

    parsed = json.loads(text)
    if not isinstance(parsed, dict):
        raise ProofWorkerError("prover stdout JSON must be an object")
    for key in ("fulfill_payload_base64", "fulfillPayloadBase64", "proof_receipt_payload_base64"):
        if key in parsed:
            return _strict_base64(parsed[key], key)
    raise ProofWorkerError("prover stdout JSON did not include fulfill_payload_base64")


def _frame_fulfill_payload(proof_input: bytes, receipt_base64: str) -> str:
    prefix = _fulfill_prefix_from_proving_request(proof_input)
    receipt = base64.b64decode(receipt_base64, validate=True)
    if not receipt:
        raise ProofWorkerError("fulfill_payload_base64 receipt is empty")
    return base64.b64encode(prefix + receipt).decode("ascii")


def handle_proof_job(job: dict[str, Any], env: dict[str, str] | None = None) -> dict[str, Any]:
    job_input = job.get("input")
    if not isinstance(job_input, dict):
        raise ProofWorkerError("job input must be an object")

    runtime_env = dict(os.environ if env is None else env)
    proof_input_base64 = _strict_base64(job_input.get("proof_input_base64"), "proof_input_base64")
    command_template = _command_template(runtime_env)

    with tempfile.TemporaryDirectory(prefix="pirate-subs-proof-") as temp_dir:
        input_path = Path(temp_dir) / "proof-input.borsh"
        output_path = Path(temp_dir) / "fulfill-payload.b64"
        proof_input = base64.b64decode(proof_input_base64, validate=True)
        _fulfill_prefix_from_proving_request(proof_input)
        input_path.write_bytes(proof_input)

        command = _format_command(command_template, input_path, output_path)
        completed = subprocess.run(
            command,
            check=False,
            capture_output=True,
            text=True,
            timeout=int(runtime_env.get("SUBS_PROVER_TIMEOUT_SECONDS", "604800")),
        )
        if completed.returncode != 0:
            stderr = completed.stderr.strip()
            raise ProofWorkerError(f"prover command failed with exit code {completed.returncode}{': ' + stderr if stderr else ''}")

        receipt_base64 = _read_payload(completed.stdout, output_path)
        fulfill_payload_base64 = _frame_fulfill_payload(proof_input, receipt_base64)
        return {
            "batch_id": job_input.get("batch_id"),
            "parent_space": job_input.get("parent_space"),
            "proof_input_ref": job_input.get("proof_input_ref"),
            "fulfill_payload_base64": fulfill_payload_base64,
        }
