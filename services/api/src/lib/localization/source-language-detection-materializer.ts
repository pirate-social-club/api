import type { Env } from "../../env"
import type { Comment, Post } from "../../types"
import type { DbExecutor } from "../db-helpers"
import { nowIso } from "../helpers"
import { computeCommentSourceHash, computePostSourceHash } from "./content-source-hash"
import { requestSourceLanguageDetection } from "./content-translation-provider"
import {
  updateCommentSourceLanguageFromProvider,
  updatePostSourceLanguageFromProvider,
} from "./source-language-canonical"

function hasPostText(post: Post): boolean {
  return Boolean(String(post.title ?? "").trim() || String(post.body ?? "").trim() || String(post.caption ?? "").trim())
}

function hasCommentText(comment: Pick<Comment, "status" | "body">): boolean {
  return comment.status === "published" && Boolean(String(comment.body ?? "").trim())
}

export async function materializePostSourceLanguageDetection(input: {
  executor: DbExecutor
  env: Env
  post: Post
}): Promise<string> {
  if (!hasPostText(input.post)) {
    return "skipped:no_content"
  }

  const sourceHash = await computePostSourceHash(input.post)
  if (input.post.source_language_reliable && input.post.source_language_source_hash === sourceHash) {
    return `cached:${input.post.source_language ?? "unknown"}`
  }

  const detection = await requestSourceLanguageDetection({
    env: input.env,
    sourceText: {
      title: input.post.title ?? null,
      body: input.post.body ?? null,
      caption: input.post.caption ?? null,
    },
  })

  await updatePostSourceLanguageFromProvider({
    executor: input.executor,
    postId: input.post.post_id,
    detection: {
      sourceLanguage: detection.sourceLanguage,
      sourceLanguageConfidence: detection.sourceLanguageConfidence,
      sourceLanguageReliable: detection.sourceLanguageReliable,
      detector: `${detection.provider}:${detection.model}`,
      detectedAt: nowIso(),
      sourceHash,
    },
  })

  return detection.sourceLanguage
    ? `detected:${detection.sourceLanguage}:${detection.sourceLanguageReliable ? "reliable" : "unreliable"}`
    : "detected:unknown"
}

export async function materializeCommentSourceLanguageDetection(input: {
  executor: DbExecutor
  env: Env
  comment: Comment
}): Promise<string> {
  if (!hasCommentText(input.comment)) {
    return "skipped:no_content"
  }

  const sourceHash = await computeCommentSourceHash(input.comment)
  if (input.comment.source_language_reliable && input.comment.source_language_source_hash === sourceHash) {
    return `cached:${input.comment.source_language ?? "unknown"}`
  }

  const detection = await requestSourceLanguageDetection({
    env: input.env,
    sourceText: {
      body: input.comment.body ?? null,
    },
  })

  await updateCommentSourceLanguageFromProvider({
    executor: input.executor,
    commentId: input.comment.comment_id,
    detection: {
      sourceLanguage: detection.sourceLanguage,
      sourceLanguageConfidence: detection.sourceLanguageConfidence,
      sourceLanguageReliable: detection.sourceLanguageReliable,
      detector: `${detection.provider}:${detection.model}`,
      detectedAt: nowIso(),
      sourceHash,
    },
  })

  return detection.sourceLanguage
    ? `detected:${detection.sourceLanguage}:${detection.sourceLanguageReliable ? "reliable" : "unreliable"}`
    : "detected:unknown"
}
