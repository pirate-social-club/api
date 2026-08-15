import { Database } from "bun:sqlite"
import { describe, expect, test } from "bun:test"
import { createLearningDeckSession, rateLearningSessionItem, revealLearningSessionItem } from "./review-service"
import type { Client, InStatement, QueryResult, Transaction } from "../sql-client"

class SqliteClient implements Client {
  constructor(private readonly db: Database) {}

  execute(statement: InStatement | string): Promise<QueryResult> {
    const sql = typeof statement === "string" ? statement : statement.sql
    const args = typeof statement === "string" ? [] : statement.args ?? []
    const query = this.db.query(sql)
    const isRead = /^\s*(SELECT|WITH|PRAGMA)/iu.test(sql)
    if (isRead) return Promise.resolve({ rows: query.all(...args) as Record<string, unknown>[] })
    const result = query.run(...args)
    return Promise.resolve({ rows: [], rowsAffected: result.changes })
  }

  batch(statements: InStatement[]): Promise<QueryResult[]> {
    return Promise.all(statements.map((statement) => this.execute(statement)))
  }

  transaction(): Promise<Transaction> {
    this.db.exec("BEGIN IMMEDIATE")
    const client = this
    let closed = false
    return Promise.resolve({
      execute(statement: InStatement | string) { return client.execute(statement) },
      batch(statements: InStatement[]) { return client.batch(statements) },
      commit() { closed = true; client.db.exec("COMMIT"); return Promise.resolve() },
      rollback() { if (!closed) { closed = true; client.db.exec("ROLLBACK") }; return Promise.resolve() },
      close() { /* transaction lifecycle is closed by commit/rollback */ },
    })
  }

  close(): void { this.db.close() }
}

