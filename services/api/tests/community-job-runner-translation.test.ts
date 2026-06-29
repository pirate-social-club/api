import { afterEach, describe, expect, test } from "bun:test"
import { join } from "node:path"
import { openCommunityDb } from "../src/lib/communities/community-db-factory"
import { processCommunityJobById, processNextCommunityJob } from "../src/lib/communities/jobs/runner"
import { getCommentById } from "../src/lib/comments/community-comment-store"
import { buildLocalizedPostResponse } from "../src/lib/localization/post-localization-service"
import { computeCommentSourceHash, computePostSourceHash, computeTextSourceHash } from "../src/lib/localization/content-source-hash"
import { getContentTranslation } from "../src/lib/localization/content-translation-store"
import { getPostById } from "../src/lib/posts/community-post-query-store"
import type { Env } from "../src/types"
import {
  buildCommunityRepository,
  cleanupCommunityJobRunnerArtifacts,
  createCommunityJobRunnerRoot,
  createOwnedComment,
  enqueueCommentTranslationJob,
  enqueueCommunityTextTranslationJob,
  enqueuePostTranslationJob,
  fetchCommunityJobs,
  seedCommunityState,
  updatePostTranslationPolicy,
} from "./community-job-runner-test-helpers"
import { withMockedFetch } from "./helpers"

afterEach(async () => {
  await cleanupCommunityJobRunnerArtifacts()
})

