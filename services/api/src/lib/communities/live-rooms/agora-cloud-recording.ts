import type { Env } from "../../../env"

export type AgoraCloudRecordingConfig = {
  appId: string
  customerKey: string
  customerSecret: string
  baseUrl: string
  storageConfig: {
    vendor: number
    region: number
    bucket: string
    accessKey: string
    secretKey: string
    fileNamePrefix?: string[]
  }
  resourceExpiredHour: number
}

export type AgoraCloudRecordingStartInput = {
  cname: string
  uid: string
  token: string
}

export type AgoraCloudRecordingStartResult = {
  resourceId: string
  sid: string
}

export type AgoraCloudRecordingStopResult = {
  resourceId: string
  sid: string
  serverResponse: Record<string, unknown> | null
}

type Fetcher = typeof fetch

const DEFAULT_BASE_URL = "https://api.agora.io"
const DEFAULT_RESOURCE_EXPIRED_HOURS = 24

export function agoraCloudRecordingConfigFromEnv(env: Env): AgoraCloudRecordingConfig | null {
  const appId = firstTrimmed(env.AGORA_APP_ID)
  const customerKey = firstTrimmed(env.AGORA_CLOUD_RECORDING_CUSTOMER_KEY)
  const customerSecret = firstTrimmed(env.AGORA_CLOUD_RECORDING_CUSTOMER_SECRET)
  const vendor = positiveIntegerOrNull(env.AGORA_CLOUD_RECORDING_STORAGE_VENDOR)
  const region = positiveIntegerOrNull(env.AGORA_CLOUD_RECORDING_STORAGE_REGION)
  const bucket = firstTrimmed(env.AGORA_CLOUD_RECORDING_STORAGE_BUCKET)
  const accessKey = firstTrimmed(env.AGORA_CLOUD_RECORDING_STORAGE_ACCESS_KEY)
  const secretKey = firstTrimmed(env.AGORA_CLOUD_RECORDING_STORAGE_SECRET_KEY)
  if (!appId || !customerKey || !customerSecret || vendor == null || region == null || !bucket || !accessKey || !secretKey) {
    return null
  }
  return {
    appId,
    customerKey,
    customerSecret,
    baseUrl: firstTrimmed(env.AGORA_CLOUD_RECORDING_BASE_URL) ?? DEFAULT_BASE_URL,
    storageConfig: {
      vendor,
      region,
      bucket,
      accessKey,
      secretKey,
      fileNamePrefix: fileNamePrefixFromEnv(env.AGORA_CLOUD_RECORDING_STORAGE_FILE_PREFIX),
    },
    resourceExpiredHour: positiveIntegerOrNull(env.AGORA_CLOUD_RECORDING_RESOURCE_EXPIRED_HOURS) ?? DEFAULT_RESOURCE_EXPIRED_HOURS,
  }
}

export function isAgoraCloudRecordingConfigured(env: Env): boolean {
  return agoraCloudRecordingConfigFromEnv(env) !== null
}

export async function startAgoraCloudRecording(input: {
  config: AgoraCloudRecordingConfig
  recording: AgoraCloudRecordingStartInput
  fetcher?: Fetcher
}): Promise<AgoraCloudRecordingStartResult> {
  const fetcher = input.fetcher ?? fetch
  const resource = await agoraRecordingRequest<{ resourceId?: unknown }>({
    config: input.config,
    fetcher,
    path: `/v1/apps/${encodeURIComponent(input.config.appId)}/cloud_recording/acquire`,
    method: "POST",
    body: {
      cname: input.recording.cname,
      uid: input.recording.uid,
      clientRequest: {
        resourceExpiredHour: input.config.resourceExpiredHour,
        scene: 0,
      },
    },
  })
  const resourceId = stringOrNull(resource.resourceId)
  if (!resourceId) {
    throw new Error("Agora Cloud Recording acquire returned no resourceId")
  }

  const started = await agoraRecordingRequest<{ sid?: unknown; resourceId?: unknown }>({
    config: input.config,
    fetcher,
    path: `/v1/apps/${encodeURIComponent(input.config.appId)}/cloud_recording/resourceid/${encodeURIComponent(resourceId)}/mode/mix/start`,
    method: "POST",
    body: {
      cname: input.recording.cname,
      uid: input.recording.uid,
      clientRequest: {
        token: input.recording.token,
        recordingConfig: {
          channelType: 0,
          streamTypes: 2,
          audioProfile: 1,
          videoStreamType: 0,
          maxIdleTime: 30,
          subscribeUidGroup: 0,
        },
        recordingFileConfig: {
          avFileType: ["hls", "mp4"],
        },
        storageConfig: input.config.storageConfig,
      },
    },
  })
  const sid = stringOrNull(started.sid)
  if (!sid) {
    throw new Error("Agora Cloud Recording start returned no sid")
  }
  return {
    resourceId: stringOrNull(started.resourceId) ?? resourceId,
    sid,
  }
}

