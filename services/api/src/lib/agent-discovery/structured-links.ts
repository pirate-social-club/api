import type { Env } from "../../env"

export type StructuredAccessLink = {
  href: string
  type: "application/json" | "text/html" | "text/markdown"
  auth_required?: boolean
}

export type StructuredAccessLinks = Record<string, StructuredAccessLink>

function requestOrigin(url: string): string {
  return new URL(url).origin
}

export function configuredApiOrigin(env: Env, requestUrl: string): string {
  const configured = env.PIRATE_API_PUBLIC_ORIGIN?.trim()
  if (configured) {
    return new URL(configured).origin
  }
  return requestOrigin(requestUrl)
}

export function configuredWebOrigin(env: Env, requestUrl: string): string {
  const configured = env.PIRATE_WEB_PUBLIC_ORIGIN?.trim()
  if (configured) {
    return new URL(configured).origin
  }
  return requestOrigin(requestUrl)
}

export function absoluteUrl(origin: string, path: string): string {
  return new URL(path, origin).toString()
}

export function publicCommunityPath(communityId: string): string {
  return `/public-communities/${encodeURIComponent(communityId)}`
}

export function publicCommunityPostsPath(communityId: string): string {
  return `${publicCommunityPath(communityId)}/posts`
}

export function publicCommunityCapabilitiesPath(communityId: string): string {
  return `${publicCommunityPath(communityId)}/capabilities`
}

export function publicPostPath(postId: string): string {
  return `/public-posts/${encodeURIComponent(postId)}`
}

export function publicPostTopCommentsPath(postId: string): string {
  return `${publicPostPath(postId)}/top-comments`
}

export function serializeLinkHeader(links: StructuredAccessLinks): string {
  return Object.entries(links)
    .map(([rel, link]) => {
      const params = [`rel="${rel}"`, `type="${link.type}"`]
      if (link.auth_required === true) {
        params.push("auth-required=true")
      }
      return `<${link.href}>; ${params.join("; ")}`
    })
    .join(", ")
}

function addLinkHeader(headers: Headers, links: StructuredAccessLinks): void {
  const value = serializeLinkHeader(links)
  if (value) {
    headers.set("Link", value)
  }
}
