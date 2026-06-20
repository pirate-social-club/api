import { afterEach, describe, expect, spyOn, test } from "bun:test";
import {
  containerInstanceCount,
  DEFAULT_MAX_BODY_BYTES,
  handleSongPreviewContainerRequest,
  MAX_CONTAINER_INSTANCES,
  songPreviewContainerEnvVars,
  type SongPreviewContainerEnv,
  type SongPreviewContainerProxy,
} from "./handler";

type ProxyCall = {
  method: string;
  path: string;
  body: string;
};

function testEnv(overrides: Partial<SongPreviewContainerEnv> = {}): SongPreviewContainerEnv {
  return {
    ENVIRONMENT: "test",
    SONG_PREVIEW_CONTAINER: {} as DurableObjectNamespace,
    SONG_PREVIEW_SHARED_SECRET: "shared-secret",
    ...overrides,
  };
}

async function responseJson(response: Response): Promise<Record<string, unknown>> {
  return await response.json();
}

function recordingProxy(calls: ProxyCall[] = []): SongPreviewContainerProxy {
  return async (request) => {
    const url = new URL(request.url);
    calls.push({
      method: request.method,
      path: url.pathname,
      body: await request.text(),
    });
    return Response.json({ ok: true, proxied_path: url.pathname });
  };
}

afterEach(() => {
  spyOn(console, "log").mockRestore();
  spyOn(console, "warn").mockRestore();
});

