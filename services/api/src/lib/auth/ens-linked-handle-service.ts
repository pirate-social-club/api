import { JsonRpcProvider, getAddress } from "ethers"
import { globalSingleton } from "../db-helpers"
import type { Env } from "../../types"

export type EnsProfileMetadata = {
  avatar?: string
  description?: string
  header?: string
  social?: {
    discord?: string
    github?: string
    reddit?: string
    telegram?: string
    twitter?: string
  }
  url?: string
}

export type EnsProfileResolution = {
  name: string
  metadata: EnsProfileMetadata
}

let ensResolverForTests: ((env: Env, walletAddress: string) => Promise<string | EnsProfileResolution | null>) | null = null

export function setEnsResolverForTests(
  resolver: ((env: Env, walletAddress: string) => Promise<string | EnsProfileResolution | null>) | null,
): void {
  ensResolverForTests = resolver
}

function getEthereumRpcUrl(env: Env): string | null {
  const value = String(env.ETHEREUM_RPC_URL || "").trim()
  return value.length > 0 ? value : null
}

function getEthereumProvider(env: Env): JsonRpcProvider | null {
  const rpcUrl = getEthereumRpcUrl(env)
  if (!rpcUrl) {
    return null
  }

  return globalSingleton("ethereumRpcProvider", rpcUrl, () => (
    new JsonRpcProvider(rpcUrl, 1, { staticNetwork: true })
  ))
}

function trimRecord(value: string | null | undefined): string | undefined {
  const trimmed = value?.trim()
  return trimmed && trimmed.length <= 2048 ? trimmed : undefined
}

function normalizeEnsImageRef(value: string | null | undefined): string | undefined {
  const trimmed = trimRecord(value)
  if (!trimmed) {
    return undefined
  }

  if (/^https?:\/\//iu.test(trimmed) || /^data:image\//iu.test(trimmed)) {
    return trimmed
  }

  if (/^ipfs:\/\//iu.test(trimmed)) {
    const path = trimmed.replace(/^ipfs:\/\/(?:ipfs\/)?/iu, "")
    return path ? `https://ipfs.io/ipfs/${path}` : undefined
  }

  return undefined
}

function normalizeEnsUrl(value: string | null | undefined): string | undefined {
  const trimmed = trimRecord(value)
  if (!trimmed) {
    return undefined
  }

  try {
    const url = new URL(trimmed)
    return url.protocol === "https:" || url.protocol === "http:" ? trimmed : undefined
  } catch {
    return undefined
  }
}

