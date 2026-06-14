// MIRROR NOTE: `isPlanetScalePostgresUrl` and `normalizePostgresConnectionStringForDriver`
// mirror core/scripts/lib/postgres-url.ts (`isPlanetScalePostgresUrl` /
// `normalizePostgresUrlForClient`). There is NO shared import across the
// api/ <-> core/ sibling-repo boundary (vendored split, by decision) — if you
// change those two behaviors, update core/scripts/lib/postgres-url.ts too.
// `configurePostgresDriverForUrl` is api-only: it rewires the @neondatabase
// serverless driver for the Workers runtime and has no core/ counterpart.
import { neonConfig } from "@neondatabase/serverless"

const defaultNeonFetchEndpoint = neonConfig.fetchEndpoint
const defaultNeonWsProxy = neonConfig.wsProxy
const defaultNeonPipelineConnect = neonConfig.pipelineConnect

neonConfig.poolQueryViaFetch = true

export function isPlanetScalePostgresUrl(value: string): boolean {
  try {
    const url = new URL(value)
    return url.hostname.toLowerCase().endsWith(".pg.psdb.cloud")
  } catch {
    return false
  }
}

// PlanetScale Postgres (*.pg.psdb.cloud) speaks the Neon HTTP/WS protocol but at
// its own endpoints. Rewire the driver for those hosts; reset to Neon defaults
// otherwise.
export function configurePostgresDriverForUrl(url: string): void {
  neonConfig.poolQueryViaFetch = true

  if (!isPlanetScalePostgresUrl(url)) {
    neonConfig.fetchEndpoint = defaultNeonFetchEndpoint
    neonConfig.wsProxy = defaultNeonWsProxy
    neonConfig.pipelineConnect = defaultNeonPipelineConnect
    return
  }

  neonConfig.fetchEndpoint = (host) => `https://${host}/sql`
  neonConfig.wsProxy = (host, port) => `${host}/v2?address=${host}:${port}`
  neonConfig.pipelineConnect = false
}

// PlanetScale sends `sslrootcert=system`, which the bundled pg driver would try
// to fs.readFileSync() (fails in Workers). Strip it for PlanetScale URLs.
export function normalizePostgresConnectionStringForDriver(value: string): string {
  if (!isPlanetScalePostgresUrl(value)) {
    return value
  }

  const url = new URL(value)
  if (url.searchParams.get("sslrootcert") === "system") {
    url.searchParams.delete("sslrootcert")
  }
  return url.toString()
}
