import type { Env } from "../../env"
import { notFoundError, providerUnavailable } from "../errors"
import { resolveFilebaseConfig } from "./filebase-config"
import { buildS3PresignedUrl, buildS3SignedRequest, type S3SigningConfig } from "./s3-signing"

const encoder = new TextEncoder()
const FILEBASE_REQUEST_TIMEOUT_MS = 30_000
const FILEBASE_MULTIPART_COMPLETE_TIMEOUT_MS = 120_000

type FilebaseRequestConfig = {
  env: Env
  config?: S3SigningConfig
}

function requestConfig(input: FilebaseRequestConfig): S3SigningConfig {
  return input.config ?? resolveFilebaseConfig(input.env)
}

export type CompletedMultipartPart = {
  partNumber: number
  etag: string
}

export type ListedMultipartPart = CompletedMultipartPart & {
  size: number
}

function extractXmlValue(xml: string, tag: string): string | null {
  const match = xml.match(new RegExp(`<${tag}>([^<]*)</${tag}>`))
  return match?.[1]?.trim() || null
}

function extractXmlBlocks(xml: string, tag: string): string[] {
  return [...xml.matchAll(new RegExp(`<${tag}>([\\s\\S]*?)</${tag}>`, "g"))].map((match) => match[1] ?? "")
}

function xmlEscape(value: string): string {
  return value
    .replace(/&/g, "&amp;")
    .replace(/</g, "&lt;")
    .replace(/>/g, "&gt;")
}

