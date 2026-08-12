export const SONG_PREVIEW_PORT = 8795;
export const DEFAULT_MAX_BODY_BYTES = 64 * 1024;
export const DEFAULT_CONTAINER_INSTANCES = 1;
export const MAX_CONTAINER_INSTANCES = 20;

export type SongPreviewContainerEnv = {
  ENVIRONMENT?: string;
  SONG_PREVIEW_CONTAINER: DurableObjectNamespace;
  SONG_PREVIEW_CONTAINER_INSTANCES?: string;
  SONG_PREVIEW_MAX_BODY_BYTES?: string;
  SONG_PREVIEW_SHARED_SECRET?: string;
  SONG_PREVIEW_FFMPEG_BIN?: string;
  CONTROL_PLANE_DATABASE_URL?: string;
  FILEBASE_S3_ACCESS_KEY?: string;
  FILEBASE_S3_SECRET_KEY?: string;
  FILEBASE_S3_ENDPOINT?: string;
  FILEBASE_S3_REGION?: string;
  FILEBASE_MEDIA_BUCKET?: string;
  PIRATE_API_PUBLIC_ORIGIN?: string;
  IPFS_GATEWAY_URL?: string;
};

export type SongPreviewContainerProxy = (
  request: Request,
  env: SongPreviewContainerEnv,
) => Promise<Response>;

type JsonRecord = Record<string, unknown>;

function trimEnv(value: string | undefined): string {
  return value?.trim() ?? "";
}

function jsonResponse(body: JsonRecord, status = 200): Response {
  return new Response(JSON.stringify(body), {
    status,
    headers: {
      "content-type": "application/json; charset=utf-8",
    },
  });
}

function parsePositiveInteger(value: string | undefined, fallback: number): number {
  const parsed = Number(trimEnv(value));
  return Number.isInteger(parsed) && parsed > 0 ? parsed : fallback;
}

export function containerInstanceCount(env: SongPreviewContainerEnv): number {
  return Math.min(
    MAX_CONTAINER_INSTANCES,
    parsePositiveInteger(env.SONG_PREVIEW_CONTAINER_INSTANCES, DEFAULT_CONTAINER_INSTANCES),
  );
}

function songPreviewMaxBodyBytes(env: SongPreviewContainerEnv): number {
  return parsePositiveInteger(env.SONG_PREVIEW_MAX_BODY_BYTES, DEFAULT_MAX_BODY_BYTES);
}

function bearerToken(request: Request): string {
  const header = request.headers.get("authorization") ?? "";
  return header.startsWith("Bearer ") ? header.slice("Bearer ".length).trim() : "";
}

function constantTimeEqual(left: string, right: string): boolean {
  const encoder = new TextEncoder();
  const leftBytes = encoder.encode(left);
  const rightBytes = encoder.encode(right);
  let diff = leftBytes.length ^ rightBytes.length;
  const maxLength = Math.max(leftBytes.length, rightBytes.length);

  for (let index = 0; index < maxLength; index += 1) {
    diff |= (leftBytes[index] ?? 0) ^ (rightBytes[index] ?? 0);
  }

  return diff === 0;
}

function requireSongPreviewAuth(request: Request, env: SongPreviewContainerEnv): Response | null {
  const sharedSecret = trimEnv(env.SONG_PREVIEW_SHARED_SECRET);
  if (!sharedSecret) {
    return jsonResponse({
      code: "not_configured",
      message: "Song preview shared secret is not configured",
    }, 503);
  }

  if (!constantTimeEqual(bearerToken(request), sharedSecret)) {
    return jsonResponse({ code: "unauthorized", message: "Unauthorized" }, 401);
  }

  return null;
}

function rejectOversizedBody(request: Request, env: SongPreviewContainerEnv): Response | null {
  const contentLength = Number(request.headers.get("content-length") ?? "0");
  if (Number.isFinite(contentLength) && contentLength > songPreviewMaxBodyBytes(env)) {
    return jsonResponse({ code: "payload_too_large", message: "Request body is too large" }, 413);
  }
  return null;
}

function logWrapperEvent(event: string, details: JsonRecord): void {
  console.log(JSON.stringify({
    event,
    service: "song-preview-container",
    ...details,
  }));
}

