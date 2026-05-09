#!/usr/bin/env python3
"""Create a minimal local community DB for community-protocol-issuer smoke tests."""

from __future__ import annotations

import sqlite3
import sys
import argparse
from datetime import datetime, timezone
from pathlib import Path


ROOT = Path(__file__).resolve().parents[3]
MIGRATIONS = ROOT / "services" / "api" / "test-fixtures" / "db" / "community-template" / "migrations"


def now_iso() -> str:
    return datetime.now(timezone.utc).isoformat().replace("+00:00", "Z")


def parse_args() -> argparse.Namespace:
    parser = argparse.ArgumentParser(description="Seed a local protocol issuer smoke database")
    parser.add_argument("db_path", nargs="?", default="/tmp/community-protocol-issuer-smoke.db")
    parser.add_argument("--space", default="@test10000")
    parser.add_argument("--label", default="issuer0")
    parser.add_argument("--append", action="store_true", help="Append an issuance instead of recreating the DB")
    return parser.parse_args()


def main() -> None:
    args = parse_args()
    db_path = Path(args.db_path)
    if db_path.exists() and not args.append:
        db_path.unlink()

    conn = sqlite3.connect(db_path)
    try:
        conn.execute("PRAGMA foreign_keys = ON")
        if not args.append:
            for migration in (
                "1001_community_core.sql",
                "1066_community_handle_claims.sql",
                "1072_community_handle_protocol_issuance.sql",
                "1074_protocol_issuance_proof_job_count.sql",
            ):
                conn.executescript((MIGRATIONS / migration).read_text(encoding="utf8"))

        ts = now_iso()
        normalized_space = args.space.removeprefix("@")
        community_id = f"cmt_protocol_smoke_{normalized_space}"
        namespace_id = f"ns_protocol_smoke_{normalized_space}"
        label = args.label
        handle_id = f"ch_protocol_smoke_{normalized_space}_{label}"
        issuance_id = f"cpi_protocol_smoke_{normalized_space}_{label}"
        sname = f"{label}{args.space}"
        script_pubkey_hex = "5120" + ("11" * 32)

        conn.execute(
            """
            INSERT OR IGNORE INTO communities (
              community_id, display_name, description, status, artist_identity_id,
              artist_governance_state, membership_mode, default_age_gate_policy,
              allow_anonymous_identity, anonymous_identity_scope, donation_partner_id,
              donation_policy_mode, donation_partner_status, governance_mode,
              settings_json, created_by_user_id, created_at, updated_at
            ) VALUES (
              ?, 'Protocol Smoke', NULL, 'active', NULL,
              'fan_run', 'request', 'none',
              0, NULL, NULL,
              'none', 'unconfigured', 'centralized',
              NULL, 'usr_smoke_admin', ?, ?
            )
            """,
            (community_id, ts, ts),
        )
        conn.execute(
            """
            INSERT OR IGNORE INTO namespace_bindings (
              namespace_id, community_id, namespace_verification_id, display_label,
              normalized_label, resolver_label, route_family, status, created_at, updated_at
            ) VALUES (?, ?, 'nv_protocol_smoke', ?, ?, ?, 'spaces', 'active', ?, ?)
            """,
            (namespace_id, community_id, args.space, normalized_space, args.space, ts, ts),
        )
        conn.execute(
            """
            INSERT INTO community_handles (
              community_handle_id, community_id, user_id, namespace_id,
              label_normalized, label_display, status, issuance_source,
              lease_started_at, lease_expires_at, created_at, updated_at,
              price_cents, currency, pricing_model, pricing_tier,
              settlement_wallet_attachment_id, funding_tx_ref, settlement_tx_ref
            ) VALUES (
              ?, ?, ?, ?,
              ?, ?, 'active', 'claim',
              ?, NULL, ?, ?,
              500, 'USD', 'flat_by_length', 'standard',
              'wa_evm_protocol_smoke', '0xprotocolsmoke', NULL
            )
            """,
            (handle_id, community_id, f"usr_protocol_smoke_{label}", namespace_id, label, label, ts, ts, ts),
        )
        conn.execute(
            """
            INSERT INTO community_handle_protocol_issuances (
              community_handle_protocol_issuance_id, community_handle_id,
              protocol_issuance_batch_id, community_id, namespace_id,
              public_status, parent_space, sname, script_pubkey_hex,
              cert_ref, certificate_payload_ref, error_code, error_message,
              created_at, updated_at, issued_at
            ) VALUES (
              ?, ?, NULL, ?, ?,
              'issuing', ?, ?, ?,
              NULL, NULL, NULL, NULL,
              ?, ?, NULL
            )
            """,
            (issuance_id, handle_id, community_id, namespace_id, args.space, sname, script_pubkey_hex, ts, ts),
        )
        conn.commit()
        print(f"created {db_path}")
        print(f"seeded issuance {issuance_id} for {sname}")
    finally:
        conn.close()


if __name__ == "__main__":
    main()
