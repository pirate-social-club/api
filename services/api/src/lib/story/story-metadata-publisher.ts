import type { Env } from "../../env"
import { sha256Hex, toArrayBuffer } from "../crypto"
import { providerUnavailable } from "../errors"
import { resolveFilebaseConfig } from "../storage/filebase-config"
import { buildS3SignedRequest } from "../storage/s3-signing"
import { publishJsonToSwarm } from "../swarm/swarm-publisher"

export type StoryMetadataPublishInput = {
  env: Env
  path: string
  payload: unknown
}

export type StoryMetadataPublishResult = {
  uri: string
  hash: `0x${string}`
}

let testStoryJsonMetadataPublisher: ((input: StoryMetadataPublishInput) => Promise<StoryMetadataPublishResult>) | null = null

export function setStoryJsonMetadataPublisherForTests(
  publisher: ((input: StoryMetadataPublishInput) => Promise<StoryMetadataPublishResult>) | null,
): void {
  testStoryJsonMetadataPublisher = publisher
}

function hasSwarmPublishConfig(env: Env): boolean {
  return Boolean(String(env.SWARM_BEE_API_URL || "").trim() && String(env.SWARM_POSTAGE_BATCH_ID || "").trim())
}

function buildSwarmReferenceUri(reference: string): string {
  return `bzz://${reference}`
}

function buildIpfsReferenceUri(cid: string): string {
  return `ipfs://${cid}`
}

function requireFilebaseCid(response: Response): string {
  const cid = response.headers.get("x-amz-meta-cid")?.trim()
  if (!cid) {
    throw providerUnavailable("Filebase Story metadata upload did not return an IPFS CID")
  }
  return cid
}

async function publishJsonToFilebase(input: {
  env: Env
  path: string
  body: string
  payloadHash: string
}): Promise<{ uri: string }> {
  const request = await buildS3SignedRequest({
    method: "PUT",
    config: resolveFilebaseConfig(input.env),
    objectKey: input.path,
    payloadHash: input.payloadHash,
    headers: {
      "content-type": "application/json",
    },
    body: toArrayBuffer(input.body),
  })
  const response = await fetch(request)
  if (!response.ok) {
    const responseText = await response.text().catch(() => "")
    throw providerUnavailable(
      `Filebase Story metadata upload failed with status ${response.status}${responseText ? `: ${responseText}` : ""}`,
    )
  }

  return {
    uri: buildIpfsReferenceUri(requireFilebaseCid(response)),
  }
}

export async function publishStoryJsonMetadata(input: StoryMetadataPublishInput): Promise<StoryMetadataPublishResult> {
  if (testStoryJsonMetadataPublisher) {
    return await testStoryJsonMetadataPublisher(input)
  }

  const body = JSON.stringify(input.payload)
  const payloadHash = await sha256Hex(body)

  if (hasSwarmPublishConfig(input.env)) {
    const published = await publishJsonToSwarm({
      env: input.env,
      path: input.path,
      payload: input.payload,
    })
    return {
      uri: buildSwarmReferenceUri(published.reference),
      hash: `0x${payloadHash}`,
    }
  }

  const published = await publishJsonToFilebase({
    env: input.env,
    path: input.path,
    body,
    payloadHash,
  })
  return {
    uri: published.uri,
    hash: `0x${payloadHash}`,
  }
}
