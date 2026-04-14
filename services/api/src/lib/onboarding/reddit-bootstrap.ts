import { internalError } from "../errors"
import { nowIso } from "../helpers"
import type { Env, RedditImportSummary } from "../../types"

const DEFAULT_PROFILE_USER_AGENT =
  "Mozilla/5.0 (compatible; PirateRedditVerifier/0.1; +https://pirate.example)"
const DEFAULT_PULLPUSH_BASE_URL = "https://api.pullpush.io/reddit"

type RedditCheckResult =
  | { status: "verified" }
  | { status: "pending"; failureCode: "code_not_found" }
  | { status: "failed"; failureCode: "username_not_found" | "rate_limited" | "source_error" }

type RedditImporter = (input: { env: Env; redditUsername: string }) => Promise<RedditImportSummary>
type RedditChecker = (input: {
  env: Env
  redditUsername: string
  verificationCode: string
}) => Promise<RedditCheckResult>

let redditCheckerForTests: RedditChecker | null = null
let redditImporterForTests: RedditImporter | null = null

type PullPushThing = {
  subreddit?: string
  score?: number
  created_utc?: number
}

function pullpushBaseUrl(env: Env): string {
  return String(env.REDDIT_PULLPUSH_BASE_URL || DEFAULT_PULLPUSH_BASE_URL).trim().replace(/\/+$/, "")
}

async function fetchPullPushThings(
  env: Env,
  kind: "submission" | "comment",
  redditUsername: string,
): Promise<PullPushThing[]> {
  const url = new URL(`${pullpushBaseUrl(env)}/search/${kind}/`)
  url.searchParams.set("author", redditUsername)
  url.searchParams.set("size", "200")

  const response = await fetch(url.toString())
  if (response.status === 429) {
    throw new Error("rate_limited")
  }
  if (!response.ok) {
    throw new Error(`source_error:${response.status}`)
  }

  const body = await response.json() as { data?: PullPushThing[] }
  return Array.isArray(body.data) ? body.data : []
}

function normalizeTopSubreddits(things: PullPushThing[]): RedditImportSummary["top_subreddits"] {
  const bySubreddit = new Map<string, { karma: number; posts: number }>()

  for (const thing of things) {
    const subreddit = typeof thing.subreddit === "string" ? thing.subreddit.trim() : ""
    if (!subreddit) {
      continue
    }
    const existing = bySubreddit.get(subreddit) ?? { karma: 0, posts: 0 }
    existing.karma += typeof thing.score === "number" ? thing.score : 0
    existing.posts += 1
    bySubreddit.set(subreddit, existing)
  }

  return [...bySubreddit.entries()]
    .sort((a, b) => (b[1].karma - a[1].karma) || (b[1].posts - a[1].posts) || a[0].localeCompare(b[0]))
    .slice(0, 5)
    .map(([subreddit, value]) => ({
      subreddit,
      karma: value.karma,
      posts: value.posts,
      rank_source: value.karma !== 0 ? "karma" : value.posts !== 0 ? "posts" : "source_order",
    }))
}

async function defaultRedditImporter(input: {
  env: Env
  redditUsername: string
}): Promise<RedditImportSummary> {
  const [submissions, comments] = await Promise.all([
    fetchPullPushThings(input.env, "submission", input.redditUsername),
    fetchPullPushThings(input.env, "comment", input.redditUsername),
  ])

  const allThings = [...submissions, ...comments]
  const createdEpochs = allThings
    .map((thing) => (typeof thing.created_utc === "number" ? thing.created_utc : null))
    .filter((value): value is number => value != null && Number.isFinite(value))
  const earliestEpoch = createdEpochs.length > 0 ? Math.min(...createdEpochs) : null
  const accountAgeDays = earliestEpoch == null
    ? null
    : Math.max(0, Math.floor((Date.now() - (earliestEpoch * 1000)) / 86_400_000))
  const globalKarma = allThings.reduce(
    (total, thing) => total + (typeof thing.score === "number" ? thing.score : 0),
    0,
  )
  const topSubreddits = normalizeTopSubreddits(allThings)

  return {
    reddit_username: input.redditUsername,
    imported_at: nowIso(),
    account_age_days: accountAgeDays,
    global_karma: allThings.length > 0 ? globalKarma : null,
    top_subreddits: topSubreddits,
    moderator_of: [],
    inferred_interests: [],
    suggested_communities: [],
    coverage_note: allThings.length > 0
      ? "Historical archival snapshot from PullPush-backed Reddit data; coverage may be partial."
      : "No historical Reddit activity was found in the archival source.",
  }
}

async function defaultRedditChecker(input: {
  env: Env
  redditUsername: string
  verificationCode: string
}): Promise<RedditCheckResult> {
  const url = `https://www.reddit.com/user/${encodeURIComponent(input.redditUsername)}/about.json`
  const response = await fetch(url, {
    headers: {
      "user-agent": String(input.env.REDDIT_PROFILE_CHECK_USER_AGENT || DEFAULT_PROFILE_USER_AGENT),
    },
  }).catch(() => null)

  if (!response) {
    return {
      status: "failed",
      failureCode: "source_error",
    }
  }

  if (response.status === 404) {
    return {
      status: "failed",
      failureCode: "username_not_found",
    }
  }

  if (response.status === 429) {
    return {
      status: "failed",
      failureCode: "rate_limited",
    }
  }

  if (!response.ok) {
    return {
      status: "failed",
      failureCode: "source_error",
    }
  }

  const body = await response.json().catch(() => null) as {
    data?: {
      subreddit?: {
        public_description?: string
        description?: string
      }
    }
  } | null

  const publicDescription = body?.data?.subreddit?.public_description ?? ""
  const description = body?.data?.subreddit?.description ?? ""
  const haystack = `${publicDescription}\n${description}`

  if (haystack.includes(input.verificationCode)) {
    return {
      status: "verified",
    }
  }

  return {
    status: "pending",
    failureCode: "code_not_found",
  }
}

export function normalizeRedditUsername(value: string): string | null {
  const normalized = value.trim().replace(/^u\//i, "").toLowerCase()
  return /^[a-z0-9][a-z0-9_-]{1,31}$/i.test(normalized) ? normalized : null
}

export function makeRedditVerificationCode(): string {
  return `pirate-verification=${crypto.randomUUID().replace(/-/g, "").slice(0, 16)}`
}

export async function checkRedditVerificationCode(input: {
  env: Env
  redditUsername: string
  verificationCode: string
}): Promise<RedditCheckResult> {
  return await (redditCheckerForTests ?? defaultRedditChecker)(input)
}

export async function importRedditSnapshot(input: {
  env: Env
  redditUsername: string
}): Promise<RedditImportSummary> {
  return await (redditImporterForTests ?? defaultRedditImporter)(input)
}

export function setRedditVerificationCheckerForTests(checker: RedditChecker | null): void {
  redditCheckerForTests = checker
}

export function setRedditSnapshotImporterForTests(importer: RedditImporter | null): void {
  redditImporterForTests = importer
}
