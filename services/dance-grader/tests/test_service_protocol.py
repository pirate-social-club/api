from __future__ import annotations

from dance_grader.service_protocol import (
    canonical_json,
    reference_failure_reason,
    sign_request,
    verify_request,
)


def test_dispatch_and_callback_signature_contract() -> None:
    body = canonical_json({"subject": "attempt_123", "value": 7})
    signature = sign_request(
        key=b"test-key",
        method="POST",
        url_or_path="https://grader.example/callback?ignored=yes",
        timestamp=1_000,
        subject="attempt_123",
        body=body,
    )

    assert verify_request(
        key=b"test-key",
        method="POST",
        path="/callback",
        timestamp=1_000,
        subject="attempt_123",
        body=body,
        signature=signature,
        now=1_100,
    )
    assert not verify_request(
        key=b"test-key",
        method="POST",
        path="/callback",
        timestamp=1_000,
        subject="attempt_123",
        body=body + b" ",
        signature=signature,
        now=1_100,
    )
    assert not verify_request(
        key=b"test-key",
        method="POST",
        path="/callback",
        timestamp=1_000,
        subject="attempt_123",
        body=body,
        signature=signature,
        now=1_301,
    )


def test_reference_failure_contract_only_terminalizes_known_media_failures() -> None:
    class ErrorWithCode(RuntimeError):
        def __init__(self, code):
            super().__init__("test")
            self.code = code

    assert reference_failure_reason(ErrorWithCode("multiple_people")) == "multiple_people"
    assert reference_failure_reason(ErrorWithCode("insufficient_coverage")) == (
        "insufficient_coverage"
    )
    assert reference_failure_reason(ErrorWithCode("unknown_future_code")) == "scoring_unavailable"
    assert reference_failure_reason(ErrorWithCode(503)) == "scoring_unavailable"
    assert reference_failure_reason(RuntimeError("network")) == "scoring_unavailable"
