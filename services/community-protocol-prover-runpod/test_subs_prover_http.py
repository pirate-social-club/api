import base64
import subprocess
import tempfile
import unittest
from pathlib import Path
from unittest.mock import patch

import subs_prover_http


class DummyProcess:
    def terminate(self):
        return None

    def wait(self, timeout=None):
        return 0

    def kill(self):
        return None


class SubProverHttpTests(unittest.TestCase):
    def test_posts_borsh_input_and_writes_base64_receipt(self):
        posted_bodies = []

        def fake_request(method, url, body=None):
            if url.endswith("/health"):
                return 200, b"ok"
            if url.endswith("/jobs/job-test/receipt"):
                return 200, b"receipt-bytes"
            raise AssertionError(f"unexpected request: {method} {url}")

        def fake_json_response(method, url, body=None):
            if url.endswith("/prove"):
                posted_bodies.append(body)
                return {"job_id": "job-test", "status": "Pending"}
            if url.endswith("/jobs/job-test"):
                return {"job_id": "job-test", "status": "Complete"}
            raise AssertionError(f"unexpected json request: {method} {url}")

        with tempfile.TemporaryDirectory() as temp_dir:
            input_path = Path(temp_dir) / "request.borsh"
            output_path = Path(temp_dir) / "receipt.b64"
            input_path.write_bytes(b"borsh-request")
            with patch.object(subprocess, "Popen", return_value=DummyProcess()) as popen, \
                 patch.object(subs_prover_http, "_request", side_effect=fake_request), \
                 patch.object(subs_prover_http, "_json_response", side_effect=fake_json_response):
                subs_prover_http.prove_with_server(input_path, output_path, port=8888, timeout_seconds=10, poll_seconds=0.01)

            popen.assert_called_once()
            self.assertEqual(posted_bodies, [b"borsh-request"])
            self.assertEqual(output_path.read_text(encoding="utf8"), base64.b64encode(b"receipt-bytes").decode("ascii"))


if __name__ == "__main__":
    unittest.main()
