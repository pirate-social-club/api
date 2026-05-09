#!/usr/bin/env sh
set -eu

port="${SUBSD_PORT:-7777}"
data_dir="${SUBSD_DATA_DIR:-/var/lib/pirate/subsd/data}"

mkdir -p "$data_dir"

if [ "${SUBSD_TEST_RIG:-0}" = "1" ]; then
  test_rig_dir="${SUBSD_TEST_RIG_DIR:-/var/lib/pirate/subsd/testrig-data}"
  mkdir -p "$test_rig_dir"
  exec subs \
    --test-rig \
    --test-rig-dir "$test_rig_dir" \
    --data-dir "$data_dir" \
    --port "$port"
fi

if [ -z "${SUBSD_RPC_URL:-}" ]; then
  echo "SUBSD_RPC_URL is required unless SUBSD_TEST_RIG=1" >&2
  exit 64
fi

if [ -z "${SUBSD_WALLET:-}" ]; then
  echo "SUBSD_WALLET is required unless SUBSD_TEST_RIG=1" >&2
  exit 64
fi

set -- subs \
  --rpc-url "$SUBSD_RPC_URL" \
  --wallet "$SUBSD_WALLET" \
  --data-dir "$data_dir" \
  --port "$port"

if [ -n "${SUBSD_RPC_USER:-}" ]; then
  set -- "$@" --rpc-user "$SUBSD_RPC_USER"
fi

if [ -n "${SUBSD_RPC_PASSWORD:-}" ]; then
  set -- "$@" --rpc-password "$SUBSD_RPC_PASSWORD"
fi

if [ -n "${SUBSD_RPC_COOKIE:-}" ]; then
  set -- "$@" --rpc-cookie "$SUBSD_RPC_COOKIE"
fi

exec "$@"
