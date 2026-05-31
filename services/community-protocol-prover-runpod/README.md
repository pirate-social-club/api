# Community Protocol Prover RunPod Worker

Queue-based RunPod worker for Spaces `subs` proof jobs.

The issuer submits proof jobs for a protocol issuance batch until `subsd /proving/next` returns no pending request. A batch can require more than one proof job. This worker is intentionally narrow:

1. Validate `proof_input_base64`.
2. Write the decoded proving request to a temp file.
3. Execute the pinned upstream `subs-prover` through a local Borsh-compatible wrapper.
4. Frame the prover receipt for `subsd /proving/fulfill`.
5. Return `fulfill_payload_base64` for the issuer to store and fulfill into `subsd`.

The worker is not the source of truth. Pirate stores proof input/output artifacts and owns the issuance state machine.

## RunPod Contract

Input:

```json
{
  "input": {
    "batch_id": "pib_...",
    "parent_space": "@pesto",
    "proof_input_ref": "file-artifact://...",
    "proof_input_base64": "..."
  }
}
```

Output:

```json
{
  "batch_id": "pib_...",
  "parent_space": "@pesto",
  "proof_input_ref": "file-artifact://...",
  "fulfill_payload_base64": "..."
}
```

## Prover Command

The Docker image defaults this to:

```json
["python3","/app/subs_prover_http.py","--input","{input_path}","--output","{output_path}"]
```

That wrapper starts `subs-prover --server`, posts the binary Borsh `ProvingRequest` to `/prove`, polls `/jobs/:job_id`, downloads `/jobs/:job_id/receipt`, and writes the base64 receipt to `{output_path}`.

`subsd /spaces/:space/proving/next` returns `borsh::to_vec(&Option<ProvingRequest>)`. The issuer strips the outer Borsh `Some` tag before submitting to RunPod, because `subs-prover /prove` expects the inner `ProvingRequest` bytes.

`subsd /spaces/:space/proving/fulfill` expects a framed binary payload:

```text
8 bytes commitment_id little-endian
1 byte request_type: 0 = Step, 1 = Fold
remaining bytes: prover receipt
```

The worker derives the first 9 bytes from the inner Borsh `ProvingRequest` before returning `fulfill_payload_base64`. RunPod receives an inner request and returns a fulfill-ready payload.

To override, configure exactly one of:

```text
SUBS_PROVER_COMMAND_JSON
SUBS_PROVER_COMMAND
```

`SUBS_PROVER_COMMAND_JSON` is preferred because it avoids shell quoting ambiguity:

```json
["/usr/local/bin/subs-prover-wrapper", "--input", "{input_path}", "--output", "{output_path}"]
```

`{input_path}` is replaced with the decoded proving request path.
`{output_path}` is replaced with the file where the command should write the base64 fulfill payload.

The command may instead print JSON to stdout. Raw base64 stdout is intentionally rejected because prover logs on stdout would otherwise produce ambiguous failures:

```json
{"fulfill_payload_base64":"..."}
```

Optional:

```text
SUBS_PROVER_TIMEOUT_SECONDS default 604800
```

Coordinate `SUBS_PROVER_TIMEOUT_SECONDS` with the RunPod endpoint execution timeout and the issuer's `COMMUNITY_PROTOCOL_ISSUER_PROOF_JOB_MAX_AGE_SECONDS`. The shortest timer wins operationally.

The command environment variables are operator-controlled trusted configuration. They must never be derived from user input or community-admin settings.

## Local Test

```bash
rtk python3 -m unittest discover -s services/community-protocol-prover-runpod -p 'test_*.py'
```

## Image

The included Dockerfile packages the RunPod handler, command adapter, and upstream `subs-prover` pinned to:

```text
dd92608be286a97bcbb1537cb0ba74ae35183539
```

Upstream currently does not ship a `Cargo.lock`, so the `subs` git revision is pinned but transitive Rust dependency resolution is not fully vendored yet. Before production, build once, archive the generated lock/image digest, and deploy by immutable image digest rather than a mutable tag.

Build shape:

```bash
rtk docker build --platform linux/amd64 -t pirate/community-protocol-prover-runpod:local services/community-protocol-prover-runpod
```

The Dockerfile uses BuildKit cache mounts for Cargo registry/git/target data and defaults to `CARGO_BUILD_JOBS=2` to reduce peak memory on workstation builds. Override only on machines with enough RAM:

```bash
rtk docker build --platform linux/amd64 --build-arg CARGO_BUILD_JOBS=8 -t pirate/community-protocol-prover-runpod:local services/community-protocol-prover-runpod
```

Optional build args:

```text
SUBS_GIT_REF
SUBS_PROVER_FEATURES
CARGO_BUILD_JOBS
```

For GPU proving, build with the upstream feature expected by the target machine, for example:

```bash
rtk docker build --platform linux/amd64 --build-arg SUBS_PROVER_FEATURES=cuda -t pirate/community-protocol-prover-runpod:cuda services/community-protocol-prover-runpod
```

For the first real smoke, set `workersMax = 1`, a long execution timeout, and deploy this as a queue-based endpoint, not a load-balancing endpoint.

## RunPod Provisioning

The operator only has to provide a RunPod API key. The template and queue endpoint are created from repo defaults after the worker image is available in a registry.

Required manual secret:

```text
COMMUNITY_PROTOCOL_ISSUER_RUNPOD_API_KEY
```

Defaults used by the provisioner:

```text
RUNPOD_PROVER_IMAGE=t3333333k/community-protocol-prover-runpod@sha256:fc8f56292fd749f6c305ba7483510cc8747376acf3ab778e3a751f4dbfd4380e
RUNPOD_PROVER_GPU_TYPE=NVIDIA GeForce RTX 4090
RUNPOD_PROVER_WORKERS_MIN=0
RUNPOD_PROVER_WORKERS_MAX=1
RUNPOD_PROVER_EXECUTION_TIMEOUT_MS=604800000
RUNPOD_PROVER_IDLE_TIMEOUT=5
SUBS_PROVER_TIMEOUT_SECONDS=604800
```

Dry-run the payloads:

```bash
rtk python3 services/community-protocol-prover-runpod/scripts/provision_runpod.py --dry-run
```

Create or reuse the private template and queue endpoint, then write the generated IDs back to Infisical:

```bash
rtk python3 services/community-protocol-prover-runpod/scripts/provision_runpod.py --write-infisical --infisical-env staging
```

If the API key is stored only in Infisical, run the provisioner through the issuer secret path:

```bash
rtk infisical run --project-config-dir ../core --env staging --path /services/community-protocol-issuer -- rtk python3 services/community-protocol-prover-runpod/scripts/provision_runpod.py --write-infisical --infisical-env staging --infisical-project-id 5acea78e-7813-4d8a-b29c-9b862a0b1c71
```

The script writes:

```text
/services/community-protocol-issuer
  COMMUNITY_PROTOCOL_ISSUER_RUNPOD_ENDPOINT_ID

/services/community-protocol-prover-runpod
  RUNPOD_PROVER_TEMPLATE_ID
  RUNPOD_PROVER_ENDPOINT_ID
```

Last recorded staging resources:

```text
RunPod template: a0nqg0h3ge
RunPod endpoint: kifqe786lpj2ne
Worker image: t3333333k/community-protocol-prover-runpod:staging
Image digest: sha256:fc8f56292fd749f6c305ba7483510cc8747376acf3ab778e3a751f4dbfd4380e
```

Last recorded smoke result:

```text
POST /v2/kifqe786lpj2ne/run accepted a queue job.
The worker pulled and ran the image, then failed invalid test input with:
proof_input_base64 must be valid base64
```
