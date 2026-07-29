from __future__ import annotations

from dance_grader.service_protocol import canonical_json, sign_request, verify_request


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
