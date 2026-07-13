import { Bee, PrivateKey, Topic, type Collection } from "@ethersphere/bee-js"
import { internalError } from "../errors"
import type { Env } from "../../env"

export type SwarmPublishInput = {
  env: Env
  path: string
  payload: unknown
  contentType?: string
}

type SwarmCollectionFile = {
  path: string
  contentType?: string
  payload: unknown
}

export type SwarmCollectionPublishInput = {
  env: Env
  files: SwarmCollectionFile[]
  indexDocument?: string | null
}

export type SwarmFeedPublishInput = {
  env: Env
  topic: string
  reference: string
}

export type SwarmPublishResult = {
  reference: string
}

export type SwarmFeedPublishResult = {
  reference: string
  feedReference: string
}

let testPublisher: ((
  input: SwarmPublishInput | SwarmCollectionPublishInput | SwarmFeedPublishInput,
) => Promise<SwarmPublishResult | SwarmFeedPublishResult>) | null = null

export function setSwarmPublisherForTests(
  publisher: ((
    input: SwarmPublishInput | SwarmCollectionPublishInput | SwarmFeedPublishInput,
  ) => Promise<SwarmPublishResult | SwarmFeedPublishResult>) | null,
): void {
  testPublisher = publisher
}

function requireBeeApiUrl(env: Env): string {
  const value = String(env.SWARM_BEE_API_URL || "").trim()
  if (!value) {
    throw internalError("SWARM_BEE_API_URL is not configured")
  }
  return value.replace(/\/+$/, "")
}

function requirePostageBatchId(env: Env): string {
  const value = String(env.SWARM_POSTAGE_BATCH_ID || "").trim()
  if (!value) {
    throw internalError("SWARM_POSTAGE_BATCH_ID is not configured")
  }
  return value
}

function requireFeedPrivateKey(env: Env): string {
  const value = String(env.SWARM_FEED_PRIVATE_KEY || "").trim()
  if (!value) {
    throw internalError("SWARM_FEED_PRIVATE_KEY is not configured")
  }
  const normalized = value.startsWith("0x") ? value : `0x${value}`
  if (!/^0x[0-9a-fA-F]{64}$/.test(normalized)) {
    throw internalError("SWARM_FEED_PRIVATE_KEY must be a 32-byte hex private key")
  }
  return normalized
}

function feedTopicNamespace(env: Env): string {
  return String(env.SWARM_FEED_TOPIC_NAMESPACE || "pirate-comment-threads").trim() || "pirate-comment-threads"
}

function normalizeReference(reference: { toHex?: () => string } | string): string {
  if (typeof reference === "string") {
    return reference
  }
  if (typeof reference?.toHex === "function") {
    return reference.toHex()
  }
  throw internalError("Swarm publish response did not include a reference")
}

function createBee(env: Env): Bee {
  return new Bee(requireBeeApiUrl(env))
}

function createFeedSigner(env: Env): PrivateKey {
  return new PrivateKey(requireFeedPrivateKey(env))
}

export async function publishJsonToSwarm(input: SwarmPublishInput): Promise<SwarmPublishResult> {
  if (testPublisher) {
    const result = await testPublisher(input)
    return { reference: result.reference }
  }

  const bee = createBee(input.env)
  const result = await bee.uploadData(requirePostageBatchId(input.env), JSON.stringify(input.payload))
  return {
    reference: normalizeReference(result.reference),
  }
}

export async function publishCollectionToSwarm(input: SwarmCollectionPublishInput): Promise<SwarmPublishResult> {
  if (testPublisher) {
    const result = await testPublisher(input)
    return { reference: result.reference }
  }

  const bee = createBee(input.env)
  const collection: Collection = input.files.map((file) => {
    const body = JSON.stringify(file.payload)
    return {
      path: file.path,
      size: Buffer.byteLength(body),
      file: new File([body], file.path, {
        type: file.contentType ?? "application/json",
      }),
    }
  })

  const result = await bee.uploadCollection(requirePostageBatchId(input.env), collection, {
    indexDocument: input.indexDocument ?? undefined,
  })
  return {
    reference: normalizeReference(result.reference),
  }
}

export async function publishFeedReference(input: SwarmFeedPublishInput): Promise<SwarmFeedPublishResult> {
  if (testPublisher) {
    const result = await testPublisher(input)
    return {
      reference: result.reference,
      feedReference: "feedReference" in result ? result.feedReference : result.reference,
    }
  }

  const bee = createBee(input.env)
  const signer = createFeedSigner(input.env)
  const topic = Topic.fromString(input.topic)
  const batchId = requirePostageBatchId(input.env)
  const writer = bee.makeFeedWriter(topic, signer)
  await writer.uploadReference(batchId, input.reference)
  const feedReference = await bee.createFeedManifest(batchId, topic, signer.publicKey().address())

  return {
    reference: input.reference,
    feedReference: normalizeReference(feedReference),
  }
}

export function buildThreadFeedTopic(input: {
  env: Env
  communityId: string
  threadRootPostId: string
}): string {
  return `${feedTopicNamespace(input.env)}:${input.communityId}:${input.threadRootPostId}`
}