function seed(): SqliteClient {
  const db = new Database(":memory:")
  db.exec(`
    CREATE TABLE assets (asset_id TEXT PRIMARY KEY, asset_kind TEXT NOT NULL, access_mode TEXT NOT NULL);
    CREATE TABLE asset_enforcement (asset_id TEXT PRIMARY KEY, enforcement_state TEXT NOT NULL);
    CREATE TABLE purchase_entitlements (purchase_entitlement_id TEXT PRIMARY KEY, community_id TEXT NOT NULL, buyer_user_id TEXT NOT NULL, target_ref TEXT NOT NULL, entitlement_kind TEXT NOT NULL, status TEXT NOT NULL, granted_at TEXT NOT NULL, revoked_at TEXT, created_at TEXT NOT NULL, updated_at TEXT NOT NULL, purchase_id TEXT NOT NULL, buyer_kind TEXT NOT NULL, buyer_wallet_address TEXT, buyer_wallet_address_normalized TEXT, buyer_chain_ref TEXT);
    CREATE TABLE learning_decks (learning_deck_id TEXT PRIMARY KEY, community_id TEXT NOT NULL, creator_user_id TEXT NOT NULL, asset_id TEXT, status TEXT NOT NULL, published_version INTEGER);
    CREATE TABLE learning_deck_versions (learning_deck_version_id TEXT PRIMARY KEY, learning_deck_id TEXT NOT NULL, version INTEGER NOT NULL, status TEXT NOT NULL);
    CREATE TABLE learning_cards (learning_card_id TEXT PRIMARY KEY, learning_deck_id TEXT NOT NULL, retired_at TEXT);
    CREATE TABLE learning_card_versions (learning_deck_version_id TEXT NOT NULL, learning_card_id TEXT NOT NULL, ordinal INTEGER NOT NULL, card_type TEXT NOT NULL, prompt_json TEXT NOT NULL, answer_json TEXT NOT NULL, tags_json TEXT NOT NULL);
    CREATE TABLE learning_review_items (review_item_id TEXT PRIMARY KEY, item_kind TEXT NOT NULL, subject_ref TEXT NOT NULL, status TEXT NOT NULL);
    CREATE TABLE learning_review_events (learning_review_event_id TEXT PRIMARY KEY, user_id TEXT NOT NULL, review_item_id TEXT NOT NULL, learning_deck_id TEXT, learning_deck_version_id TEXT, learning_session_id TEXT, idempotency_key TEXT NOT NULL, item_event_sequence INTEGER NOT NULL, rating TEXT NOT NULL, reviewed_at TEXT NOT NULL, algorithm TEXT NOT NULL, parameters_version INTEGER NOT NULL, content_version INTEGER NOT NULL, prior_state_hash TEXT, resulting_state_json TEXT NOT NULL, created_at TEXT NOT NULL, UNIQUE(user_id, idempotency_key));
    CREATE TABLE learning_review_state (user_id TEXT NOT NULL, review_item_id TEXT NOT NULL, algorithm TEXT NOT NULL, parameters_version INTEGER NOT NULL, phase TEXT NOT NULL, stability REAL NOT NULL, difficulty REAL NOT NULL, learning_step INTEGER, scheduled_interval_days REAL NOT NULL, due_at TEXT NOT NULL, last_reviewed_at TEXT, reps INTEGER NOT NULL, lapses INTEGER NOT NULL, revision INTEGER NOT NULL, last_review_event_id TEXT NOT NULL, updated_at TEXT NOT NULL, PRIMARY KEY(user_id, review_item_id));
    CREATE TABLE learning_sessions (learning_session_id TEXT PRIMARY KEY, user_id TEXT NOT NULL, scope_kind TEXT NOT NULL, scope_ref TEXT NOT NULL, status TEXT NOT NULL, session_revision INTEGER NOT NULL, current_item_id TEXT, item_count INTEGER NOT NULL, reviewed_count INTEGER NOT NULL, expires_at TEXT NOT NULL, created_at TEXT NOT NULL, completed_at TEXT);
    CREATE TABLE learning_session_items (learning_session_id TEXT NOT NULL, review_item_id TEXT NOT NULL, ordinal INTEGER NOT NULL, due_at_snapshot TEXT, status TEXT NOT NULL, revealed_at TEXT, reviewed_event_id TEXT, PRIMARY KEY(learning_session_id, review_item_id));
    INSERT INTO assets VALUES ('ast_deck', 'learning_deck', 'locked');
    INSERT INTO asset_enforcement VALUES ('ast_deck', 'active');
    INSERT INTO learning_decks VALUES ('ldk_deck', 'com_demo', 'usr_creator', 'ast_deck', 'published', 1);
    INSERT INTO learning_deck_versions VALUES ('ldv_deck', 'ldk_deck', 1, 'published');
    INSERT INTO learning_cards VALUES ('lcd_card', 'ldk_deck', NULL);
    INSERT INTO learning_card_versions VALUES ('ldv_deck', 'lcd_card', 0, 'basic', '{"type":"text","text":"Prompt"}', '{"type":"text","text":"Answer"}', '[]');
    INSERT INTO learning_review_items VALUES ('lri_card', 'deck_card', 'lcd_card', 'active');
  `)
  return new SqliteClient(db)
}

describe("learning review service", () => {
  test("withholds answers, uses CAS revisions, and replays idempotent ratings", async () => {
    const client = seed()
    const session = await createLearningDeckSession({ client, communityId: "com_demo", deckId: "ldk_deck", userId: "usr_creator", nowMs: 1_700_000_000_000 })
    expect(session.current_item?.prompt).toBe("Prompt")
    expect(JSON.stringify(session)).not.toContain("Answer")
    const revealed = await revealLearningSessionItem({ client, communityId: "com_demo", sessionId: session.session_id, userId: "usr_creator", expectedSessionRevision: 1 })
    expect(revealed.answer).toBe("Answer")
    const rated = await rateLearningSessionItem({ client, communityId: "com_demo", sessionId: session.session_id, userId: "usr_creator", itemId: "lri_card", rating: "good", idempotencyKey: "review-1", expectedSessionRevision: 2, reviewedAtMs: 1_700_000_000_000 })
    expect(rated.replayed).toBe(false)
    const replay = await rateLearningSessionItem({ client, communityId: "com_demo", sessionId: session.session_id, userId: "usr_creator", itemId: "lri_card", rating: "good", idempotencyKey: "review-1", expectedSessionRevision: 2, reviewedAtMs: 1_700_000_000_000 })
    expect(replay.replayed).toBe(true)
    expect(replay.rating).toBe("good")
    client.close()
  })
})
