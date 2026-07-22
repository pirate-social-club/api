import { describe, expect, it } from "bun:test"
import { exhaustedCommunityJobs } from "./runner"
import { COMMUNITY_JOB_MAX_ATTEMPTS } from "./runner-types"
import type { CommunityJobRow } from "./store"

function job(overrides: Partial<CommunityJobRow>): CommunityJobRow {
  return {
    job_id: "cjb_1",
    community_id: "cmt_1",
    job_type: "song_study_generate",
    subject_type: "post",
    subject_id: "pst_1",
    status: "failed",
    payload_json: null,
    result_ref: null,
    error_code: null,
    attempt_count: COMMUNITY_JOB_MAX_ATTEMPTS,
    available_at: null,
    created_at: "2026-07-22T10:00:00.000Z",
    updated_at: "2026-07-22T10:00:00.000Z",
    ...overrides,
  } as CommunityJobRow
}

function summaryOf(jobs: CommunityJobRow[]) {
  return { communities: [{ community_id: "cmt_1", processed_jobs: jobs.length, jobs }] }
}

describe("exhaustedCommunityJobs", () => {
  it("reports jobs that burned their final attempt", () => {
    const result = exhaustedCommunityJobs(summaryOf([
      job({ job_id: "cjb_dead", error_code: "Unsupported community job type: song_study_generate" }),
    ]))

    expect(result).toEqual([{
      community_id: "cmt_1",
      job_id: "cjb_dead",
      job_type: "song_study_generate",
      subject_id: "pst_1",
      error: "Unsupported community job type: song_study_generate",
    }])
  })

  it("redacts and truncates the raw exception message before it reaches logs and the alert sink", () => {
    // error_code is not a code: recordCommunityJobFailure stores the raw exception
    // message, which carries provider response bodies verbatim.
    const [entry] = exhaustedCommunityJobs(summaryOf([
      job({
        error_code: `OpenRouter request failed: https://openrouter.ai/api/v1/chat?key=sk-secret contact ops@pirate.sc ${"x".repeat(400)}`,
      }),
    ]))

    expect(entry!.error).not.toContain("openrouter.ai")
    expect(entry!.error).not.toContain("sk-secret")
    expect(entry!.error).not.toContain("ops@pirate.sc")
    expect(entry!.error).toContain("[url]")
    expect(entry!.error).toContain("[email]")
    expect(entry!.error!.length).toBeLessThanOrEqual(240)
  })

  it("ignores failures that still have retries left", () => {
    const result = exhaustedCommunityJobs(summaryOf([
      job({ job_id: "cjb_retrying", attempt_count: COMMUNITY_JOB_MAX_ATTEMPTS - 1 }),
    ]))

    expect(result).toEqual([])
  })

  it("ignores succeeded jobs even at the attempt cap", () => {
    // post_publish_finalize routinely succeeds on a later attempt; that is not
    // an exhaustion event and must never raise the alert.
    const result = exhaustedCommunityJobs(summaryOf([
      job({ job_id: "cjb_ok", job_type: "post_publish_finalize", status: "succeeded" }),
    ]))

    expect(result).toEqual([])
  })

  it("flattens across communities", () => {
    const result = exhaustedCommunityJobs({
      communities: [
        { community_id: "cmt_1", processed_jobs: 1, jobs: [job({ job_id: "cjb_a" })] },
        { community_id: "cmt_2", processed_jobs: 1, jobs: [job({ community_id: "cmt_2", job_id: "cjb_b" })] },
      ],
    })

    expect(result.map((entry) => entry.job_id)).toEqual(["cjb_a", "cjb_b"])
    expect(result.map((entry) => entry.community_id)).toEqual(["cmt_1", "cmt_2"])
  })
})
