#!/usr/bin/env python3
"""Provision the RunPod Queue Serverless endpoint for protocol proofs.

The only required secret is RUNPOD_API_KEY, or the same value under
COMMUNITY_PROTOCOL_ISSUER_RUNPOD_API_KEY. Everything else has conservative
defaults for the first staging smoke and can be overridden with environment
variables.
"""

from __future__ import annotations

import argparse
import json
import os
import subprocess
import sys
import urllib.error
import urllib.parse
import urllib.request
from dataclasses import dataclass
from typing import Any


RUNPOD_REST_BASE_URL = "https://rest.runpod.io/v1"
DEFAULT_TEMPLATE_NAME = "pirate-community-protocol-prover-staging"
DEFAULT_ENDPOINT_NAME = "pirate-community-protocol-prover-staging"
DEFAULT_IMAGE = "t3333333k/community-protocol-prover-runpod@sha256:fc8f56292fd749f6c305ba7483510cc8747376acf3ab778e3a751f4dbfd4380e"
DEFAULT_GPU_TYPE = "NVIDIA GeForce RTX 4090"
DEFAULT_EXECUTION_TIMEOUT_MS = 604_800_000
DEFAULT_SUBS_PROVER_TIMEOUT_SECONDS = 604_800


@dataclass(frozen=True)
class ProvisionConfig:
    api_key: str | None
    image: str
    template_name: str
    endpoint_name: str
    gpu_type: str
    workers_min: int
    workers_max: int
    idle_timeout: int
    execution_timeout_ms: int
    scaler_value: int
    container_disk_gb: int
    subs_prover_timeout_seconds: int
    dry_run: bool


def env_string(name: str, default: str | None = None) -> str | None:
    value = os.environ.get(name)
    if value is None or not value.strip():
        return default
    return value.strip()


def env_int(name: str, default: int) -> int:
    value = env_string(name)
    if value is None:
        return default
    try:
        parsed = int(value, 10)
    except ValueError as exc:
        raise SystemExit(f"{name} must be an integer") from exc
    if parsed < 0:
        raise SystemExit(f"{name} must be non-negative")
    return parsed


def read_config(dry_run: bool) -> ProvisionConfig:
    api_key = env_string("RUNPOD_API_KEY") or env_string("COMMUNITY_PROTOCOL_ISSUER_RUNPOD_API_KEY")
    if not dry_run and (not api_key or api_key == "x" or api_key == "auto-created-by-provisioner"):
        raise SystemExit("Set RUNPOD_API_KEY or COMMUNITY_PROTOCOL_ISSUER_RUNPOD_API_KEY to the real RunPod API key")

    workers_min = env_int("RUNPOD_PROVER_WORKERS_MIN", 0)
    workers_max = env_int("RUNPOD_PROVER_WORKERS_MAX", 1)
    if workers_max < 1:
        raise SystemExit("RUNPOD_PROVER_WORKERS_MAX must be at least 1")
    if workers_min > workers_max:
        raise SystemExit("RUNPOD_PROVER_WORKERS_MIN cannot exceed RUNPOD_PROVER_WORKERS_MAX")

    return ProvisionConfig(
        api_key=api_key,
        image=env_string("RUNPOD_PROVER_IMAGE", DEFAULT_IMAGE) or DEFAULT_IMAGE,
        template_name=env_string("RUNPOD_PROVER_TEMPLATE_NAME", DEFAULT_TEMPLATE_NAME) or DEFAULT_TEMPLATE_NAME,
        endpoint_name=env_string("RUNPOD_PROVER_ENDPOINT_NAME", DEFAULT_ENDPOINT_NAME) or DEFAULT_ENDPOINT_NAME,
        gpu_type=env_string("RUNPOD_PROVER_GPU_TYPE", DEFAULT_GPU_TYPE) or DEFAULT_GPU_TYPE,
        workers_min=workers_min,
        workers_max=workers_max,
        idle_timeout=env_int("RUNPOD_PROVER_IDLE_TIMEOUT", 5),
        execution_timeout_ms=env_int("RUNPOD_PROVER_EXECUTION_TIMEOUT_MS", DEFAULT_EXECUTION_TIMEOUT_MS),
        scaler_value=env_int("RUNPOD_PROVER_SCALER_VALUE", 4),
        container_disk_gb=env_int("RUNPOD_PROVER_CONTAINER_DISK_GB", 50),
        subs_prover_timeout_seconds=env_int("SUBS_PROVER_TIMEOUT_SECONDS", DEFAULT_SUBS_PROVER_TIMEOUT_SECONDS),
        dry_run=dry_run,
    )