function decodeXmlEntities(value: string): string {
  return value
    .replace(/&quot;/g, "\"")
    .replace(/&#34;/g, "\"")
    .replace(/&apos;/g, "'")
    .replace(/&#39;/g, "'")
    .replace(/&lt;/g, "<")
    .replace(/&gt;/g, ">")
    .replace(/&amp;/g, "&")
}

function parseRequiredInteger(value: string | null, label: string): number {
  if (!value?.trim()) {
    throw providerUnavailable(`Filebase multipart response did not include ${label}`)
  }
  const parsed = Number(value)
  if (!Number.isSafeInteger(parsed) || parsed < 0) {
    throw providerUnavailable(`Filebase multipart response included an invalid ${label}`)
  }
  return parsed
}

async function providerResponseText(response: Response): Promise<string> {
  return await response.text().catch(() => "")
}

function providerErrorMessage(label: string, response: Response, responseText: string): string {
  return `${label} failed with status ${response.status}${responseText ? `: ${responseText}` : ""}`
}

async function requireProviderOk(response: Response, label: string): Promise<string> {
  const responseText = await providerResponseText(response)
  if (!response.ok) {
    throw providerUnavailable(providerErrorMessage(label, response, responseText))
  }
  return responseText
}

export async function fetchFilebaseWithTimeout(
  request: Request,
  label: string,
  timeoutMs = FILEBASE_REQUEST_TIMEOUT_MS,
): Promise<Response> {
  const controller = new AbortController()
  const timeout = setTimeout(() => controller.abort(), timeoutMs)
  try {
    return await fetch(request, { signal: controller.signal })
  } catch (error) {
    const message = error instanceof Error ? error.message : String(error)
    const reason = error instanceof Error && error.name === "AbortError" ? "timed out" : "failed"
    throw providerUnavailable(`${label} ${reason}: ${message}`)
  } finally {
    clearTimeout(timeout)
  }
}

export async function createMultipartUpload(input: {
  env: Env
  objectKey: string
  mimeType: string
}): Promise<{ uploadId: string }> {
  const response = await fetchFilebaseWithTimeout(await buildS3SignedRequest({
    method: "POST",
    config: resolveFilebaseConfig(input.env),
    objectKey: input.objectKey,
    query: { uploads: "" },
    bodyHashMode: "empty",
    headers: {
      "content-type": input.mimeType.trim().toLowerCase(),
    },
  }), "Filebase multipart init")
  const xml = await requireProviderOk(response, "Filebase multipart init")
  const uploadId = extractXmlValue(xml, "UploadId")
  if (!uploadId) {
    throw providerUnavailable("Filebase multipart init did not return an UploadId")
  }
  return { uploadId }
}

export async function headObject(input: {
  env: Env
  config?: S3SigningConfig
  objectKey: string
}): Promise<{
  contentLength: number
  contentType: string | null
  etag: string | null
  cid: string | null
}> {
  const response = await fetchFilebaseWithTimeout(await buildS3SignedRequest({
    method: "HEAD",
    config: requestConfig(input),
    objectKey: input.objectKey,
    bodyHashMode: "empty",
  }), "Filebase object HEAD")
  if (response.status === 404) {
    throw notFoundError("Object not found")
  }
  if (!response.ok) {
    throw providerUnavailable(providerErrorMessage("Filebase object HEAD", response, await providerResponseText(response)))
  }
  return {
    contentLength: parseRequiredInteger(response.headers.get("content-length"), "Content-Length"),
    contentType: response.headers.get("content-type")?.trim() || null,
    etag: response.headers.get("etag")?.trim() || null,
    cid: response.headers.get("x-amz-meta-cid")?.trim() || null,
  }
}

export async function completeMultipartUpload(input: {
  env: Env
  config?: S3SigningConfig
  objectKey: string
  uploadId: string
  parts: ReadonlyArray<CompletedMultipartPart>
}): Promise<{ etag: string; cid: string }> {
  const partsXml = input.parts
    .map((part) => [
      "<Part>",
      `<PartNumber>${part.partNumber}</PartNumber>`,
      `<ETag>${xmlEscape(part.etag)}</ETag>`,
      "</Part>",
    ].join(""))
    .join("")
  const body = encoder.encode(`<CompleteMultipartUpload>${partsXml}</CompleteMultipartUpload>`)
  const response = await fetchFilebaseWithTimeout(await buildS3SignedRequest({
    method: "POST",
    config: requestConfig(input),
    objectKey: input.objectKey,
    query: { uploadId: input.uploadId },
    headers: {
      "content-type": "application/xml",
    },
    body,
  }), "Filebase multipart complete", FILEBASE_MULTIPART_COMPLETE_TIMEOUT_MS)
  const xml = await requireProviderOk(response, "Filebase multipart complete")
  const etag = extractXmlValue(xml, "ETag")
  const cid = extractXmlValue(xml, "CID")
  if (!etag) {
    throw providerUnavailable("Filebase multipart complete did not return an ETag")
  }
  if (!cid) {
    throw providerUnavailable("Filebase multipart complete did not return an IPFS CID")
  }
  return {
    etag: decodeXmlEntities(etag),
    cid: decodeXmlEntities(cid),
  }
}

export async function abortMultipartUpload(input: {
  env: Env
  config?: S3SigningConfig
  objectKey: string
  uploadId: string
}): Promise<void> {
  let response: Response
  try {
    response = await fetchFilebaseWithTimeout(await buildS3SignedRequest({
      method: "DELETE",
      config: requestConfig(input),
      objectKey: input.objectKey,
      query: { uploadId: input.uploadId },
      bodyHashMode: "empty",
    }), "Filebase multipart abort")
  } catch (error) {
    console.warn("Filebase multipart abort failed", {
      message: error instanceof Error ? error.message : String(error),
    })
    return
  }
  if (response.ok || response.status === 404) {
    return
  }
  console.warn("Filebase multipart abort failed", {
    status: response.status,
    body: (await providerResponseText(response)).slice(0, 500),
  })
}

export async function listParts(input: {
  env: Env
  config?: S3SigningConfig
  objectKey: string
  uploadId: string
  partNumberMarker?: number | null
  maxParts?: number | null
}): Promise<{
  parts: ListedMultipartPart[]
  isTruncated: boolean
  nextPartNumberMarker: number | null
}> {
  const query: Record<string, string> = { uploadId: input.uploadId }
  if (input.partNumberMarker != null) {
    query["part-number-marker"] = String(input.partNumberMarker)
  }
  if (input.maxParts != null) {
    query["max-parts"] = String(input.maxParts)
  }
  const response = await fetchFilebaseWithTimeout(await buildS3SignedRequest({
    method: "GET",
    config: requestConfig(input),
    objectKey: input.objectKey,
    query,
    bodyHashMode: "empty",
  }), "Filebase multipart list parts")
  if (response.status === 404) {
    throw notFoundError("Multipart upload not found")
  }
  const xml = await requireProviderOk(response, "Filebase multipart list parts")
  const parts = extractXmlBlocks(xml, "Part").map((partXml) => ({
    partNumber: parseRequiredInteger(extractXmlValue(partXml, "PartNumber"), "PartNumber"),
    etag: decodeXmlEntities(extractXmlValue(partXml, "ETag") || ""),
    size: parseRequiredInteger(extractXmlValue(partXml, "Size"), "Size"),
  }))
  for (const part of parts) {
    if (!part.etag) {
      throw providerUnavailable("Filebase multipart list parts response included a part without an ETag")
    }
  }
  const nextMarker = extractXmlValue(xml, "NextPartNumberMarker")
  return {
    parts,
    isTruncated: (extractXmlValue(xml, "IsTruncated") || "").toLowerCase() === "true",
    nextPartNumberMarker: nextMarker ? parseRequiredInteger(nextMarker, "NextPartNumberMarker") : null,
  }
}

export async function buildUploadPartPresignedUrl(input: {
  env: Env
  config?: S3SigningConfig
  objectKey: string
  uploadId: string
  partNumber: number
  contentType?: string | null
  expiresInSeconds?: number
  now?: Date
}): Promise<URL> {
  return await buildS3PresignedUrl({
    method: "PUT",
    config: requestConfig(input),
    objectKey: input.objectKey,
    query: {
      partNumber: String(input.partNumber),
      uploadId: input.uploadId,
    },
    headers: input.contentType ? { "content-type": input.contentType } : undefined,
    bodyHashMode: "unsigned",
    expiresInSeconds: input.expiresInSeconds ?? 300,
    now: input.now,
  })
}
