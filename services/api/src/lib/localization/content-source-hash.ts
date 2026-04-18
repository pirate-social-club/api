import { sha256Hex } from "../crypto"
import type { Comment, Post } from "../../types"

function canonicalizeString(value: string | null | undefined): string | null {
  const trimmed = String(value ?? "").trim()
  return trimmed ? trimmed : null
}

export async function computePostSourceHash(post: Post): Promise<string> {
  const payload = {
    title: canonicalizeString(post.title),
    body: canonicalizeString(post.body),
    caption: canonicalizeString(post.caption),
  }

  return `0x${await sha256Hex(JSON.stringify(payload))}`
}

export async function computeCommentSourceHash(comment: Comment): Promise<string> {
  const payload = {
    body: canonicalizeString(comment.body),
  }

  return `0x${await sha256Hex(JSON.stringify(payload))}`
}
