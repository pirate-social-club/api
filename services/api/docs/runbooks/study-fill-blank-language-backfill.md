# Study fill-blank language backfill

This runner repairs the lyrics-language metadata that the fill-blank generator
requires. It is deliberately scoped to a previously frozen staging report; it
does not discover communities or songs by a fresh broad query.

## Plan first

Generate a complete frozen report with `report:study-fill-blank`, then run:

```sh
ENVIRONMENT=staging \
CLOUDFLARE_ACCOUNT_ID="$CLOUDFLARE_ACCOUNT_ID" \
CLOUDFLARE_D1_API_TOKEN="$CLOUDFLARE_D1_API_TOKEN" \
bun run backfill:study-fill-blank-language -- \
  --confirmation 'AUDIT FILL BLANK LANGUAGE BACKFILL TO STAGING' \
  --report /secure/evidence/staging-report.json \
  --output /secure/evidence/staging-language-backfill-plan.json
```

The default is a dry run. The plan reads only the six (or fewer) report songs
with study lines, verifies each post is still a published song in the recorded
community and shard, computes the current lyrics source hash, and reports which
jobs would be queued. A source-hash change, missing post, binding mismatch, or
schema failure is an error; the runner never widens the scope.

## Execute only after review

After the plan is reviewed and staging is on a materializer-capable build, add
`--execute` and use a write-capable Cloudflare D1 token:

```sh
ENVIRONMENT=staging \
CLOUDFLARE_ACCOUNT_ID="$CLOUDFLARE_ACCOUNT_ID" \
CLOUDFLARE_D1_API_TOKEN="$CLOUDFLARE_D1_API_TOKEN" \
bun run backfill:study-fill-blank-language -- \
  --confirmation 'AUDIT FILL BLANK LANGUAGE BACKFILL TO STAGING' \
  --report /secure/evidence/staging-report.json \
  --output /secure/evidence/staging-language-backfill-execute.json \
  --execute
```

`--execute` writes only parameterized, single-statement `INSERT OR IGNORE`
operations into `community_jobs` for
`post_lyrics_language_detection_materialize`. No post, cloze, review-state, or
cleanup rows are written. The write token must be able to write the six
community databases; the read-only report token is not sufficient.

The output is mode `0600` JSON and carries the frozen report digest, selected
song IDs, source hashes, planned/inserted counts, and any errors. A complete
plan with zero eligible cards is valid evidence; do not weaken language gates
to manufacture cards. After the scheduler drains the jobs, generate a fresh
frozen report and review the resulting cards on both `/study` and Telegram.
