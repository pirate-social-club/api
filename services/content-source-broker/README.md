# Content source broker

Private service-binding boundary for retained generic-content plaintext.

- `PUT /objects/:content_blob_id` writes one checksum-bound object.
- `HEAD /objects/:content_blob_id` verifies exact hash and size.
- `POST /objects/:content_blob_id/scan` streams that object to the malware scanner.
- `DELETE /objects/:content_blob_id` deletes only after matching hash and size.

The Worker has no public route, listing endpoint, database credential, wallet,
or CDR key. Queue consumers pass an opaque scan job ID plus the authoritative
hash and size; they never pass object bytes or an arbitrary object key.

The API service binding is intentionally added only after the target broker
environment has its private bucket, secrets, scanner binding, and deployment
proof. Until then, generic content uploads remain feature-gated and fail closed
if an operator enables them without the binding.

Production provisioning uses two independent secrets: set
`CONTENT_SOURCE_BROKER_SHARED_SECRET` on this Worker and the API Worker, and
set `CONTENT_MALWARE_SCANNER_SHARED_SECRET` on this Worker and the scanner
Worker. Provision them through the hosted scanner promotion workflow; do not
place either value in `vars` or a workstation checkout.
