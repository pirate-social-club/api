# Community D1 multi-pool rollout

The API may route reads, reconcile provisioning, and observe capacity across
multiple shard Workers. Exactly one shard Worker is the active allocator,
selected by `COMMUNITY_D1_ALLOCATION_SHARD_WORKER_ID`.

Do not change the active allocator in the same deployment that introduces a new
route. A rolling API deployment temporarily runs both configurations. Because
the pool databases cannot enforce a unique `community_id` across shard Workers,
concurrent old/new requests could otherwise claim one binding in each pool.

## Add a pool

1. Deploy the new shard Worker and its pool without allocating into it.
2. Add its service binding and `COMMUNITY_D1_SHARD_ROUTES` entry while keeping
   `COMMUNITY_D1_ALLOCATION_SHARD_WORKER_ID` on the existing pool.
3. Verify `/health/provisioning` reports every shard version and every pool, and
   that reconciliation completes for each pool.
4. Wait for the API rollout to converge and for community provisioning jobs to
   have no queued or running rows.
5. In a separate deployment, change
   `COMMUNITY_D1_ALLOCATION_SHARD_WORKER_ID` to the new pool.
6. Supervise that deployment and verify a canary community is allocated only in
   the selected pool. The API probes all configured pools before allocation and
   resumes an existing allocation wherever it finds one; duplicate allocations
   fail closed.

## Remove a pool

Do not remove a route while any live routing row names its `shard_worker_id`.
Removing the route makes those communities intentionally unreadable rather than
silently falling back to another shard Worker.

