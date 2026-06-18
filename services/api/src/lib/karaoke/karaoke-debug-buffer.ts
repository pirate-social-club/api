/**
 * TEMPORARY SQLite-backed debug trace for the karaoke scoring pipeline.
 *
 * `wrangler tail` cannot observe the hibernatable-WebSocket Durable Object path,
 * and an in-memory buffer does not survive WS-hibernation eviction (a fresh
 * isolate wakes empty). So the trace is persisted in the DO's own SQLite storage
 * (synchronous `ctx.storage.sql`), shared across the DO + STT adapter + effect
 * runner (same isolate), and exposed via an admin-gated GET on the DO.
 *
 * Remove once the live-scoring path is verified. Stores NO tokens, NO raw audio,
 * and NO full transcripts — text length / word count only.
 */
export interface KaraokeDebugEntry {
  seq: number;
  t: number;
  event: string;
  data?: Record<string, unknown>;
}

type SqlExec = (query: string, ...bindings: unknown[]) => { toArray(): Array<Record<string, unknown>> };

let sql: SqlExec | null = null;
let initialized = false;
let lastError: string | null = null;

export function getKaraokeDebugStatus(): { registered: boolean; initialized: boolean; lastError: string | null } {
  return { registered: sql !== null, initialized, lastError };
}

function nowMs(): number {
  try {
    return Date.now();
  } catch {
    return 0;
  }
}

/** Called by the DO (which owns ctx.storage.sql) before any push can occur. */
export function registerKaraokeDebugSql(exec: SqlExec): void {
  sql = exec;
  if (initialized) return;
  try {
    sql(`CREATE TABLE IF NOT EXISTS __karaoke_debug (seq INTEGER PRIMARY KEY, t INTEGER, session_id TEXT, event TEXT, data TEXT)`);
    sql(`CREATE TABLE IF NOT EXISTS __karaoke_debug_frames (session_id TEXT PRIMARY KEY, count INTEGER, bytes INTEGER, first_t INTEGER, last_t INTEGER)`);
    initialized = true;
  } catch (error) {
    lastError = `register: ${error instanceof Error ? error.message : String(error)}`;
  }
}

export function pushKaraokeDebug(
  sessionId: string | undefined,
  event: string,
  data?: Record<string, unknown>,
): void {
  const key = sessionId || "unknown";
  try {
    sql?.(`INSERT INTO __karaoke_debug (t, session_id, event, data) VALUES (?, ?, ?, ?)`, nowMs(), key, event, JSON.stringify(data ?? {}));
  } catch (error) {
    lastError = `push(${event}): ${error instanceof Error ? error.message : String(error)}`;
  }
  try {
    console.info("[karaoke-debug]", event, JSON.stringify(data ?? {}));
  } catch {
    // best-effort
  }
}

/** Aggregates high-frequency audio frames into one row so they don't flood the table. */
export function noteKaraokeFrame(sessionId: string | undefined, bytes: number): void {
  const key = sessionId || "unknown";
  try {
    const existing = sql?.(`SELECT count FROM __karaoke_debug_frames WHERE session_id = ?`, key).toArray() ?? [];
    if (existing.length === 0) {
      pushKaraokeDebug(sessionId, "audio_first_frame", { bytes });
      sql?.(`INSERT INTO __karaoke_debug_frames (session_id, count, bytes, first_t, last_t) VALUES (?, 1, ?, ?, ?)`, key, bytes, nowMs(), nowMs());
    } else {
      sql?.(`UPDATE __karaoke_debug_frames SET count = count + 1, bytes = bytes + ?, last_t = ? WHERE session_id = ?`, bytes, nowMs(), key);
    }
  } catch {
    // best-effort
  }
}

/** Diagnostic: every row across all session keys (to detect mis-keyed pushes). */
export function readAllKaraokeDebug(): Array<{ seq: number; t: number; session_id: string; event: string; data: string }> {
  try {
    return (sql?.(`SELECT seq, t, session_id, event, data FROM __karaoke_debug ORDER BY seq`).toArray() ?? []) as Array<{ seq: number; t: number; session_id: string; event: string; data: string }>;
  } catch {
    return [];
  }
}

export function readKaraokeDebug(sessionId: string): KaraokeDebugEntry[] {
  const out: KaraokeDebugEntry[] = [];
  try {
    const rows = (sql?.(
      `SELECT seq, t, event, data FROM __karaoke_debug WHERE session_id = ? ORDER BY seq`,
      sessionId,
    ).toArray() ?? []) as Array<{ seq: number; t: number; event: string; data: string }>;
    for (const r of rows) {
      let data: Record<string, unknown> | undefined;
      try {
        data = r.data ? JSON.parse(r.data) : undefined;
      } catch {
        data = { raw: r.data };
      }
      out.push({ seq: r.seq, t: r.t, event: r.event, data });
    }
    const frames = (sql?.(
      `SELECT count, bytes, first_t, last_t FROM __karaoke_debug_frames WHERE session_id = ?`,
      sessionId,
    ).toArray() ?? []) as Array<{ count: number; bytes: number; first_t: number; last_t: number }>;
    if (frames.length > 0) {
      out.push({ seq: Number.MAX_SAFE_INTEGER, t: frames[0].last_t, event: "audio_frames_total", data: { ...frames[0] } });
    }
  } catch {
    // best-effort
  }
  return out;
}
