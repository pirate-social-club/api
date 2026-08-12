# HNS zone GC dry run

The control-plane inventory is the first half of the unclaimed-zone review. It
is read-only and must be generated before inspecting PowerDNS zones:

```sh
bun run scripts/admin-hns-zone-inventory.ts \
  --output /tmp/hns-zone-control-plane.json
```

Use the reviewed migrator database URL (`CONTROL_PLANE_MIGRATOR_DATABASE_URL`)
when running this as an operator command. The output is a versioned JSON
snapshot containing active attachments, non-terminal sessions, delegation
state, and all known challenge TXT values for every HNS root in the control
plane.

The command has no write mode. Do not treat an empty output as proof that DNS
zones are unclaimed: a database outage or incomplete migration must fail the
command instead of producing an empty inventory.

Pass the resulting file to the Core-side PowerDNS comparator. It will classify
zones as protected, unknown, or review candidates. A review candidate is not a
deletion authorization; it requires a separate operator decision and a future
reviewed apply command with an immutable snapshot hash.
