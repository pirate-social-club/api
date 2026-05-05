import { internalError } from "../errors"
import type { Env } from "../../env"
import type { S3SigningConfig } from "./s3-signing"

function requireTrimmedEnv(value: string | undefined, message: string): string {
  const trimmed = String(value || "").trim()
  if (!trimmed) {
    throw internalError(message)
  }
  return trimmed
}

export function resolveFilebaseConfig(env: Env): S3SigningConfig {
  const endpointValue = String(env.FILEBASE_S3_ENDPOINT || "https://s3.filebase.com").trim()

  return {
    accessKey: requireTrimmedEnv(env.FILEBASE_S3_ACCESS_KEY, "FILEBASE_S3_ACCESS_KEY is not configured"),
    secretKey: requireTrimmedEnv(env.FILEBASE_S3_SECRET_KEY, "FILEBASE_S3_SECRET_KEY is not configured"),
    bucket: requireTrimmedEnv(env.FILEBASE_MEDIA_BUCKET, "FILEBASE_MEDIA_BUCKET is not configured"),
    endpoint: new URL(endpointValue),
    region: String(env.FILEBASE_S3_REGION || "us-east-1").trim() || "us-east-1",
  }
}
