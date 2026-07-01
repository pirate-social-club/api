import { describe, expect, test } from "bun:test"
import {
  agoraCloudRecordingConfigFromEnv,
  queryAgoraCloudRecording,
  startAgoraCloudRecording,
  stopAgoraCloudRecording,
} from "./agora-cloud-recording"

describe("agoraCloudRecordingConfigFromEnv", () => {
  test("returns null until every required Cloud Recording setting is present", () => {
    expect(agoraCloudRecordingConfigFromEnv({
      AGORA_APP_ID: "app",
      AGORA_CLOUD_RECORDING_CUSTOMER_ID: "id",
    })).toBeNull()
  })

  test("builds storage config from explicit Agora capture bucket settings", () => {
    const config = agoraCloudRecordingConfigFromEnv({
      AGORA_APP_ID: " app ",
      AGORA_CLOUD_RECORDING_BASE_URL: "https://agora.test/",
      AGORA_CLOUD_RECORDING_CUSTOMER_ID: " id ",
      AGORA_CLOUD_RECORDING_CUSTOMER_SECRET: " secret ",
      AGORA_CLOUD_RECORDING_STORAGE_VENDOR: "2",
      AGORA_CLOUD_RECORDING_STORAGE_REGION: "1",
      AGORA_CLOUD_RECORDING_STORAGE_BUCKET: "capture-bucket",
      AGORA_CLOUD_RECORDING_STORAGE_ACCESS_KEY: "capture-access",
      AGORA_CLOUD_RECORDING_STORAGE_SECRET_KEY: "capture-secret",
      AGORA_CLOUD_RECORDING_STORAGE_FILE_PREFIX: "pirate/live",
      AGORA_CLOUD_RECORDING_RESOURCE_EXPIRED_HOURS: "12",
    })

    expect(config).toEqual({
      appId: "app",
      baseUrl: "https://agora.test/",
      customerId: "id",
      customerSecret: "secret",
      resourceExpiredHour: 12,
      storageConfig: {
        vendor: 2,
        region: 1,
        bucket: "capture-bucket",
        accessKey: "capture-access",
        secretKey: "capture-secret",
        fileNamePrefix: ["pirate", "live"],
      },
    })
  })

  test("does not silently reuse the Filebase media bucket for Agora capture storage", () => {
    expect(agoraCloudRecordingConfigFromEnv({
      AGORA_APP_ID: "agora-app",
      AGORA_CLOUD_RECORDING_CUSTOMER_ID: "customer-id",
      AGORA_CLOUD_RECORDING_CUSTOMER_SECRET: "customer-secret",
      FILEBASE_MEDIA_BUCKET: "psc-media-bucket",
      FILEBASE_S3_ACCESS_KEY: "filebase-access",
      FILEBASE_S3_SECRET_KEY: "filebase-secret",
      FILEBASE_S3_ENDPOINT: "https://s3.filebase.com",
      FILEBASE_S3_REGION: "us-east-1",
    })).toBeNull()
  })

  test("requires the Agora Customer ID env name used by Agora's dashboard", () => {
    expect(agoraCloudRecordingConfigFromEnv({
      AGORA_APP_ID: "agora-app",
      AGORA_CLOUD_RECORDING_CUSTOMER_SECRET: "customer-secret",
      AGORA_CLOUD_RECORDING_STORAGE_ENDPOINT: "https://s3.filebase.com",
      AGORA_CLOUD_RECORDING_STORAGE_VENDOR: "11",
      AGORA_CLOUD_RECORDING_STORAGE_REGION: "0",
      AGORA_CLOUD_RECORDING_STORAGE_BUCKET: "capture-bucket",
      AGORA_CLOUD_RECORDING_STORAGE_ACCESS_KEY: "capture-access",
      AGORA_CLOUD_RECORDING_STORAGE_SECRET_KEY: "capture-secret",
    })).toBeNull()
  })
})

