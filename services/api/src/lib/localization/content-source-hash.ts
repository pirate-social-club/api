import { sha256Hex } from "../crypto"
import type { Comment, Post } from "../../types"

function canonicalizeString(value: string | null | undefined): string | null {
  const trimmed = String(value ?? "").trim()
  return trimmed ? trimmed : null
}

export async function computeTextSourceHash(value: string | null | undefined): Promise<string> {
  const payload = {
    body: canonicalizeString(value),
  }

  return `0x${await sha256Hex(JSON.stringify(payload))}`
}

export async function computePostSourceHash(post: Pick<Post, "title" | "body" | "caption">): Promise<string> {
  const payload = {
    title: canonicalizeString(post.title),
    body: canonicalizeString(post.body),
    caption: canonicalizeString(post.caption),
  }

  return `0x${await sha256Hex(JSON.stringify(payload))}`
}

export async function computeCommentSourceHash(comment: Pick<Comment, "body">): Promise<string> {
  return computeTextSourceHash(comment.body)
}
