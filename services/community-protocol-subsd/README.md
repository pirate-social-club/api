# community-protocol-subsd

Persistent `subsd` service for Pirate community handle protocol issuance.

This service is intentionally small:

- It packages upstream `spacesprotocol/subs` pinned to `dd92608be286a97bcbb1537cb0ba74ae35183539`.
- It runs the `subs` HTTP server with a persistent data directory.
- It connects to an existing `spaced` RPC and operator wallet.
- It is only intended to be reachable by Pirate issuer/operator infrastructure, not by the public internet.

`subsd` owns the protocol-local state: operated parent Spaces, staged subnames, local Merkle commits, proving requests, Bitcoin broadcast state, and cert publishing state. Pirate still owns the product state in the community DB.

## Required Runtime

```text
SUBSD_RPC_URL=http://127.0.0.1:7225
SUBSD_WALLET=<spaced wallet name that can operate the parent Space>
SUBSD_DATA_DIR=/var/lib/pirate/subsd/data
SUBSD_PORT=7777
```

Optional:

```text
SUBSD_RPC_USER=<basic auth user>
SUBSD_RPC_PASSWORD=<basic auth password>
SUBSD_RPC_COOKIE=/path/to/rpc.cookie
RUST_LOG=subsd=info,tower_http=info
```

Use either `SUBSD_RPC_USER`/`SUBSD_RPC_PASSWORD` or `SUBSD_RPC_COOKIE`, not both.

## Build

```bash
rtk docker build --platform linux/amd64 -t pirate/community-protocol-subsd:staging services/community-protocol-subsd
```

The image defaults to `CARGO_BUILD_JOBS=2` to keep workstation memory use bounded. On a larger builder:

```bash
rtk docker build --platform linux/amd64 --build-arg CARGO_BUILD_JOBS=8 -t pirate/community-protocol-subsd:staging services/community-protocol-subsd
```

Current staging image:

```text
t3333333k/community-protocol-subsd@sha256:be9ac7cff697a576d7926707531e9b0c580c5368dfe7b06e59dd12c80cbf5618
```

## Run

Single host example:

```bash
rtk docker run --detach --name pirate-subsd --restart unless-stopped --network host --volume pirate-subsd-data:/var/lib/pirate/subsd --env SUBSD_RPC_URL=http://127.0.0.1:7225 --env SUBSD_WALLET=default t3333333k/community-protocol-subsd@sha256:be9ac7cff697a576d7926707531e9b0c580c5368dfe7b06e59dd12c80cbf5618
```

For staging/prod, bind `subsd` only on private networking or localhost behind an SSH tunnel. The upstream service has no product auth layer.

## One-Time Space Operation

After first boot, load the parent Space into `subsd`:

```bash
rtk curl -fsS -X POST http://127.0.0.1:7777/spaces/%40pesto/operate
```

Then verify:

```bash
rtk curl -fsS http://127.0.0.1:7777/spaces/%40pesto
```

The issuer can now use:

```text
COMMUNITY_PROTOCOL_ISSUER_SUBSD_BASE_URL=http://127.0.0.1:7777
```

or the equivalent private service URL.

## Smoke

Minimum staging smoke:

```bash
rtk curl -fsS http://127.0.0.1:7777/status
rtk curl -fsS -X POST http://127.0.0.1:7777/spaces/%40pesto/operate
rtk curl -fsS http://127.0.0.1:7777/spaces/%40pesto
```

Then run `services/community-protocol-issuer` against the same base URL.

## Local Test Rig

The production image is built without upstream `test-rig`. To build a local image that can start regtest `bitcoind` + `spaced` automatically:

```bash
rtk docker build --platform linux/amd64 --build-arg SUBS_FEATURES=test-rig -t pirate/community-protocol-subsd:test-rig services/community-protocol-subsd
```

Run:

```bash
rtk docker run --rm --name pirate-subsd-test-rig --publish 7777:7777 --volume pirate-subsd-test-rig:/var/lib/pirate/subsd --env SUBSD_TEST_RIG=1 pirate/community-protocol-subsd:test-rig
```

## Product Path

The simple robust product path is:

```text
paid claim creates app handle + protocol issuance row
issuer stages in persistent subsd
subsd keeps local protocol state across restarts
RunPod proves only when subsd requires proof
issuer fulfills proof, broadcasts, waits finality, publishes certs
app exposes issuing | issued | failed
```

This keeps user purchase flow fast and makes protocol issuance retryable without an always-on GPU.
