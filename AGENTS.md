# Pirate API — Agent Notes

## Repository Boundary

`/home/t42/Documents/pirate-workspace` is a workspace directory, not this Git repo. This repo root is `/home/t42/Documents/pirate-workspace/api`.

Run API git commands from this directory. The sibling `web/` and `core/` directories are separate Git repositories and must be committed independently.

## Default Checks

Run the repo-level cheap gate before committing API service changes:

```bash
rtk bun run check
```

For focused route work, run the smallest touched route suite after typecheck. For CLI changes, run `rtk bun run check:cli` after `services/cli` dependencies are installed. Use full `agent-ci` only after the focused checks are green.

## Route Tests

- Keep route groups to at most three primary test files: `routes.test.ts`, `auth.test.ts`, and `lifecycle.test.ts`.
- Add `lifecycle.test.ts` only for non-trivial state transitions.
- Keep group-local helpers in `test-helpers.ts` only after two files in that group need them.
- Do not create new global test helpers for one route group.
- Keep `ROUTE_COVERAGE.md` aligned with mounted routes. `rtk bun run check:hygiene` fails when a mounted route file is missing from the map.

## Code Quality

- Do not duplicate auth, signing, config, path, or validation helpers.
- Extract on the second real caller.
- Avoid compatibility shims unless they have an owner, a removal condition, and a dated TODO.
- Generated contracts are generated output; do not hand-edit them.
- Generated/vendor files are exempt from size cleanup. Split large service/domain files on next meaningful touch when they make review harder.
