#!/usr/bin/env bash
set -euo pipefail

label="${1:-current}"
kinds="${PIRATE_TIMING_KINDS:-video-public,video-locked,song-locked}"
runs="${PIRATE_TIMING_RUNS:-5}"
warmup_runs="${PIRATE_TIMING_WARMUP_RUNS:-1}"
api_base_url="${PIRATE_TIMING_API_BASE_URL:-http://127.0.0.1:8787}"

if [[ "${label}" == "--help" || "${label}" == "-h" ]]; then
  cat <<'USAGE'
Usage:
  PIRATE_TIMING_COMMUNITY_ID=cmt_... rtk bash scripts/timing-runs.sh [label]

Runs the local real-file submission timing set against an already-running API.
It does not start, stop, or restart the API server.

Environment:
  PIRATE_TIMING_COMMUNITY_ID   Required community id.
  PIRATE_TIMING_API_BASE_URL   Defaults to http://127.0.0.1:8787.
  PIRATE_TIMING_KINDS          Defaults to video-public,video-locked,song-locked.
  PIRATE_TIMING_RUNS           Defaults to 5.
  PIRATE_TIMING_WARMUP_RUNS    Defaults to 1.

Example:
  PIRATE_TIMING_COMMUNITY_ID=cmt_... rtk bash scripts/timing-runs.sh sync
  PIRATE_TIMING_COMMUNITY_ID=cmt_... rtk bash scripts/timing-runs.sh async
USAGE
  exit 0
fi

if [[ -z "${PIRATE_TIMING_COMMUNITY_ID:-}" ]]; then
  echo "PIRATE_TIMING_COMMUNITY_ID is required" >&2
  exit 1
fi

if ! command -v rtk >/dev/null 2>&1; then
  echo "rtk is required for this workspace timing wrapper" >&2
  exit 1
fi

rtk env infisical run \
  --project-config-dir ../../../core \
  --env=dev \
  --path=/services/api \
  -- bun run timing:local-runs \
  --api-base-url "$api_base_url" \
  --community-id "$PIRATE_TIMING_COMMUNITY_ID" \
  --kinds "$kinds" \
  --runs "$runs" \
  --warmup-runs "$warmup_runs" \
  --label "$label"
