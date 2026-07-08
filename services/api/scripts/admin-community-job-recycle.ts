#!/usr/bin/env bun

export {}

type Options = {
  baseUrl: string
  adminToken: string
  communityId: string
  jobId: string
  reason: string | null
}

function usage(exitCode = 1): never {
  console.error(`Usage:
  PIRATE_API_BASE_URL=https://api.example.com PIRATE_ADMIN_TOKEN=... \\
    bun run scripts/admin-community-job-recycle.ts --community-id com_... --job-id job_cjb_... [--reason "operator retry"]

Options:
  --base-url URL       Overrides PIRATE_API_BASE_URL.
  --admin-token TOKEN  Overrides PIRATE_ADMIN_TOKEN.
  --community-id ID    Raw cmt_... or public com_cmt_... community id.
  --job-id ID          Raw cjb_... or public job_cjb_... community job id.
  --reason TEXT        Optional short audit reason.`)
  process.exit(exitCode)
}

function readValue(argv: string[], index: number, flag: string): string {
  const value = argv[index + 1]?.trim()
  if (!value) {
    console.error(`${flag} requires a value`)
    usage()
  }
  return value
}

function parseArgs(argv: string[]): Options {
  if (argv.includes("-h") || argv.includes("--help")) {
    usage(0)
  }

  let baseUrl = process.env.PIRATE_API_BASE_URL?.trim() ?? ""
  let adminToken = process.env.PIRATE_ADMIN_TOKEN?.trim() ?? ""
  let communityId = ""
  let jobId = ""
  let reason: string | null = null

  for (let index = 0; index < argv.length;) {
    const arg = argv[index]
    switch (arg) {
      case "--base-url":
        baseUrl = readValue(argv, index, arg)
        index += 2
        break
      case "--admin-token":
        adminToken = readValue(argv, index, arg)
        index += 2
        break
      case "--community-id":
        communityId = readValue(argv, index, arg)
        index += 2
        break
      case "--job-id":
        jobId = readValue(argv, index, arg)
        index += 2
        break
      case "--reason":
        reason = readValue(argv, index, arg)
        index += 2
        break
      default:
        console.error(`unknown argument: ${arg}`)
        usage()
    }
  }

  if (!baseUrl) {
    console.error("missing --base-url or PIRATE_API_BASE_URL")
    usage()
  }
  if (!adminToken) {
    console.error("missing --admin-token or PIRATE_ADMIN_TOKEN")
    usage()
  }
  if (!communityId || !jobId) {
    console.error("--community-id and --job-id are required")
    usage()
  }

  return {
    baseUrl: baseUrl.replace(/\/+$/u, ""),
    adminToken,
    communityId,
    jobId,
    reason,
  }
}

const options = parseArgs(process.argv.slice(2))
const response = await fetch(`${options.baseUrl}/admin/debug/community-job/recycle`, {
  method: "POST",
  headers: {
    "content-type": "application/json",
    "x-admin-token": options.adminToken,
  },
  body: JSON.stringify({
    community_id: options.communityId,
    job_id: options.jobId,
    ...(options.reason ? { reason: options.reason } : {}),
  }),
})

const bodyText = await response.text()
let body: unknown = bodyText
try {
  body = JSON.parse(bodyText)
} catch {
  // Leave non-JSON error bodies printable.
}

if (!response.ok) {
  console.error(JSON.stringify(body, null, 2))
  process.exit(1)
}

console.log(JSON.stringify(body, null, 2))