describe("song preview container handler", () => {
  test("returns wrapper health without starting a container", async () => {
    const calls: ProxyCall[] = [];
    const response = await handleSongPreviewContainerRequest(
      new Request("https://preview.example/health"),
      testEnv(),
      recordingProxy(calls),
    );

    expect(response.status).toBe(200);
    expect(await responseJson(response)).toEqual({
      ok: true,
      service: "song-preview-container",
      environment: "test",
    });
    expect(calls).toHaveLength(0);
  });

  test("requires a configured shared secret before proxying private routes", async () => {
    spyOn(console, "warn").mockImplementation(() => undefined);
    const calls: ProxyCall[] = [];
    const response = await handleSongPreviewContainerRequest(
      new Request("https://preview.example/preview", { method: "POST" }),
      testEnv({ SONG_PREVIEW_SHARED_SECRET: "" }),
      recordingProxy(calls),
    );

    expect(response.status).toBe(503);
    expect(await responseJson(response)).toMatchObject({ code: "not_configured" });
    expect(calls).toHaveLength(0);
  });

  test("rejects wrong bearer token before proxying preview generation", async () => {
    spyOn(console, "warn").mockImplementation(() => undefined);
    const calls: ProxyCall[] = [];
    const response = await handleSongPreviewContainerRequest(
      new Request("https://preview.example/preview", {
        method: "POST",
        headers: { authorization: "Bearer wrong" },
      }),
      testEnv(),
      recordingProxy(calls),
    );

    expect(response.status).toBe(401);
    expect(await responseJson(response)).toEqual({ code: "unauthorized", message: "Unauthorized" });
    expect(calls).toHaveLength(0);
  });

  test("rejects oversized preview requests before proxying", async () => {
    spyOn(console, "warn").mockImplementation(() => undefined);
    const calls: ProxyCall[] = [];
    const response = await handleSongPreviewContainerRequest(
      new Request("https://preview.example/preview", {
        method: "POST",
        headers: {
          authorization: "Bearer shared-secret",
          "content-length": "11",
        },
      }),
      testEnv({ SONG_PREVIEW_MAX_BODY_BYTES: "10" }),
      recordingProxy(calls),
    );

    expect(response.status).toBe(413);
    expect(await responseJson(response)).toEqual({
      code: "payload_too_large",
      message: "Request body is too large",
    });
    expect(calls).toHaveLength(0);
  });

  test("forwards authenticated preview requests to the container", async () => {
    spyOn(console, "log").mockImplementation(() => undefined);
    const calls: ProxyCall[] = [];
    const response = await handleSongPreviewContainerRequest(
      new Request("https://preview.example/preview", {
        method: "POST",
        headers: {
          authorization: "Bearer shared-secret",
          "content-length": "83",
        },
        body: JSON.stringify({
          community_id: "com_test",
          song_artifact_bundle: "sab_test",
          primary_audio_content_hash: "0xabc",
        }),
      }),
      testEnv({ SONG_PREVIEW_CONTAINER_INSTANCES: "2" }),
      recordingProxy(calls),
    );

    expect(response.status).toBe(200);
    expect(await responseJson(response)).toEqual({ ok: true, proxied_path: "/preview" });
    expect(calls).toEqual([{
      method: "POST",
      path: "/preview",
      body: "{\"community_id\":\"com_test\",\"song_artifact_bundle\":\"sab_test\",\"primary_audio_content_hash\":\"0xabc\"}",
    }]);
  });

  test("forwards authenticated deep health checks as container /health", async () => {
    const calls: ProxyCall[] = [];
    const response = await handleSongPreviewContainerRequest(
      new Request("https://preview.example/health/container", {
        headers: { authorization: "Bearer shared-secret" },
      }),
      testEnv(),
      recordingProxy(calls),
    );

    expect(response.status).toBe(200);
    expect(await responseJson(response)).toEqual({ ok: true, proxied_path: "/health" });
    expect(calls).toEqual([{ method: "GET", path: "/health", body: "" }]);
  });

  test("rejects unsupported preview methods", async () => {
    const response = await handleSongPreviewContainerRequest(
      new Request("https://preview.example/preview"),
      testEnv(),
      recordingProxy(),
    );

    expect(response.status).toBe(405);
    expect(await responseJson(response)).toEqual({
      code: "method_not_allowed",
      message: "Method not allowed",
    });
  });

  test("normalizes runtime options for the container", () => {
    expect(containerInstanceCount(testEnv({ SONG_PREVIEW_CONTAINER_INSTANCES: "0" }))).toBe(1);
    expect(containerInstanceCount(testEnv({ SONG_PREVIEW_CONTAINER_INSTANCES: "999" }))).toBe(
      MAX_CONTAINER_INSTANCES,
    );
    expect(songPreviewContainerEnvVars({
      SONG_PREVIEW_SHARED_SECRET: "  secret  ",
      CONTROL_PLANE_DATABASE_URL: "  postgres://control-plane  ",
      FILEBASE_S3_ACCESS_KEY: "  access-key  ",
      FILEBASE_S3_SECRET_KEY: "  secret-key  ",
      FILEBASE_S3_ENDPOINT: "  https://s3.filebase.com  ",
      FILEBASE_S3_REGION: "  us-east-1  ",
      FILEBASE_MEDIA_BUCKET: "  media  ",
      PIRATE_API_PUBLIC_ORIGIN: "  https://api.example  ",
      IPFS_GATEWAY_URL: "  https://gateway.example/ipfs  ",
    })).toEqual({
      HOST: "0.0.0.0",
      SONG_PREVIEW_PORT: "8795",
      SONG_PREVIEW_MAX_BODY_BYTES: String(DEFAULT_MAX_BODY_BYTES),
      SONG_PREVIEW_SHARED_SECRET: "secret",
      SONG_PREVIEW_FFMPEG_BIN: "ffmpeg",
      CONTROL_PLANE_DATABASE_URL: "postgres://control-plane",
      FILEBASE_S3_ACCESS_KEY: "access-key",
      FILEBASE_S3_SECRET_KEY: "secret-key",
      FILEBASE_S3_ENDPOINT: "https://s3.filebase.com",
      FILEBASE_S3_REGION: "us-east-1",
      FILEBASE_MEDIA_BUCKET: "media",
      PIRATE_API_PUBLIC_ORIGIN: "https://api.example",
      IPFS_GATEWAY_URL: "https://gateway.example/ipfs",
    });
  });
});