function normalizeEnsSocialValue(
  platform: keyof NonNullable<EnsProfileMetadata["social"]>,
  value: string | null | undefined,
): string | undefined {
  const trimmed = trimRecord(value)?.replace(/^@/u, "")
  if (!trimmed || /[\s<>"'`]/u.test(trimmed) || /^[a-z][a-z0-9+.-]*:/iu.test(trimmed)) {
    return undefined
  }

  const patterns: Record<keyof NonNullable<EnsProfileMetadata["social"]>, RegExp> = {
    discord: /^[A-Za-z0-9_.#-]{2,64}$/u,
    github: /^[A-Za-z0-9](?:[A-Za-z0-9-]{0,37}[A-Za-z0-9])?$/u,
    reddit: /^[A-Za-z0-9_-]{3,20}$/u,
    telegram: /^[A-Za-z0-9_]{5,32}$/u,
    twitter: /^[A-Za-z0-9_]{1,15}$/u,
  }

  return patterns[platform].test(trimmed) ? trimmed : undefined
}

function normalizeEnsMetadata(metadata: EnsProfileMetadata | undefined): EnsProfileMetadata {
  const social = metadata?.social
  const normalizedSocial = {
    discord: normalizeEnsSocialValue("discord", social?.discord),
    github: normalizeEnsSocialValue("github", social?.github),
    reddit: normalizeEnsSocialValue("reddit", social?.reddit),
    telegram: normalizeEnsSocialValue("telegram", social?.telegram),
    twitter: normalizeEnsSocialValue("twitter", social?.twitter),
  }
  const hasSocial = Object.values(normalizedSocial).some(Boolean)

  return {
    ...(metadata?.avatar ? { avatar: normalizeEnsImageRef(metadata.avatar) } : {}),
    ...(metadata?.description ? { description: trimRecord(metadata.description) } : {}),
    ...(metadata?.header ? { header: normalizeEnsImageRef(metadata.header) } : {}),
    ...(hasSocial ? { social: normalizedSocial } : {}),
    ...(metadata?.url ? { url: normalizeEnsUrl(metadata.url) } : {}),
  }
}

async function getTextRecord(
  resolver: Awaited<ReturnType<JsonRpcProvider["getResolver"]>>,
  key: string,
): Promise<string | undefined> {
  if (!resolver) {
    return undefined
  }

  try {
    return trimRecord(await resolver.getText(key))
  } catch {
    return undefined
  }
}

function normalizeEnsResolution(value: string | EnsProfileResolution | null): EnsProfileResolution | null {
  if (!value) {
    return null
  }

  if (typeof value === "string") {
    const name = value.trim().toLowerCase()
    return name ? { name, metadata: {} } : null
  }

  const name = value.name.trim().toLowerCase()
  if (!name) {
    return null
  }

  return {
    name,
    metadata: normalizeEnsMetadata(value.metadata),
  }
}

export async function resolveVerifiedEnsProfile(env: Env, walletAddress: string): Promise<EnsProfileResolution | null> {
  if (ensResolverForTests) {
    return normalizeEnsResolution(await ensResolverForTests(env, walletAddress))
  }

  const provider = getEthereumProvider(env)
  if (!provider) {
    return null
  }

  let normalizedWalletAddress: string
  try {
    normalizedWalletAddress = getAddress(walletAddress)
  } catch {
    return null
  }

  try {
    const reverseName = await provider.lookupAddress(normalizedWalletAddress)
    if (!reverseName) {
      return null
    }

    const resolvedAddress = await provider.resolveName(reverseName)
    if (!resolvedAddress) {
      return null
    }

    if (getAddress(resolvedAddress) !== normalizedWalletAddress) {
      return null
    }

    const name = reverseName.trim().toLowerCase()
    const resolver = await provider.getResolver(name)
    const [
      avatarText,
      description,
      discord,
      github,
      headerText,
      reddit,
      telegram,
      twitter,
      url,
    ] = await Promise.all([
      getTextRecord(resolver, "avatar"),
      getTextRecord(resolver, "description"),
      getTextRecord(resolver, "com.discord"),
      getTextRecord(resolver, "com.github"),
      getTextRecord(resolver, "header"),
      getTextRecord(resolver, "com.reddit"),
      getTextRecord(resolver, "org.telegram"),
      getTextRecord(resolver, "com.twitter"),
      getTextRecord(resolver, "url"),
    ])
    const avatar = normalizeEnsImageRef(avatarText ?? await provider.getAvatar(name).catch(() => null))
    const header = normalizeEnsImageRef(headerText)
    const social = {
      discord: normalizeEnsSocialValue("discord", discord),
      github: normalizeEnsSocialValue("github", github),
      reddit: normalizeEnsSocialValue("reddit", reddit),
      telegram: normalizeEnsSocialValue("telegram", telegram),
      twitter: normalizeEnsSocialValue("twitter", twitter),
    }
    const hasSocial = Object.values(social).some(Boolean)

    return {
      name,
      metadata: {
        ...(avatar ? { avatar } : {}),
        ...(description ? { description } : {}),
        ...(header ? { header } : {}),
        ...(hasSocial ? { social } : {}),
        ...(normalizeEnsUrl(url) ? { url: normalizeEnsUrl(url) } : {}),
      },
    }
  } catch {
    return null
  }
}

export async function resolveVerifiedEnsName(env: Env, walletAddress: string): Promise<string | null> {
  return (await resolveVerifiedEnsProfile(env, walletAddress))?.name ?? null
}
