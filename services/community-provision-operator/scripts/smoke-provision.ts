#!/usr/bin/env bun
/**
 * Post-deploy provisioning smoke check.
 *
 * Hits the API's public `/health/provisioning` endpoint, which fans out to the
 * community-provision-operator's authenticated `/health/deep` probe. That probe
 * validates CONTROL_PLANE_DATABASE_URL and runs `SELECT 1` against the control
 * plane.
 *
 * This is the gate that would have caught the prod `file:` control-plane URL:
 * the plain `/health` endpoint only echoes config, but `/health/deep` actually
 * opens the database. Wire it into the deploy pipeline as a post-deploy step.
 *
 * Usage:
 *   bun run scripts/smoke-provision.ts https://api.pirate.sc
 *   BASE_URL=https://api.pirate.sc bun run scripts/smoke-provision.ts
 *
 * Exit codes: 0 = healthy, 1 = unhealthy/unreachable, 2 = bad invocation.
 */

const baseUrl = (process.argv[2] ?? process.env.BASE_URL ?? "").trim().replace(/\/+$/, "");
if (!baseUrl) {
  console.error("smoke-provision: missing base URL (pass as arg 1 or set BASE_URL)");
  process.exit(2);
}

const target = `${baseUrl}/health/provisioning`;

try {
  const response = await fetch(target, { headers: { accept: "application/json" } });
  const body = (await response.json().catch(() => null)) as Record<string, unknown> | null;
  console.log(`smoke-provision: GET ${target} -> ${response.status} ${JSON.stringify(body)}`);

  const healthy = response.ok && body?.ok === true && body?.control_plane_ok === true;
  if (!healthy) {
    console.error("smoke-provision: FAILED — provisioning backend is unhealthy");
    process.exit(1);
  }
  console.log("smoke-provision: OK — control plane reachable");
} catch (error) {
  console.error(`smoke-provision: request error: ${error instanceof Error ? error.message : String(error)}`);
  process.exit(1);
}
