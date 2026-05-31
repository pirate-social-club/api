import { afterEach, describe, expect, test } from "bun:test"
import { join } from "node:path"
import { openCommunityDb } from "../src/lib/communities/community-db-factory"
import { processNextCommunityJob } from "../src/lib/communities/jobs/runner"
import { buildLocalizedPostResponse } from "../src/lib/localization/post-localization-service"
import { getPostById } from "../src/lib/posts/community-post-query-store"
import type { Env } from "../src/types"
import {
  buildCommunityRepository,
  cleanupCommunityJobRunnerArtifacts,
  createCommunityJobRunnerRoot,
  enqueuePostLabelJob,
  fetchCommunityJobs,
  seedCommunityLabels,
  seedCommunityState,
} from "./community-job-runner-test-helpers"
import { withMockedFetch } from "./helpers"

afterEach(async () => {
  await cleanupCommunityJobRunnerArtifacts()
})

describe("community-job-runner labels", () => {
  test("materializes post labels through the community job worker", async () => {
    const rootDir = await createCommunityJobRunnerRoot("pirate-community-job-labels-")
    const databasePath = join(rootDir, "community.db")
    const communityId = "cmt_job_labels"
    const env: Env = {
      LOCAL_COMMUNITY_DB_ROOT: rootDir,
      OPENROUTER_API_KEY: "test-openrouter-key",
      OPENROUTER_LABELING_MODEL: "google/gemini-2.5-flash-lite-preview-09-2025",
    }
    const repo = buildCommunityRepository(databasePath, communityId)
    const { postId } = await seedCommunityState({
      env,
      repo,
      communityId,
      memberUserIds: ["usr_owner"],
    })

    await seedCommunityLabels({
      env,
      repo,
      communityId,
      definitions: [
        {
          label_id: "lbl_question",
          label: "Question",
          color_token: "#f97316",
        },
        {
          label_id: "lbl_discussion",
          label: "Discussion",
          color_token: "#3b82f6",
        },
      ],
    })

    await withMockedFetch(() => (async () => {
      return new Response(JSON.stringify({
        choices: [
          {
            message: {
              content: JSON.stringify({
                label_id: "lbl_question",
                confidence: 0.93,
              }),
            },
          },
        ],
      }), {
        status: 200,
        headers: { "content-type": "application/json" },
      })
    }) as typeof fetch, async () => {
      await enqueuePostLabelJob({
        env,
        repo,
        communityId,
        postId,
      })

      const processed = await processNextCommunityJob({
        env,
        communityId,
        communityRepository: repo,
      })
      expect(processed?.job_type).toBe("post_label_materialize")
      expect(processed?.status).toBe("succeeded")
      expect(processed?.result_ref).toBe("lbl_question:assigned")
    })

    const verifyDb = await openCommunityDb(env, repo, communityId)
    try {
      const post = await getPostById(verifyDb.client, postId)
      expect(post?.label_id).toBe("lbl_question")
      expect(post?.label_assignment_status).toBe("assigned")
      expect(post?.label_assigned_by).toBe("ai")
      expect(post?.label_ai_confidence).toBe(0.93)

      const localized = await buildLocalizedPostResponse({
        executor: verifyDb.client,
        post: post!,
      })
      expect(localized.label).toEqual({
        label_id: "lbl_question",
        label: "Question",
        color_token: "#f97316",
        status: "active",
      })
    } finally {
      verifyDb.close()
    }
  })

  test("marks post label assignments failed when OPENROUTER_API_KEY is missing", async () => {
    const rootDir = await createCommunityJobRunnerRoot("pirate-community-job-labels-missing-key-")
    const databasePath = join(rootDir, "community.db")
    const communityId = "cmt_job_labels_missing_key"
    const env: Env = {
      LOCAL_COMMUNITY_DB_ROOT: rootDir,
      OPENROUTER_LABELING_MODEL: "google/gemini-2.5-flash-lite-preview-09-2025",
    }
    const repo = buildCommunityRepository(databasePath, communityId)
    const { postId } = await seedCommunityState({
      env,
      repo,
      communityId,
      memberUserIds: ["usr_owner"],
    })

    await seedCommunityLabels({
      env,
      repo,
      communityId,
      definitions: [
        {
          label_id: "lbl_question",
          label: "Question",
          color_token: "#f97316",
        },
      ],
    })

    await enqueuePostLabelJob({
      env,
      repo,
      communityId,
      postId,
    })

    const processed = await processNextCommunityJob({
      env,
      communityId,
      communityRepository: repo,
    })
    expect(processed?.job_type).toBe("post_label_materialize")
    expect(processed?.status).toBe("failed")
    expect(processed?.error_code).toBe("OPENROUTER_API_KEY is not configured")

    const verifyDb = await openCommunityDb(env, repo, communityId)
    try {
      const post = await getPostById(verifyDb.client, postId)
      expect(post?.label_id).toBeNull()
      expect(post?.label_assignment_status).toBe("failed")
      expect(post?.label_assignment_error).toBe("OPENROUTER_API_KEY is not configured")

      const jobs = await fetchCommunityJobs(verifyDb.client)
      const labelJob = jobs.find((job) => job.subject_id === postId)
      expect(labelJob?.status).toBe("failed")
    } finally {
      verifyDb.close()
    }
  })
})
