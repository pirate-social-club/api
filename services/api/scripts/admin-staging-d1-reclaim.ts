export {}

const CONFIRMATION = "RECLAIM STAGING SMOKE COMMUNITIES"

const apply = process.argv.includes("--apply")
const communityIds = process.argv
  .slice(2)
  .filter((arg) => arg !== "--apply")

if (communityIds.length === 0) {
  throw new Error("usage: bun run admin:staging-d1-reclaim -- [--apply] <community-id> [...]")
}

const apiBase = String(process.env.PIRATE_API_BASE_URL ?? "https://api-staging.pirate.sc").replace(/\/$/u, "")
if (new URL(apiBase).hostname !== "api-staging.pirate.sc") {
  throw new Error(`refusing non-staging API origin: ${apiBase}`)
}
const adminCredential = String(process.env.PIRATE_ADMIN_OPERATOR_CREDENTIAL ?? "").trim()
if (!adminCredential) throw new Error("PIRATE_ADMIN_OPERATOR_CREDENTIAL is required")

const response = await fetch(`${apiBase}/admin/debug/staging-d1/reclaim`, {
  method: "POST",
  headers: {
    "content-type": "application/json",
    Authorization: `Operator ${adminCredential}`,
  },
  body: JSON.stringify({
    community_ids: communityIds,
    apply,
    ...(apply ? { confirmation: CONFIRMATION } : {}),
  }),
})
const result = await response.json().catch(() => ({ error: "non_json_response" }))
console.log(JSON.stringify(result, null, 2))
if (!response.ok) process.exitCode = 1
