// MIRROR NOTE: `isPlanetScalePostgresUrl` and `normalizePostgresConnectionStringForDriver`
// mirror core/scripts/lib/postgres-url.ts (`isPlanetScalePostgresUrl` /
// `normalizePostgresUrlForClient`). There is NO shared import across the
// api/ <-> core/ sibling-repo boundary (vendored split, by decision) — if you
// change those two behaviors, update core/scripts/lib/postgres-url.ts too.
export function isPlanetScalePostgresUrl(value: string): boolean {
  try {
    const url = new URL(value)
    return url.hostname.toLowerCase().endsWith(".pg.psdb.cloud")
  } catch {
    return false
  }
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
