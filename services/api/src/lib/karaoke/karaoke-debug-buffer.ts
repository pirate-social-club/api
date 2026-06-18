/**
 * TEMPORARY in-isolate debug ring buffer for the karaoke scoring pipeline.
 *
 * `wrangler tail` does not reliably surface logs from the hibernatable-WebSocket
 * Durable Object path, so this buffer gives deterministic, admin-readable
 * observability instead. The DO, the ElevenLabs STT adapter, and the effect
 * runner all execute in the SAME DO isolate, so a module-level buffer keyed by
 * sessionId is shared across them. Exposed via an admin-gated GET on the DO.
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

const MAX_ENTRIES = 400;
const buffers = new Map<string, KaraokeDebugEntry[]>();
const frameStats = new Map<string, { count: number; bytes: number; firstT: number; lastT: number }>();
let seqCounter = 0;

function nowMs(): number {
  try {
    return Date.now();
  } catch {
    return 0;
  }
}

export function pushKaraokeDebug(
  sessionId: string | undefined,
  event: string,
  data?: Record<string, unknown>,
): void {
  const key = sessionId || "unknown";
  let buf = buffers.get(key);
  if (!buf) {
    buf = [];
    buffers.set(key, buf);
  }
  buf.push({ seq: seqCounter++, t: nowMs(), event, data });
  if (buf.length > MAX_ENTRIES) {
    buf.splice(0, buf.length - MAX_ENTRIES);
  }
  try {
    console.info("[karaoke-debug]", event, JSON.stringify(data ?? {}));
  } catch {
    // best-effort
  }
}

/** Aggregates high-frequency audio frames so they don't flush the ring buffer. */
export function noteKaraokeFrame(sessionId: string | undefined, bytes: number): void {
  const key = sessionId || "unknown";
  let stats = frameStats.get(key);
  if (!stats) {
    stats = { count: 0, bytes: 0, firstT: nowMs(), lastT: nowMs() };
    frameStats.set(key, stats);
    pushKaraokeDebug(sessionId, "audio_first_frame", { bytes });
  }
  stats.count += 1;
  stats.bytes += bytes;
  stats.lastT = nowMs();
}

export function readKaraokeDebug(sessionId: string): KaraokeDebugEntry[] {
  const entries = (buffers.get(sessionId) ?? []).slice();
  const stats = frameStats.get(sessionId);
  if (stats) {
    entries.push({
      seq: seqCounter,
      t: stats.lastT,
      event: "audio_frames_total",
      data: { count: stats.count, bytes: stats.bytes, firstT: stats.firstT, lastT: stats.lastT },
    });
  }
  return entries.sort((a, b) => a.seq - b.seq);
}