describe("community-job-runner translation", () => {
  test("materializes cached post translations through the community job worker", async () => {
    const rootDir = await createCommunityJobRunnerRoot("pirate-community-job-translation-")
    const databasePath = join(rootDir, "community.db")
    const communityId = "cmt_job_translation"
    const env: Env = {
      LOCAL_COMMUNITY_DB_ROOT: rootDir,
      OPENROUTER_API_KEY: "test-openrouter-key",
      OPENROUTER_TRANSLATION_MODEL: "google/gemini-2.5-flash-lite-preview-09-2025",
    }
    const repo = buildCommunityRepository(databasePath, communityId)
    const { postId } = await seedCommunityState({
      env,
      repo,
      communityId,
      memberUserIds: ["usr_owner"],
    })

    await updatePostTranslationPolicy({ env, repo, communityId, postId })

    await withMockedFetch(() => (async () => {
      return new Response(JSON.stringify({
        choices: [
          {
            message: {
              content: JSON.stringify({
                source_language: "en",
                target_locale: "es",
                outcome: "translated",
                translated_title: "Titulo traducido",
                translated_body: "Cuerpo traducido",
                translated_caption: null,
              }),
            },
          },
        ],
      }), {
        status: 200,
        headers: { "content-type": "application/json" },
      })
    }), async () => {
      await enqueuePostTranslationJob({ env, repo, communityId, postId, locale: "es" })

      const processed = await processNextCommunityJob({
        env,
        communityId,
        communityRepository: repo,
      })
      expect(processed?.job_type).toBe("post_translation_materialize")
      expect(processed?.status).toBe("succeeded")
      expect(processed?.result_ref).toBe("es:translated")
    })

    const verifyDb = await openCommunityDb(env, repo, communityId)
    try {
      const post = await getPostById(verifyDb.client, postId)
      const sourceHash = await computePostSourceHash(post!)
      const translation = await getContentTranslation({
        executor: verifyDb.client,
        contentType: "post",
        contentId: postId,
        locale: "es",
        sourceHash,
      })
      expect(translation?.outcome).toBe("translated")
      expect(translation?.translated_title).toBe("Titulo traducido")
      expect(translation?.translated_body).toBe("Cuerpo traducido")
      expect(translation?.provider).toBe("openrouter")
    } finally {
      verifyDb.close()
    }
  })

  test("fails post translation jobs clearly when OPENROUTER_API_KEY is missing", async () => {
    const rootDir = await createCommunityJobRunnerRoot("pirate-community-job-translation-missing-key-")
    const databasePath = join(rootDir, "community.db")
    const communityId = "cmt_job_translation_missing_key"
    const env: Env = {
      LOCAL_COMMUNITY_DB_ROOT: rootDir,
      OPENROUTER_TRANSLATION_MODEL: "google/gemini-2.5-flash-lite-preview-09-2025",
    }
    const repo = buildCommunityRepository(databasePath, communityId)
    const { postId } = await seedCommunityState({
      env,
      repo,
      communityId,
      memberUserIds: ["usr_owner"],
    })

    await updatePostTranslationPolicy({ env, repo, communityId, postId })
    await enqueuePostTranslationJob({ env, repo, communityId, postId, locale: "es" })

    const processed = await processNextCommunityJob({
      env,
      communityId,
      communityRepository: repo,
    })
    expect(processed?.job_type).toBe("post_translation_materialize")
    expect(processed?.status).toBe("failed")
    expect(processed?.error_code).toBe("OPENROUTER_API_KEY is not configured")

    const verifyDb = await openCommunityDb(env, repo, communityId)
    try {
      const jobs = await fetchCommunityJobs(verifyDb.client)
      const translationJob = jobs.find((job) => job.subject_id === `${postId}:es`)
      expect(translationJob?.status).toBe("failed")
      expect(translationJob?.error_code).toBe("OPENROUTER_API_KEY is not configured")
    } finally {
      verifyDb.close()
    }
  })

  test("refreshes stale cached post translations when translated titles are missing", async () => {
    const rootDir = await createCommunityJobRunnerRoot("pirate-community-job-translation-refresh-")
    const databasePath = join(rootDir, "community.db")
    const communityId = "cmt_job_translation_refresh"
    const env: Env = {
      LOCAL_COMMUNITY_DB_ROOT: rootDir,
      OPENROUTER_API_KEY: "test-openrouter-key",
      OPENROUTER_TRANSLATION_MODEL: "google/gemini-2.5-flash-lite-preview-09-2025",
    }
    const repo = buildCommunityRepository(databasePath, communityId)
    const { postId } = await seedCommunityState({
      env,
      repo,
      communityId,
      memberUserIds: ["usr_owner"],
    })

    await updatePostTranslationPolicy({ env, repo, communityId, postId })

    const setupDb = await openCommunityDb(env, repo, communityId)
    try {
      const post = await getPostById(setupDb.client, postId)
      const sourceHash = await computePostSourceHash(post!)
      const now = new Date().toISOString()
      await setupDb.client.execute({
        sql: `
          INSERT INTO content_translations (
            content_translation_id, content_type, content_id, locale, source_hash,
            source_language, outcome, translated_title, translated_body, translated_caption, provider,
            provider_model, provider_result_json, created_at, updated_at
          ) VALUES (
            ?1, 'post', ?2, 'es', ?3,
            'en', 'translated', NULL, 'Cuerpo traducido viejo', NULL, 'openrouter',
            'google/gemini-2.5-flash-lite-preview-09-2025', NULL, ?4, ?4
          )
        `,
        args: [`ctr_${postId}_es`, postId, sourceHash, now],
      })
    } finally {
      setupDb.close()
    }

    await enqueuePostTranslationJob({
      env,
      repo,
      communityId,
      postId,
      locale: "es",
      createdAt: new Date().toISOString(),
    })

    let callCount = 0
    await withMockedFetch(() => (async () => {
      callCount += 1
      return new Response(JSON.stringify({
        choices: [
          {
            message: {
              content: JSON.stringify({
                source_language: "en",
                target_locale: "es",
                outcome: "translated",
                translated_title: "Titulo actualizado",
                translated_body: "Cuerpo traducido actualizado",
                translated_caption: null,
              }),
            },
          },
        ],
      }), {
        status: 200,
        headers: { "content-type": "application/json" },
      })
    }), async () => {
      const processed = await processNextCommunityJob({
        env,
        communityId,
        communityRepository: repo,
      })
      expect(processed?.job_type).toBe("post_translation_materialize")
      expect(processed?.status).toBe("succeeded")
      expect(processed?.result_ref).toBe("es:translated")
    })
    expect(callCount).toBe(1)

    const verifyDb = await openCommunityDb(env, repo, communityId)
    try {
      const post = await getPostById(verifyDb.client, postId)
      const sourceHash = await computePostSourceHash(post!)
      const translation = await getContentTranslation({
        executor: verifyDb.client,
        contentType: "post",
        contentId: postId,
        locale: "es",
        sourceHash,
      })
      expect(translation?.translated_title).toBe("Titulo actualizado")
      expect(translation?.translated_body).toBe("Cuerpo traducido actualizado")
    } finally {
      verifyDb.close()
    }
  })

  test("materializes prediction market embed question translations", async () => {
    const rootDir = await createCommunityJobRunnerRoot("pirate-community-job-market-embed-translation-")
    const databasePath = join(rootDir, "community.db")
    const communityId = "cmt_job_market_embed_translation"
    const env: Env = {
      LOCAL_COMMUNITY_DB_ROOT: rootDir,
      OPENROUTER_API_KEY: "test-openrouter-key",
      OPENROUTER_TRANSLATION_MODEL: "google/gemini-2.5-flash-lite-preview-09-2025",
    }
    const repo = buildCommunityRepository(databasePath, communityId)
    const { postId } = await seedCommunityState({
      env,
      repo,
      communityId,
      memberUserIds: ["usr_owner"],
    })

    const embed = {
      embed: "emb_market_translation",
      embed_key: "kalshi:KXKANYEISRAEL",
      provider: "kalshi",
      provider_ref: "KXKANYEISRAEL",
      canonical_url: "https://kalshi.com/markets/kxkanyeisrael/will-kanye-visit-area/kxkanyeisrael",
      original_url: "https://kalshi.com/markets/kxkanyeisrael/will-kanye-visit-area/kxkanyeisrael",
      state: "embed",
      preview: {
        question: "Will Kanye visit Israel before June?",
        yes_price: 0.42,
        outcomes: [
          { label: "Yes", probability: 0.42 },
          { label: "No", probability: 0.58 },
        ],
      },
      oembed_html: null,
      oembed_cache_age: 300,
      unavailable_reason: null,
      last_checked_at: null,
    }

    const setupDb = await openCommunityDb(env, repo, communityId)
    try {
      await setupDb.client.execute({
        sql: `
          UPDATE posts
          SET post_type = 'link',
              title = NULL,
              body = NULL,
              caption = NULL,
              link_url = ?2,
              embeds_json = ?3,
              source_language = 'en',
              translation_policy = 'machine_allowed'
          WHERE post_id = ?1
        `,
        args: [postId, embed.canonical_url, JSON.stringify([embed])],
      })
    } finally {
      setupDb.close()
    }

    const translatedBodies = [
      "هل سيزور كاني إسرائيل قبل يونيو؟",
      "نعم",
      "لا",
    ]
    await withMockedFetch(() => (async () => {
      const translatedBody = translatedBodies.shift()
      return new Response(JSON.stringify({
        choices: [
          {
            message: {
              content: JSON.stringify({
                source_language: "en",
                target_locale: "ar",
                outcome: "translated",
                translated_title: null,
                translated_body: translatedBody,
                translated_caption: null,
              }),
            },
          },
        ],
      }), {
        status: 200,
        headers: { "content-type": "application/json" },
      })
    }), async () => {
      await enqueuePostTranslationJob({ env, repo, communityId, postId, locale: "ar" })

      const processed = await processNextCommunityJob({
        env,
        communityId,
        communityRepository: repo,
      })
      expect(processed?.job_type).toBe("post_translation_materialize")
      expect(processed?.status).toBe("succeeded")
      expect(processed?.result_ref).toBe("ar:same_language:embeds_3")
    })

    const verifyDb = await openCommunityDb(env, repo, communityId)
    try {
      const post = await getPostById(verifyDb.client, postId)
      if (!post) throw new Error("expected post")
      const sourceHash = await computeTextSourceHash("Will Kanye visit Israel before June?")
      const translation = await getContentTranslation({
        executor: verifyDb.client,
        contentType: "post",
        contentId: postId,
        fieldKey: "embed:kalshi:KXKANYEISRAEL:question",
        locale: "ar",
        sourceHash,
      })
      expect(translation?.translated_body).toBe("هل سيزور كاني إسرائيل قبل يونيو؟")
      const yesSourceHash = await computeTextSourceHash("Yes")
      const yesTranslation = await getContentTranslation({
        executor: verifyDb.client,
        contentType: "post",
        contentId: postId,
        fieldKey: "embed:kalshi:KXKANYEISRAEL:outcome:0",
        locale: "ar",
        sourceHash: yesSourceHash,
      })
      expect(yesTranslation?.translated_body).toBe("نعم")

      const localized = await buildLocalizedPostResponse({
        executor: verifyDb.client,
        post,
        locale: "ar",
      })
      expect(localized.translation_state).toBe("ready")
      expect(localized.translated_embeds?.[0]).toEqual({
        embed_key: "kalshi:KXKANYEISRAEL",
        source_hash: sourceHash,
        translated_question: "هل سيزور كاني إسرائيل قبل يونيو؟",
        translated_outcomes: [
          {
            label: "Yes",
            source_hash: yesSourceHash,
            translated_label: "نعم",
          },
          {
            label: "No",
            source_hash: await computeTextSourceHash("No"),
            translated_label: "لا",
          },
        ],
        translated_title: null,
      })
    } finally {
      verifyDb.close()
    }
  })

  test("materializes cached comment translations through the community job worker", async () => {
    const rootDir = await createCommunityJobRunnerRoot("pirate-community-job-comment-translation-")
    const databasePath = join(rootDir, "community.db")
    const communityId = "cmt_job_comment_translation"
    const env: Env = {
      LOCAL_COMMUNITY_DB_ROOT: rootDir,
      OPENROUTER_API_KEY: "test-openrouter-key",
      OPENROUTER_TRANSLATION_MODEL: "google/gemini-2.5-flash-lite-preview-09-2025",
    }
    const repo = buildCommunityRepository(databasePath, communityId)
    const { postId } = await seedCommunityState({
      env,
      repo,
      communityId,
      memberUserIds: ["usr_owner"],
    })

    const comment = await createOwnedComment({
      env,
      repo,
      communityId,
      postId,
      userId: "usr_owner",
    })

    await withMockedFetch(() => (async () => {
      return new Response(JSON.stringify({
        choices: [
          {
            message: {
              content: JSON.stringify({
                source_language: "en",
                target_locale: "es",
                outcome: "translated",
                translated_title: null,
                translated_body: "Comentario traducido",
                translated_caption: null,
              }),
            },
          },
        ],
      }), {
        status: 200,
        headers: { "content-type": "application/json" },
      })
    }), async () => {
      const jobId = await enqueueCommentTranslationJob({
        env,
        repo,
        communityId,
        commentId: comment.comment_id,
        locale: "es",
      })
      expect(jobId).not.toBe("")

      const processed = await processCommunityJobById({
        env,
        communityId,
        jobId,
        communityRepository: repo,
      })
      expect(processed?.job_type).toBe("comment_translation_materialize")
      expect(processed?.status).toBe("succeeded")
      expect(processed?.result_ref).toBe("es:translated")
    })

    const verifyDb = await openCommunityDb(env, repo, communityId)
    try {
      const storedComment = await getCommentById(verifyDb.client, comment.comment_id)
      const sourceHash = await computeCommentSourceHash(storedComment!)
      const translation = await getContentTranslation({
        executor: verifyDb.client,
        contentType: "comment",
        contentId: comment.comment_id,
        locale: "es",
        sourceHash,
      })
      expect(translation?.outcome).toBe("translated")
      expect(translation?.translated_body).toBe("Comentario traducido")
      expect(translation?.provider).toBe("openrouter")
    } finally {
      verifyDb.close()
    }
  })

  test("materializes field-keyed community text translations through the community job worker", async () => {
    const rootDir = await createCommunityJobRunnerRoot("pirate-community-job-community-text-")
    const databasePath = join(rootDir, "community.db")
    const communityId = "cmt_job_community_text_translation"
    const env: Env = {
      LOCAL_COMMUNITY_DB_ROOT: rootDir,
      OPENROUTER_API_KEY: "test-openrouter-key",
      OPENROUTER_TRANSLATION_MODEL: "google/gemini-2.5-flash-lite-preview-09-2025",
    }
    const repo = buildCommunityRepository(databasePath, communityId)
    await seedCommunityState({
      env,
      repo,
      communityId,
      memberUserIds: ["usr_owner"],
    })

    const setupDb = await openCommunityDb(env, repo, communityId)
    try {
      await setupDb.client.execute({
        sql: `
          UPDATE communities
          SET description = ?2,
              settings_json = ?3
          WHERE community_id = ?1
        `,
        args: [
          communityId,
          "Welcome to the community.",
          JSON.stringify({
            reference_links: [
              {
                id: "crl_runner",
                object: "community_reference_link",
                platform: "official_website",
                url: "https://pirate.test/community",
                label: "Official site",
                link_status: "active",
                verified: true,
                metadata: {
                  display_name: "Pirate hub",
                },
                position: 0,
              },
            ],
          }),
        ],
      })
      await setupDb.client.execute({
        sql: `
          INSERT INTO community_rules (
            rule_id, community_id, title, body, report_reason, position, status, created_at, updated_at
          ) VALUES (
            'rul_runner', ?1, 'Be kind', 'Keep the conversation civil.', 'Be kind', 0, 'active', ?2, ?2
          )
        `,
        args: [communityId, new Date().toISOString()],
      })
    } finally {
      setupDb.close()
    }

    await withMockedFetch(() => (async (_input: RequestInfo | URL, init?: RequestInit) => {
      const payload = JSON.parse(String(init?.body ?? "{}")) as {
        messages?: Array<{ role?: string; content?: string }>
      }
      const source = JSON.parse(payload.messages?.find((message) => message.role === "user")?.content ?? "{}") as {
        body?: string | null
        target_locale?: string
      }
      const translated = `es:${String(source.body ?? "").trim()}`
      return new Response(JSON.stringify({
        choices: [
          {
            message: {
              content: JSON.stringify({
                source_language: "en",
                target_locale: source.target_locale ?? "es",
                outcome: "translated",
                translated_title: null,
                translated_body: translated,
                translated_caption: null,
              }),
            },
          },
        ],
      }), {
        status: 200,
        headers: { "content-type": "application/json" },
      })
    }), async () => {
      await enqueueCommunityTextTranslationJob({
        env,
        repo,
        communityId,
        locale: "es",
      })

      const processed = await processNextCommunityJob({
        env,
        communityId,
        communityRepository: repo,
      })
      expect(processed?.job_type).toBe("community_text_translation_materialize")
      expect(processed?.status).toBe("succeeded")
      expect(processed?.result_ref).toBe("es:translated:3")
    })

    const verifyDb = await openCommunityDb(env, repo, communityId)
    try {
      const descriptionSourceHash = await computeTextSourceHash("Welcome to the community.")
      const descriptionTranslation = await getContentTranslation({
        executor: verifyDb.client,
        contentType: "community_text",
        contentId: communityId,
        fieldKey: "community.description",
        locale: "es",
        sourceHash: descriptionSourceHash,
      })
      expect(descriptionTranslation?.translated_body).toBe("es:Welcome to the community.")

      const ruleTitleSourceHash = await computeTextSourceHash("Be kind")
      const ruleBodySourceHash = await computeTextSourceHash("Keep the conversation civil.")
      const linkLabelSourceHash = await computeTextSourceHash("Official site")
      const linkDisplayNameSourceHash = await computeTextSourceHash("Pirate hub")

      const ruleTitleTranslation = await getContentTranslation({
        executor: verifyDb.client,
        contentType: "community_text",
        contentId: communityId,
        fieldKey: "community.rule.rule_rul_runner.title",
        locale: "es",
        sourceHash: ruleTitleSourceHash,
      })
      const ruleBodyTranslation = await getContentTranslation({
        executor: verifyDb.client,
        contentType: "community_text",
        contentId: communityId,
        fieldKey: "community.rule.rule_rul_runner.body",
        locale: "es",
        sourceHash: ruleBodySourceHash,
      })
      const linkLabelTranslation = await getContentTranslation({
        executor: verifyDb.client,
        contentType: "community_text",
        contentId: communityId,
        fieldKey: "community.reference_link.crl_runner.label",
        locale: "es",
        sourceHash: linkLabelSourceHash,
      })
      const linkDisplayNameTranslation = await getContentTranslation({
        executor: verifyDb.client,
        contentType: "community_text",
        contentId: communityId,
        fieldKey: "community.reference_link.crl_runner.metadata.display_name",
        locale: "es",
        sourceHash: linkDisplayNameSourceHash,
      })

      expect(ruleTitleTranslation?.translated_body).toBe("es:Be kind")
      expect(ruleBodyTranslation?.translated_body).toBe("es:Keep the conversation civil.")
      expect(linkLabelTranslation).toBeNull()
      expect(linkDisplayNameTranslation).toBeNull()
    } finally {
      verifyDb.close()
    }
  })
})
