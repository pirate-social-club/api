import type { Client } from "@libsql/client"

const COMMENT_COLUMNS = [
  "comment_id",
  "community_id",
  "thread_root_post_id",
  "parent_comment_id",
  "author_user_id",
  "identity_mode",
  "anonymous_scope",
  "anonymous_label",
  "body",
  "status",
  "depth",
  "direct_reply_count",
  "descendant_count",
  "upvote_count",
  "downvote_count",
  "score",
  "last_reply_at",
  "content_hash",
  "swarm_body_ref",
  "created_at",
  "updated_at",
  "source_language",
  "authorship_mode",
  "agent_id",
  "agent_ownership_record_id",
  "agent_display_name_snapshot",
  "agent_owner_handle_snapshot",
  "agent_ownership_provider_snapshot",
  "agent_handle_snapshot",
  "idempotency_key",
  "media_refs_json",
  "replies_locked",
  "replies_locked_at",
  "replies_locked_by_user_id",
  "replies_lock_reason",
] as const

async function commentsAuthorshipModeAllowsGuest(client: Client): Promise<boolean> {
  const result = await client.execute({
    sql: `
      SELECT sql
      FROM sqlite_schema
      WHERE type = 'table'
        AND name = 'comments'
      LIMIT 1
    `,
    args: [],
  })
  const createSql = String(result.rows[0]?.sql ?? "")
  return /authorship_mode[\s\S]*'guest'/.test(createSql)
}

export async function ensureRemoteCommentGuestAuthorship(client: Client): Promise<void> {
  if (await commentsAuthorshipModeAllowsGuest(client)) {
    return
  }

  await client.execute("PRAGMA foreign_keys = OFF")
  const tx = await client.transaction("write")
  try {
    await tx.execute("DROP TABLE IF EXISTS comments_guest_authorship_new")
    await tx.execute(`
      CREATE TABLE comments_guest_authorship_new (
        comment_id TEXT PRIMARY KEY,
        community_id TEXT NOT NULL,
        thread_root_post_id TEXT NOT NULL,
        parent_comment_id TEXT,
        author_user_id TEXT,
        identity_mode TEXT NOT NULL CHECK (
          identity_mode IN ('public', 'anonymous')
        ),
        anonymous_scope TEXT CHECK (
          anonymous_scope IS NULL OR anonymous_scope IN ('community_stable', 'thread_stable')
        ),
        anonymous_label TEXT,
        body TEXT NOT NULL,
        status TEXT NOT NULL CHECK (
          status IN ('published', 'hidden', 'removed', 'deleted')
        ),
        depth INTEGER NOT NULL,
        direct_reply_count INTEGER NOT NULL DEFAULT 0,
        descendant_count INTEGER NOT NULL DEFAULT 0,
        upvote_count INTEGER NOT NULL DEFAULT 0,
        downvote_count INTEGER NOT NULL DEFAULT 0,
        score INTEGER NOT NULL DEFAULT 0,
        last_reply_at TEXT,
        content_hash TEXT,
        swarm_body_ref TEXT,
        created_at TEXT NOT NULL,
        updated_at TEXT NOT NULL,
        source_language TEXT,
        authorship_mode TEXT NOT NULL DEFAULT 'human_direct' CHECK (
          authorship_mode IN ('human_direct', 'user_agent', 'guest')
        ),
        agent_id TEXT,
        agent_ownership_record_id TEXT,
        agent_display_name_snapshot TEXT,
        agent_owner_handle_snapshot TEXT,
        agent_ownership_provider_snapshot TEXT,
        agent_handle_snapshot TEXT,
        idempotency_key TEXT NOT NULL DEFAULT '',
        media_refs_json TEXT NOT NULL DEFAULT '[]',
        replies_locked INTEGER NOT NULL DEFAULT 0 CHECK (replies_locked IN (0, 1)),
        replies_locked_at TEXT,
        replies_locked_by_user_id TEXT,
        replies_lock_reason TEXT,
        FOREIGN KEY (community_id) REFERENCES communities(community_id),
        FOREIGN KEY (thread_root_post_id) REFERENCES posts(post_id),
        FOREIGN KEY (parent_comment_id) REFERENCES comments(comment_id)
      )
    `)
    await tx.execute(`
      INSERT INTO comments_guest_authorship_new (${COMMENT_COLUMNS.join(", ")})
      SELECT ${COMMENT_COLUMNS.join(", ")}
      FROM comments
    `)
    await tx.execute("DROP TABLE comments")
    await tx.execute("ALTER TABLE comments_guest_authorship_new RENAME TO comments")
    await tx.execute("CREATE INDEX idx_comments_thread_parent_created ON comments(thread_root_post_id, parent_comment_id, created_at)")
    await tx.execute("CREATE INDEX idx_comments_thread_status_created ON comments(thread_root_post_id, status, created_at)")
    await tx.execute("CREATE INDEX idx_comments_parent_created ON comments(parent_comment_id, created_at)")
    await tx.execute("CREATE INDEX idx_comments_author_created ON comments(author_user_id, created_at DESC)")
    await tx.execute("CREATE INDEX idx_comments_thread_source_language ON comments(thread_root_post_id, source_language, created_at DESC)")
    await tx.execute("CREATE INDEX idx_comments_agent_authorship ON comments(authorship_mode, agent_id, created_at DESC)")
    await tx.execute(`
      CREATE UNIQUE INDEX idx_comments_author_idempotency
      ON comments(community_id, author_user_id, idempotency_key)
      WHERE author_user_id IS NOT NULL AND idempotency_key <> ''
    `)
    await tx.commit()
  } catch (error) {
    try {
      await tx.rollback()
    } catch (rollbackError) {
      console.error("[community-db] rollback failed while enabling guest comment authorship", rollbackError)
    }
    throw error
  } finally {
    await client.execute("PRAGMA foreign_keys = ON")
  }
}
