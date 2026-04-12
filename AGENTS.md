# Pirate API — Repo Workflow

Follow the root [AGENTS.md](../AGENTS.md) for workspace ownership, repo boundaries, GitButler rules, and machine-safety constraints.
Use this file for `pirate-api`-specific validation and CI workflow.

## Daily Flow

1. create the task branch with `but branch new <task-slug>`
2. make the smallest relevant backend change set
3. run the lightest local check that matches the change
4. if `.github/workflows/api-ci.yml` exists on the current branch, run it locally with `agent-ci`
5. commit with `but commit -m "<message>"`
6. push for review and remote validation

## Local Checks

Prefer targeted checks before full workflow runs:

- contracts: `cd services/contracts && rtk bun run check`
- api typecheck: `cd services/api && rtk bun run check`
- api tests: `cd services/api && rtk bun run test`
- cli typecheck: `cd services/cli && rtk bun run check`
- cli tests: `cd services/cli && rtk bun run test`

Use the Bruno path only when the change affects request/response behavior, local env bootstrapping, or route integration:

- `cd services/api && rtk bun run bruno:prepare:local-sqlite`
- `cd services/api && rtk bun run dev:local-sqlite`
- `cd services/api && rtk bun run bruno:test:local-sqlite`

## Local CI

When the repo contains a real workflow at `.github/workflows/api-ci.yml`, use that file as the source of truth.

Run CI locally with:

- `npx @redwoodjs/agent-ci run --quiet --workflow .github/workflows/api-ci.yml`

If you want one local pass without matrix expansion:

- `npx @redwoodjs/agent-ci run --quiet --all --no-matrix`

If a runner fails, fix it locally and retry only that runner:

- `npx @redwoodjs/agent-ci retry --name api`
- `npx @redwoodjs/agent-ci retry --name cli`
- `npx @redwoodjs/agent-ci retry --name bruno`

Do not push just to trigger remote CI when `agent-ci` can run the same workflow locally.

## Remote CI

Remote validation for `pirate-api` runs through GitHub Actions on Blacksmith.
The workflow file is the same source of truth for both:

- local `agent-ci` runs
- remote PR and branch runs on Blacksmith

## Notes

- current CI failures should be treated as real regressions in repo code, not as pre-existing CI noise
- keep `docs/ci/pirate-api-ci.yml` as reference material only; `.github/workflows/api-ci.yml` is the executable workflow
