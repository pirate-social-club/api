# Pirate API Audit Notes

Last reviewed: 2026-05-31.

This is the current lightweight audit map for `pirate-api`. The older May 2026 snapshot with line-numbered tasks has been retired because the route split, media extraction, hygiene checks, and Story/CDR path docs have landed.

## Current Operating Docs

- `README.md` - service inventory and default focused checks.
- `AGENTS.md` - agent-specific verification and API design rules.
- `ROUTE_COVERAGE.md` - live route-to-test inventory for `services/api`.
- `STORY_CDR_PATHS.md` - live Story/CDR entry points and coverage boundaries.
- `CONTRACTS_BOUNDARY.md` - generated-contract source-of-truth limitation across repo boundaries.
- `services/*/README.md` - service-local runtime and development notes.

## What Is In Good Shape

- Route coverage visibility is automated by `rtk bun run check:hygiene`; mounted route files must appear in `ROUTE_COVERAGE.md`.
- Community routing is split by capability instead of living in one large route file.
- Profile/community media upload mechanics use shared helpers.
- Story/CDR code is documented as active commerce infrastructure, with a route-to-service path map and deterministic test doubles.
- Generated contracts have a local freshness check when the sibling `specs/api` checkout is present.

## Remaining Risks

1. Generated contracts still depend on source inputs in the sibling `specs/api` repo. `pirate-api` CI can typecheck generated output, but it cannot prove freshness by itself unless the specs checkout is present.
2. The repo-level `rtk bun run check` and `rtk bun run test` are broad chains. Prefer service-local checks during normal work, then run the broad chain only when needed.
3. Story/CDR route tests use deterministic doubles. They prove service call graph wiring, not live chain, CDR, RunPod, or Bitcoin finality behavior.
4. Runtime maintenance scripts and production-only deploy paths still need operator smoke coverage rather than ordinary unit coverage.

## Audit Checklist For Future Passes

Start with cheap local checks:

```bash
rtk bun run check:hygiene
rtk bun run --cwd services/api check
rtk bun test services/api/tests/routes/path/to/touched.test.ts
```

When touching generated contracts:

```bash
rtk bun run --cwd services/contracts generate
rtk bun run --cwd services/contracts check:fresh
```

When touching Story/CDR paths:

- update `STORY_CDR_PATHS.md` if a new route or service entry point is added
- run the smallest song-artifact or commerce route suite that exercises the changed path
- state clearly whether verification used test doubles or live infrastructure

When touching mounted routes:

- update `ROUTE_COVERAGE.md`
- keep new route tests near the route group unless at least two groups need shared helpers
- rerun `rtk bun run check:hygiene`