class RunPodRestClient:
    def __init__(self, api_key: str) -> None:
        token = api_key if api_key.startswith("Bearer ") else f"Bearer {api_key}"
        self._headers = {
            "Authorization": token,
            "Content-Type": "application/json",
            "Accept": "application/json",
        }

    def request(self, method: str, path: str, body: dict[str, Any] | None = None) -> Any:
        data = None if body is None else json.dumps(body).encode("utf-8")
        request = urllib.request.Request(
            f"{RUNPOD_REST_BASE_URL}{path}",
            data=data,
            headers=self._headers,
            method=method,
        )
        try:
            with urllib.request.urlopen(request, timeout=60) as response:
                text = response.read().decode("utf-8")
        except urllib.error.HTTPError as exc:
            text = exc.read().decode("utf-8", errors="replace")
            raise RuntimeError(f"RunPod {method} {path} failed: {exc.code} {text}") from exc
        return json.loads(text) if text.strip() else None


def first_by_name(items: Any, name: str) -> dict[str, Any] | None:
    if not isinstance(items, list):
        raise RuntimeError("RunPod list response was not an array")
    for item in items:
        if isinstance(item, dict) and item.get("name") == name:
            return item
    return None


def create_template_body(config: ProvisionConfig) -> dict[str, Any]:
    return {
        "name": config.template_name,
        "imageName": config.image,
        "category": "NVIDIA",
        "containerDiskInGb": config.container_disk_gb,
        "dockerEntrypoint": [],
        "dockerStartCmd": [],
        "env": {
            "SUBS_PROVER_TIMEOUT_SECONDS": str(config.subs_prover_timeout_seconds),
        },
        "isPublic": False,
        "isServerless": True,
        "ports": [],
        "readme": "Pirate community protocol proof worker.",
        "volumeInGb": 0,
        "volumeMountPath": "/workspace",
    }


def update_template_body(config: ProvisionConfig) -> dict[str, Any]:
    body = create_template_body(config)
    body.pop("category", None)
    body.pop("isServerless", None)
    return body


def create_endpoint_body(config: ProvisionConfig, template_id: str) -> dict[str, Any]:
    return {
        "name": config.endpoint_name,
        "templateId": template_id,
        "computeType": "GPU",
        "gpuCount": 1,
        "gpuTypeIds": [config.gpu_type],
        "workersMin": config.workers_min,
        "workersMax": config.workers_max,
        "idleTimeout": config.idle_timeout,
        "executionTimeoutMs": config.execution_timeout_ms,
        "scalerType": "QUEUE_DELAY",
        "scalerValue": config.scaler_value,
    }


def update_endpoint_body(config: ProvisionConfig, template_id: str) -> dict[str, Any]:
    body = create_endpoint_body(config, template_id)
    body.pop("computeType", None)
    return body


def ensure_template(client: RunPodRestClient | None, config: ProvisionConfig) -> dict[str, Any]:
    body = create_template_body(config)
    if config.dry_run:
        return {"id": "dry-run-template", "created": True, "body": body}
    if client is None:
        raise RuntimeError("RunPod client is required outside dry-run mode")
    existing = first_by_name(client.request("GET", "/templates"), config.template_name)
    if existing:
        updated = client.request("POST", f"/templates/{urllib.parse.quote(str(existing['id']))}/update", update_template_body(config))
        return {"id": existing["id"], "created": False, "body": updated}
    created = client.request("POST", "/templates", body)
    if not isinstance(created, dict) or not created.get("id"):
        raise RuntimeError("RunPod template create response did not include id")
    return {"id": created["id"], "created": True, "body": created}


