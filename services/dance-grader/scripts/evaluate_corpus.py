#!/usr/bin/env python3
from __future__ import annotations

import argparse
import json
from pathlib import Path

from dance_grader import MirrorPolicy, PoseSequence, grade_dance


def load_pose(path: Path) -> PoseSequence:
    with path.open() as source:
        return PoseSequence.from_dict(json.load(source))


def parse_attempt(value: str) -> tuple[str, Path]:
    if "=" not in value:
        raise argparse.ArgumentTypeError("attempt must be NAME=/path/to/pose.json")
    name, raw_path = value.split("=", 1)
    return name, Path(raw_path)


def main() -> None:
    parser = argparse.ArgumentParser()
    parser.add_argument("--reference", type=Path, required=True)
    parser.add_argument("--attempt", action="append", type=parse_attempt, required=True)
    parser.add_argument("--mirror-policy", choices=("strict", "allowed"), default="strict")
    parser.add_argument(
        "--allow-reference-replay",
        action="store_true",
        help="calibration-only: score exact reference reuse instead of applying the integrity gate",
    )
    parser.add_argument(
        "--include-fingerprint-material",
        action="store_true",
        help="include ephemeral canonical material; omitted by default to keep it out of logs",
    )
    args = parser.parse_args()

    reference = load_pose(args.reference)
    rows = []
    for name, path in args.attempt:
        result = grade_dance(
            reference,
            load_pose(path),
            mirror_policy=MirrorPolicy(args.mirror_policy),
            enforce_reference_replay=not args.allow_reference_replay,
        )
        result_payload = result.to_dict()
        if not args.include_fingerprint_material:
            result_payload.pop("canonical_fingerprint_material_hex")
        rows.append({"name": name, "path": str(path), **result_payload})
    print(json.dumps(rows, indent=2, sort_keys=True))


if __name__ == "__main__":
    main()
