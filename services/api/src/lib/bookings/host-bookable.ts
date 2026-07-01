import type { Env } from "../../env"

export interface HostBookableConfig {
  profile: { isPublished?: boolean }
  availabilityRules: unknown[]
}

// Test seam (api convention: setXForTests). Injecting the loader avoids a global mock.module of
// runtime-deps, which would leak `getControlPlaneClient` into unrelated control-plane tests.
let loaderForTests: ((env: Env, hostUserId: string) => Promise<HostBookableConfig | null>) | null = null
export function setHostBookableConfigLoaderForTests(
  loader: ((env: Env, hostUserId: string) => Promise<HostBookableConfig | null>) | null,
): void {
  loaderForTests = loader
}

async function loadConfig(env: Env, hostUserId: string): Promise<HostBookableConfig | null> {
  if (loaderForTests) return loaderForTests(env, hostUserId)
  // Lazy imports so the real control-plane/runtime-deps chain (and its heavy transitive deps) is
  // only loaded on the production path — tests set the seam and never touch it.
  const { getControlPlaneClient } = await import("../runtime-deps")
  const { createBookingHostConfigRepository } = await import("./host-config-repository")
  const executor = getControlPlaneClient(env)
  return createBookingHostConfigRepository(executor).getHostConfiguration(hostUserId)
}

/**
 * Read-on-serve derivation of the public "is this host bookable?" flag used by the profile
 * Book tab. True iff the host's global booking profile is published AND has at least one
 * availability rule (configured enough to take a booking — slots don't need to currently exist).
 * Fail-safe to `false` on any read error / absent bookings schema, so a profile view never fails.
 */
export async function resolveHostBookable(env: Env, hostUserId: string): Promise<boolean> {
  try {
    const config = await loadConfig(env, hostUserId)
    return Boolean(config?.profile.isPublished && config.availabilityRules.length > 0)
  } catch {
    return false
  }
}
