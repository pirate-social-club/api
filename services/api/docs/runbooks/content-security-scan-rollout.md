# Content security scan rollout

The generic-content upload and scan code is dormant by default. Merging it does
not create infrastructure, add Worker bindings, promote a scanner release, or
enable creator publication. A clean malware result advances a blob only to
`verifying`; format validation must still establish detected metadata before a
blob can become `ready`.

## Fail-closed controls

- `CONTENT_SECURITY_SCAN_ENQUEUE_ENABLED` defaults off. When enabled, upload
  completion requires the Queue binding, a configured scan profile, and one
  active scanner release before plaintext is stored.
- `CONTENT_SECURITY_SCAN_CONSUMER_ENABLED` defaults off. A disabled consumer
  acknowledges messages without reading plaintext.
- Queue messages contain only the schema version and `scan_job_id`. Filenames,
  object keys, hashes, sizes, MIME declarations, and content never enter Queue
  payloads or application logs.
- The control-plane job is authoritative. Consumers lease with compare-and-set,
  resolve the pinned release and expected byte identity from the ledger, and
  accept evidence only when every release and byte field matches.
- Revoked releases cannot be leased or finish a result. Scheduled repair
  cancels queued, retryable, and expired-running jobs pinned to a revoked
  release and fails their blob closed without manufacturing scanner evidence.
- The private source broker is the only component with plaintext R2 access. It
  verifies stored metadata before scanning and records a bounded read audit for
  every leased attempt.

## Prerequisites

Do not add production or staging bindings until all of these are reviewed:

1. Promote the container shutdown fix and prove a real scanner instance exits
   after its 30-second idle window. Capture platform tail evidence and confirm
   billing returns to zero allocated container time.
2. Deploy the pinned scanner image and private source broker. Neither Worker
   may expose a public route. Provision separate private R2 namespaces and the
   same internal authentication secret through the approved secret path.
3. Add reviewed scanner-release promotion tooling. Raw database writes are not
   a supported promotion or revocation path. The tooling must bind source
   revision, frozen runtime lock, image digests, engine and signature versions,
   SBOM, and clean/malicious corpus evidence before activation.
4. Provision the content-security Queue and dead-letter Queue. Add the API
   producer/consumer Queue binding and broker service binding in a separate
   reviewed deployment change.
5. Exercise the clean and malicious corpus through the deployed broker. Verify
   immutable scan-result and source-read rows, hash/size identity, retry and
   dead-letter behavior, release revocation, and scanner sleep-to-zero.
6. Review the cumulative cost envelope, including retained plaintext and
   published ciphertext storage. The physical quota is authoritative; locked
   goods generally consume roughly twice their logical size.

Scanner-release promotion tooling and real infrastructure are currently
missing. That blocks enablement even after this code ships.

## Staged enablement

1. Create and activate a scanner release for the staging profile.
2. Deploy staging bindings with both feature flags still false.
3. Enable `CONTENT_SECURITY_SCAN_CONSUMER_ENABLED` first and confirm an empty
   Queue remains healthy.
4. Enable `CONTENT_SECURITY_SCAN_ENQUEUE_ENABLED` for an internal test
   community only.
5. Upload one clean and one malicious corpus fixture. Confirm the clean blob is
   `verifying`, the malicious blob is `rejected`, and both have matching result
   and read-audit rows. Confirm no object key or declared filename appears in
   Queue payloads or logs.
6. Exercise an infrastructure failure through all durable attempts and confirm
   the job dead-letters while the blob becomes `failed` with scan state still
   `pending`.
7. Revoke a staged release with pending work and confirm repair cancels that
   work and prevents an in-flight result from committing.
8. Repeat the sleep-to-zero and cost checks under representative 50 MiB load.

Production enablement requires a separate reviewed decision after staging
evidence is attached. Disabling enqueue stops new scan jobs. Disabling the
consumer stops plaintext reads; queued ledger rows remain available for repair
after a reviewed recovery.