export async function stopAgoraCloudRecording(input: {
  config: AgoraCloudRecordingConfig
  cname: string
  uid: string
  resourceId: string
  sid: string
  fetcher?: Fetcher
}): Promise<AgoraCloudRecordingStopResult> {
  const response = await agoraRecordingRequest<Record<string, unknown>>({
    config: input.config,
    fetcher: input.fetcher ?? fetch,
    path: `/v1/apps/${encodeURIComponent(input.config.appId)}/cloud_recording/resourceid/${encodeURIComponent(input.resourceId)}/sid/${encodeURIComponent(input.sid)}/mode/mix/stop`,
    method: "POST",
    body: {
      cname: input.cname,
      uid: input.uid,
      clientRequest: {},
    },
  })
  return {
    resourceId: stringOrNull(response.resourceId) ?? input.resourceId,
    sid: stringOrNull(response.sid) ?? input.sid,
    serverResponse: response,
  }
}

export async function queryAgoraCloudRecording(input: {
  config: AgoraCloudRecordingConfig
  resourceId: string
  sid: string
  fetcher?: Fetcher
}): Promise<Record<string, unknown>> {
  return await agoraRecordingRequest<Record<string, unknown>>({
    config: input.config,
    fetcher: input.fetcher ?? fetch,
    path: `/v1/apps/${encodeURIComponent(input.config.appId)}/cloud_recording/resourceid/${encodeURIComponent(input.resourceId)}/sid/${encodeURIComponent(input.sid)}/mode/mix/query`,
    method: "GET",
  })
}

async function agoraRecordingRequest<T>(input: {
  config: AgoraCloudRecordingConfig
  fetcher: Fetcher
  path: string
  method: "GET" | "POST"
  body?: Record<string, unknown>
}): Promise<T> {
  const response = await input.fetcher(`${input.config.baseUrl.replace(/\/+$/, "")}${input.path}`, {
    method: input.method,
    headers: {
      authorization: `Basic ${basicAuth(input.config.customerKey, input.config.customerSecret)}`,
      ...(input.body ? { "content-type": "application/json" } : {}),
    },
    body: input.body ? JSON.stringify(input.body) : undefined,
  })
  const parsed = await response.json().catch(() => null)
  if (!response.ok) {
    const detail = parsed && typeof parsed === "object" && "message" in parsed ? String(parsed.message) : `HTTP ${response.status}`
    throw new Error(`Agora Cloud Recording request failed: ${detail}`)
  }
  if (!parsed || typeof parsed !== "object") {
    throw new Error("Agora Cloud Recording returned an invalid response")
  }
  return parsed as T
}

function basicAuth(username: string, password: string): string {
  return btoa(`${username}:${password}`)
}

function firstTrimmed(value: string | undefined): string | null {
  const trimmed = value?.trim()
  return trimmed ? trimmed : null
}

function positiveIntegerOrNull(value: string | undefined): number | null {
  const trimmed = firstTrimmed(value)
  if (!trimmed) {
    return null
  }
  const parsed = Number(trimmed)
  if (!Number.isInteger(parsed) || parsed <= 0) {
    return null
  }
  return parsed
}

function fileNamePrefixFromEnv(value: string | undefined): string[] | undefined {
  const trimmed = firstTrimmed(value)
  if (!trimmed) {
    return undefined
  }
  const parts = trimmed.split("/").map((part) => part.trim()).filter(Boolean)
  return parts.length > 0 ? parts : undefined
}

function stringOrNull(value: unknown): string | null {
  return typeof value === "string" && value.trim() ? value : null
}
