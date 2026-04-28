import type { ActorContext, AdminActorContext, AuthenticatedEnv } from "../lib/auth-middleware"
import { getProfileRepository, getUserRepository, type ProfileRepository, type UserRepository } from "../lib/auth/repositories"
import { getCommunityRepository } from "../lib/communities/db-community-repository"
import { resolveCommunityIdentifier } from "../lib/communities/community-identifier"
import {
  getControlPlaneVerificationRepository,
  type VerificationRepository,
} from "../lib/verification/verification-repository"
import { badRequestError } from "../lib/errors"

type CommunityRouteRepository = ReturnType<typeof getCommunityRepository>

type CommunityRouteContext = {
  actor: ActorContext | AdminActorContext
  communityId: string
  communityRepository: CommunityRouteRepository
  userRepository: UserRepository
  profileRepository: ProfileRepository
}

type CommunityCreationRouteContext = {
  actor: ActorContext | AdminActorContext
  communityRepository: CommunityRouteRepository
  userRepository: UserRepository
  verificationRepository: VerificationRepository
}

type AuthenticatedRouteContext = {
  env: AuthenticatedEnv["Bindings"]
  req: {
    url: string
    param(name: string): string
    json<T>(): Promise<T>
    header(name: string): string | undefined
    arrayBuffer(): Promise<ArrayBuffer>
  }
  get(key: "actor"): ActorContext | AdminActorContext
}

function getCommunityRouteContext(c: AuthenticatedRouteContext): CommunityRouteContext {
  const communityRepository = getCommunityRepository(c.env)
  return {
    actor: c.get("actor"),
    communityId: c.req.param("communityId"),
    communityRepository,
    userRepository: getUserRepository(c.env),
    profileRepository: getProfileRepository(c.env),
  }
}

export async function getResolvedCommunityRouteContext(c: AuthenticatedRouteContext): Promise<CommunityRouteContext> {
  const base = getCommunityRouteContext(c)
  return {
    ...base,
    communityId: await resolveCommunityIdentifier(base.communityRepository, base.communityId) ?? base.communityId,
  }
}

export function getCommunityCreationRouteContext(c: AuthenticatedRouteContext): CommunityCreationRouteContext {
  return {
    actor: c.get("actor"),
    communityRepository: getCommunityRepository(c.env),
    userRepository: getUserRepository(c.env),
    verificationRepository: getControlPlaneVerificationRepository(c.env),
  }
}

export async function requireJsonBody<T>(
  c: Pick<AuthenticatedRouteContext, "req">,
  message: string,
): Promise<T> {
  const body = await c.req.json<T>().catch(() => null)
  if (!body) {
    throw badRequestError(message)
  }
  return body
}

export async function optionalJsonBody<T>(
  c: Pick<AuthenticatedRouteContext, "req">,
  message: string,
): Promise<T | null> {
  const contentLength = c.req.header("content-length")?.trim()
  const contentType = c.req.header("content-type")?.trim()
  if (contentLength === "0" || (!contentLength && !contentType)) {
    return null
  }

  try {
    return await c.req.json<T>()
  } catch {
    throw badRequestError(message)
  }
}

export function getRequestOrigin(c: Pick<AuthenticatedRouteContext, "req">): string {
  return new URL(c.req.url).origin
}

export async function readSongArtifactContent(
  c: Pick<AuthenticatedRouteContext, "req">,
): Promise<ArrayBuffer> {
  const contentType = String(c.req.header("content-type") || "").toLowerCase()
  if (contentType.includes("application/json")) {
    const body = await c.req.json<{ content_base64?: string | null }>().catch(() => null)
    const contentBase64 = body?.content_base64?.trim()
    if (!contentBase64) {
      throw badRequestError("content_base64 is required")
    }
    try {
      const decoded = atob(contentBase64)
      const bytes = new Uint8Array(decoded.length)
      for (let index = 0; index < decoded.length; index += 1) {
        bytes[index] = decoded.charCodeAt(index)
      }
      return bytes.buffer
    } catch {
      throw badRequestError("content_base64 must be valid base64")
    }
  }

  const raw = await c.req.arrayBuffer().catch(() => null)
  if (!raw || raw.byteLength === 0) {
    throw badRequestError("Song artifact content is required")
  }
  return raw
}
