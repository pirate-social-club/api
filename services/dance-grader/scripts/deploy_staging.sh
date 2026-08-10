#!/usr/bin/env bash
set -euo pipefail

readonly modal_environment="staging"
readonly service_secret_name="dance-grader-service"

if [[ -z "${MODAL_TOKEN_ID:-}" || -z "${MODAL_TOKEN_SECRET:-}" ]]; then
  echo "MODAL_TOKEN_ID and MODAL_TOKEN_SECRET are required" >&2
  exit 1
fi

if [[ -z "${DANCE_GRADER_DEPLOY_TAG:-}" ]]; then
  echo "DANCE_GRADER_DEPLOY_TAG is required and must identify the source revision" >&2
  exit 1
fi
if [[ ! "${DANCE_GRADER_DEPLOY_TAG}" =~ ^[0-9a-f]{40}$ ]]; then
  echo "DANCE_GRADER_DEPLOY_TAG must be one full lowercase commit SHA" >&2
  exit 1
fi

secret_inventory="$(uv run modal secret list --env "${modal_environment}" --json)"
python scripts/validate_modal_secret_inventory.py \
  "${service_secret_name}" <<<"${secret_inventory}"

# This remote preflight reports only missing key names and non-secret key versions.
uv run modal run --env "${modal_environment}" modal_app.py::validate_service_configuration
uv run modal deploy \
  --env "${modal_environment}" \
  --strategy rolling \
  --tag "${DANCE_GRADER_DEPLOY_TAG}" \
  modal_app.py
uv run modal app history --env "${modal_environment}" pirate-dance-grader
