from __future__ import annotations

import json
import sys


def contains_expected_name(value: object, expected: str) -> bool:
    if isinstance(value, str):
        return value == expected
    if isinstance(value, list):
        return any(contains_expected_name(item, expected) for item in value)
    if isinstance(value, dict):
        return any(contains_expected_name(item, expected) for item in value.values())
    return False


def main() -> None:
    if len(sys.argv) != 2:
        raise SystemExit("usage: validate_modal_secret_inventory.py SECRET_NAME")
    expected = sys.argv[1]
    inventory = json.load(sys.stdin)
    if not contains_expected_name(inventory, expected):
        raise SystemExit(
            f"required Modal secret {expected!r} is absent from the staging environment"
        )


if __name__ == "__main__":
    main()
