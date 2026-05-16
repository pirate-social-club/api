import { executeFirst } from "../db-helpers"
import type { DbExecutor } from "../db-helpers"
import { POST_SELECT_COLUMNS } from "./community-post-projection"
import {
  serializePost,
  toPostRow,
} from "./community-post-serialization"
import type { Post } from "../../types"

export async function getPostById(client: DbExecutor, postId: string): Promise<Post | null> {
  const row = await executeFirst(client, {
    sql: `
      SELECT ${POST_SELECT_COLUMNS}
      FROM posts
      WHERE post_id = ?1
      LIMIT 1
    `,
    args: [postId],
  })

  return row ? serializePost(toPostRow(row)) : null
}