function logWrapperWarning(event: string, details: JsonRecord): void {
  console.warn(JSON.stringify({
    event,
    service: "song-preview-container",
    ...details,
  }));
}

export function songPreviewContainerEnvVars(env: Partial<SongPreviewContainerEnv>): Record<string, string> {
  return {
    HOST: "0.0.0.0",
    SONG_PREVIEW_PORT: String(SONG_PREVIEW_PORT),
    SONG_PREVIEW_MAX_BODY_BYTES:
      trimEnv(env.SONG_PREVIEW_MAX_BODY_BYTES) || String(DEFAULT_MAX_BODY_BYTES),
    SONG_PREVIEW_SHARED_SECRET: trimEnv(env.SONG_PREVIEW_SHARED_SECRET),
    SONG_PREVIEW_FFMPEG_BIN: trimEnv(env.SONG_PREVIEW_FFMPEG_BIN) || "ffmpeg",
    CONTROL_PLANE_DATABASE_URL: trimEnv(env.CONTROL_PLANE_DATABASE_URL),
    FILEBASE_S3_ACCESS_KEY: trimEnv(env.FILEBASE_S3_ACCESS_KEY),
    FILEBASE_S3_SECRET_KEY: trimEnv(env.FILEBASE_S3_SECRET_KEY),
    FILEBASE_S3_ENDPOINT: trimEnv(env.FILEBASE_S3_ENDPOINT),
    FILEBASE_S3_REGION: trimEnv(env.FILEBASE_S3_REGION),
    FILEBASE_MEDIA_BUCKET: trimEnv(env.FILEBASE_MEDIA_BUCKET),
    PIRATE_API_PUBLIC_ORIGIN: trimEnv(env.PIRATE_API_PUBLIC_ORIGIN),
    IPFS_GATEWAY_URL: trimEnv(env.IPFS_GATEWAY_URL),
  };
}

export async function handleSongPreviewContainerRequest(
  request: Request,
  env: SongPreviewContainerEnv,
  proxyToSongPreviewContainer: SongPreviewContainerProxy,
): Promise<Response> {
  const url = new URL(request.url);

  if (url.pathname === "/health" && request.method === "GET") {
    return jsonResponse({
      ok: true,
      service: "song-preview-container",
      environment: env.ENVIRONMENT ?? "development",
    });
  }

  if (url.pathname === "/health/container" && request.method === "GET") {
    const authError = requireSongPreviewAuth(request, env);
    if (authError) return authError;
    return proxyToSongPreviewContainer(new Request(new URL("/health", request.url), request), env);
  }

  if (url.pathname === "/preview" || url.pathname === "/extract-audio-sample" || url.pathname === "/duration") {
    const routeEvent = url.pathname === "/preview"
      ? "song_preview.container.preview"
      : url.pathname === "/duration"
        ? "song_preview.container.duration"
        : "song_preview.container.extract_audio_sample";
    if (request.method !== "POST") {
      return jsonResponse({ code: "method_not_allowed", message: "Method not allowed" }, 405);
    }

    const startedAt = Date.now();
    const authError = requireSongPreviewAuth(request, env);
    if (authError) {
      logWrapperWarning(`${routeEvent}.rejected`, {
        reason: authError.status === 401 ? "unauthorized" : "not_configured",
        latency_ms: Date.now() - startedAt,
      });
      return authError;
    }

    const bodySizeError = rejectOversizedBody(request, env);
    if (bodySizeError) {
      logWrapperWarning(`${routeEvent}.rejected`, {
        reason: "payload_too_large",
        content_length: Number(request.headers.get("content-length") ?? "0"),
        latency_ms: Date.now() - startedAt,
      });
      return bodySizeError;
    }

    logWrapperEvent(`${routeEvent}.forwarded`, {
      environment: env.ENVIRONMENT ?? "development",
      container_instances: containerInstanceCount(env),
      content_length: Number(request.headers.get("content-length") ?? "0") || null,
    });
    return proxyToSongPreviewContainer(request, env);
  }

  return jsonResponse({ code: "not_found", message: "Not found" }, 404);
}