def ensure_endpoint(client: RunPodRestClient | None, config: ProvisionConfig, template_id: str) -> dict[str, Any]:
    body = create_endpoint_body(config, template_id)
    if config.dry_run:
        return {"id": "dry-run-endpoint", "created": True, "body": body}
    if client is None:
        raise RuntimeError("RunPod client is required outside dry-run mode")
    existing = first_by_name(client.request("GET", "/endpoints"), config.endpoint_name)
    if existing:
        updated = client.request("PATCH", f"/endpoints/{urllib.parse.quote(str(existing['id']))}", update_endpoint_body(config, template_id))
        return {"id": existing["id"], "created": False, "body": updated}
    created = client.request("POST", "/endpoints", body)
    if not isinstance(created, dict) or not created.get("id"):
        raise RuntimeError("RunPod endpoint create response did not include id")
    return {"id": created["id"], "created": True, "body": created}


def write_infisical(template_id: str, endpoint_id: str, env: str, project_id: str | None) -> None:
    infisical_bin = env_string("INFISICAL_BIN", "infisical") or "infisical"
    base = [infisical_bin, "secrets", "set"]
    issuer_cmd = base + [
        "COMMUNITY_PROTOCOL_ISSUER_RUNPOD_ENDPOINT_ID=" + endpoint_id,
        "--env",
        env,
        "--path",
        "/services/community-protocol-issuer",
    ]
    prover_cmd = base + [
        "RUNPOD_PROVER_TEMPLATE_ID=" + template_id,
        "RUNPOD_PROVER_ENDPOINT_ID=" + endpoint_id,
        "--env",
        env,
        "--path",
        "/services/community-protocol-prover-runpod",
    ]
    if project_id:
        issuer_cmd += ["--projectId", project_id]
        prover_cmd += ["--projectId", project_id]
    subprocess.run(issuer_cmd, check=True)
    subprocess.run(prover_cmd, check=True)


def parse_args() -> argparse.Namespace:
    parser = argparse.ArgumentParser(description="Provision Pirate's RunPod proof endpoint")
    parser.add_argument("--dry-run", action="store_true", help="Print the RunPod payloads without creating resources")
    parser.add_argument("--write-infisical", action="store_true", help="Write created template/endpoint ids to Infisical")
    parser.add_argument("--infisical-env", default="staging", help="Infisical environment for --write-infisical")
    parser.add_argument("--infisical-project-id", default=None, help="Optional Infisical project id")
    return parser.parse_args()


def main() -> int:
    args = parse_args()
    config = read_config(args.dry_run)
    client = RunPodRestClient(config.api_key) if config.api_key else None

    template = ensure_template(client, config)
    endpoint = ensure_endpoint(client, config, template["id"])

    result = {
        "template_id": template["id"],
        "template_created": template["created"],
        "endpoint_id": endpoint["id"],
        "endpoint_created": endpoint["created"],
        "endpoint_url": f"https://api.runpod.ai/v2/{endpoint['id']}",
        "image": config.image,
        "gpu_type": config.gpu_type,
        "workers_min": config.workers_min,
        "workers_max": config.workers_max,
        "execution_timeout_ms": config.execution_timeout_ms,
    }
    print(json.dumps(result, indent=2, sort_keys=True))

    if args.write_infisical:
        if args.dry_run:
            raise SystemExit("--write-infisical cannot be used with --dry-run")
        write_infisical(template["id"], endpoint["id"], args.infisical_env, args.infisical_project_id)
    return 0


if __name__ == "__main__":
    sys.exit(main())
