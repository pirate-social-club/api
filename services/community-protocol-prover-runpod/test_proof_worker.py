import base64
import json
import stat
import tempfile
import textwrap
import unittest
from pathlib import Path

from proof_worker import ProofWorkerError, handle_proof_job


def b64(value: bytes) -> str:
    return base64.b64encode(value).decode("ascii")


def proving_request(tag: int = 0, commitment_id: int = 42, rest: bytes = b"request") -> bytes:
    return bytes([tag]) + commitment_id.to_bytes(8, "little", signed=True) + rest


class ProofWorkerTests(unittest.TestCase):
    def test_runs_command_template_and_reads_output_file(self):
        with tempfile.TemporaryDirectory() as temp_dir:
            command = Path(temp_dir) / "fake-prover.py"
            command.write_text(textwrap.dedent("""
                #!/usr/bin/env python3
                import base64
                import pathlib
                import sys

                input_path = pathlib.Path(sys.argv[sys.argv.index("--input") + 1])
                output_path = pathlib.Path(sys.argv[sys.argv.index("--output") + 1])
                payload = input_path.read_bytes()
                output_path.write_text(base64.b64encode(payload[::-1]).decode("ascii"))
            """).strip() + "\n", encoding="utf8")
            command.chmod(command.stat().st_mode | stat.S_IXUSR)

            result = handle_proof_job(
                {
                    "input": {
                        "batch_id": "pib_test",
                        "parent_space": "@pesto",
                        "proof_input_ref": "file-artifact://proof-input",
                        "proof_input_base64": b64(proving_request(commitment_id=7, rest=b"abc")),
                    },
                },
                {
                    "SUBS_PROVER_COMMAND_JSON": f'["{command}", "--input", "{{input_path}}", "--output", "{{output_path}}"]',
                    "SUBS_PROVER_TIMEOUT_SECONDS": "10",
                },
            )

            self.assertEqual(result["batch_id"], "pib_test")
            self.assertEqual(result["parent_space"], "@pesto")
            self.assertEqual(result["proof_input_ref"], "file-artifact://proof-input")
            expected_prefix = (7).to_bytes(8, "little", signed=True) + bytes([0])
            expected_receipt = proving_request(commitment_id=7, rest=b"abc")[::-1]
            self.assertEqual(result["fulfill_payload_base64"], b64(expected_prefix + expected_receipt))

    def test_accepts_json_stdout_payload(self):
        with tempfile.TemporaryDirectory() as temp_dir:
            command = Path(temp_dir) / "fake-prover.py"
            payload = json.dumps({"fulfill_payload_base64": b64(b"receipt")})
            command.write_text(textwrap.dedent(f"""
                #!/usr/bin/env python3
                print({payload!r})
            """).strip() + "\n", encoding="utf8")
            command.chmod(command.stat().st_mode | stat.S_IXUSR)

            result = handle_proof_job(
                {"input": {"proof_input_base64": b64(proving_request(tag=1, commitment_id=9))}},
                {
                    "SUBS_PROVER_COMMAND": str(command),
                    "SUBS_PROVER_TIMEOUT_SECONDS": "10",
                },
            )

            expected_prefix = (9).to_bytes(8, "little", signed=True) + bytes([1])
            self.assertEqual(result["fulfill_payload_base64"], b64(expected_prefix + b"receipt"))

    def test_rejects_missing_or_invalid_input(self):
        with self.assertRaisesRegex(ProofWorkerError, "proof_input_base64 is required"):
            handle_proof_job({"input": {}}, {"SUBS_PROVER_COMMAND": "unused"})

        with self.assertRaisesRegex(ProofWorkerError, "proof_input_base64 must be valid base64"):
            handle_proof_job({"input": {"proof_input_base64": "not-base64"}}, {"SUBS_PROVER_COMMAND": "unused"})

        with self.assertRaisesRegex(ProofWorkerError, "too short to contain a ProvingRequest"):
            handle_proof_job({"input": {"proof_input_base64": b64(b"short")}}, {"SUBS_PROVER_COMMAND": "unused"})

        with self.assertRaisesRegex(ProofWorkerError, "unsupported ProvingRequest variant tag"):
            handle_proof_job({"input": {"proof_input_base64": b64(proving_request(tag=2))}}, {"SUBS_PROVER_COMMAND": "unused"})

    def test_requires_command(self):
        with self.assertRaisesRegex(ProofWorkerError, "SUBS_PROVER_COMMAND_JSON or SUBS_PROVER_COMMAND is required"):
            handle_proof_job({"input": {"proof_input_base64": b64(proving_request())}}, {})

    def test_rejects_raw_stdout_payload_without_output_file(self):
        with tempfile.TemporaryDirectory() as temp_dir:
            command = Path(temp_dir) / "fake-prover.py"
            command.write_text(textwrap.dedent(f"""
                #!/usr/bin/env python3
                print("{b64(b'receipt')}")
            """).strip() + "\n", encoding="utf8")
            command.chmod(command.stat().st_mode | stat.S_IXUSR)

            with self.assertRaisesRegex(ProofWorkerError, "prover stdout must be JSON"):
                handle_proof_job(
                    {"input": {"proof_input_base64": b64(proving_request())}},
                    {
                        "SUBS_PROVER_COMMAND": str(command),
                        "SUBS_PROVER_TIMEOUT_SECONDS": "10",
                    },
                )


if __name__ == "__main__":
    unittest.main()