describe("Agora Cloud Recording REST adapter", () => {
  test("acquires then starts mixed cloud recording with Basic auth and configured storage", async () => {
    const requests: Array<{ url: string; init: RequestInit; body: Record<string, unknown> | null }> = []
    const fetcher = async (url: string | URL | Request, init?: RequestInit): Promise<Response> => {
      const body = typeof init?.body === "string" ? JSON.parse(init.body) as Record<string, unknown> : null
      requests.push({ url: String(url), init: init ?? {}, body })
      if (String(url).endsWith("/acquire")) {
        return Response.json({ resourceId: "resource-a" })
      }
      return Response.json({ resourceId: "resource-a", sid: "sid-a" })
    }

    const result = await startAgoraCloudRecording({
      config: requiredConfig(),
      recording: {
        cname: "pirate-live-lr_1",
        uid: "987654",
        token: "rtc-token",
      },
      fetcher: fetcher as typeof fetch,
    })

    expect(result).toEqual({ resourceId: "resource-a", sid: "sid-a" })
    expect(requests).toHaveLength(2)
    expect(requests[0]?.url).toBe("https://agora.test/v1/apps/agora-app/cloud_recording/acquire")
    expect(requests[1]?.url).toBe("https://agora.test/v1/apps/agora-app/cloud_recording/resourceid/resource-a/mode/mix/start")
    expect(requests[0]?.init.headers).toMatchObject({
      authorization: `Basic ${btoa("customer-id:customer-secret")}`,
      "content-type": "application/json",
    })
    expect(requests[0]?.body).toEqual({
      cname: "pirate-live-lr_1",
      uid: "987654",
      clientRequest: {
        resourceExpiredHour: 24,
        scene: 0,
      },
    })
    expect(requests[1]?.body).toMatchObject({
      cname: "pirate-live-lr_1",
      uid: "987654",
      clientRequest: {
        token: "rtc-token",
        storageConfig: {
          vendor: 2,
          region: 1,
          bucket: "capture-bucket",
          accessKey: "capture-access",
          secretKey: "capture-secret",
          fileNamePrefix: ["pirate", "live"],
        },
      },
    })
  })

  test("passes S3-compatible endpoint extension params to Agora", async () => {
    const requests: Array<{ body: Record<string, unknown> | null }> = []
    const fetcher = async (url: string | URL | Request, init?: RequestInit): Promise<Response> => {
      const body = typeof init?.body === "string" ? JSON.parse(init.body) as Record<string, unknown> : null
      requests.push({ body })
      if (String(url).endsWith("/acquire")) {
        return Response.json({ resourceId: "resource-a" })
      }
      return Response.json({ resourceId: "resource-a", sid: "sid-a" })
    }

    const config = agoraCloudRecordingConfigFromEnv({
      AGORA_APP_ID: "agora-app",
      AGORA_CLOUD_RECORDING_BASE_URL: "https://agora.test",
      AGORA_CLOUD_RECORDING_CUSTOMER_ID: "customer-id",
      AGORA_CLOUD_RECORDING_CUSTOMER_SECRET: "customer-secret",
      AGORA_CLOUD_RECORDING_STORAGE_ENDPOINT: "https://s3.filebase.com",
      AGORA_CLOUD_RECORDING_STORAGE_VENDOR: "11",
      AGORA_CLOUD_RECORDING_STORAGE_REGION: "0",
      AGORA_CLOUD_RECORDING_STORAGE_BUCKET: "capture-bucket",
      AGORA_CLOUD_RECORDING_STORAGE_ACCESS_KEY: "capture-access",
      AGORA_CLOUD_RECORDING_STORAGE_SECRET_KEY: "capture-secret",
    })
    if (!config) {
      throw new Error("expected test config")
    }

    await startAgoraCloudRecording({
      config,
      recording: {
        cname: "pirate-live-lr_1",
        uid: "987654",
        token: "rtc-token",
      },
      fetcher: fetcher as typeof fetch,
    })

    expect(requests[1]?.body).toMatchObject({
      clientRequest: {
        storageConfig: {
          vendor: 11,
          region: 0,
          bucket: "capture-bucket",
          accessKey: "capture-access",
          secretKey: "capture-secret",
          extensionParams: {
            endpoint: "https://s3.filebase.com",
          },
        },
      },
    })
  })

  test("stops and queries by resource id and sid", async () => {
    const urls: string[] = []
    const fetcher = async (url: string | URL | Request, init?: RequestInit): Promise<Response> => {
      urls.push(`${init?.method ?? "GET"} ${String(url)}`)
      return Response.json({ resourceId: "resource-a", sid: "sid-a", serverResponse: { fileListMode: "json" } })
    }

    await stopAgoraCloudRecording({
      config: requiredConfig(),
      cname: "pirate-live-lr_1",
      uid: "987654",
      resourceId: "resource-a",
      sid: "sid-a",
      fetcher: fetcher as typeof fetch,
    })
    await queryAgoraCloudRecording({
      config: requiredConfig(),
      resourceId: "resource-a",
      sid: "sid-a",
      fetcher: fetcher as typeof fetch,
    })

    expect(urls).toEqual([
      "POST https://agora.test/v1/apps/agora-app/cloud_recording/resourceid/resource-a/sid/sid-a/mode/mix/stop",
      "GET https://agora.test/v1/apps/agora-app/cloud_recording/resourceid/resource-a/sid/sid-a/mode/mix/query",
    ])
  })
})

function requiredConfig() {
  const config = agoraCloudRecordingConfigFromEnv({
    AGORA_APP_ID: "agora-app",
    AGORA_CLOUD_RECORDING_BASE_URL: "https://agora.test",
    AGORA_CLOUD_RECORDING_CUSTOMER_ID: "customer-id",
    AGORA_CLOUD_RECORDING_CUSTOMER_SECRET: "customer-secret",
    AGORA_CLOUD_RECORDING_STORAGE_VENDOR: "2",
    AGORA_CLOUD_RECORDING_STORAGE_REGION: "1",
    AGORA_CLOUD_RECORDING_STORAGE_BUCKET: "capture-bucket",
    AGORA_CLOUD_RECORDING_STORAGE_ACCESS_KEY: "capture-access",
    AGORA_CLOUD_RECORDING_STORAGE_SECRET_KEY: "capture-secret",
    AGORA_CLOUD_RECORDING_STORAGE_FILE_PREFIX: "pirate/live",
  })
  if (!config) {
    throw new Error("expected test config")
  }
  return config
}
