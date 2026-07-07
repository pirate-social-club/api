import type { Env } from "../env"
import { publicCommunityId, publicPostId } from "./public-ids"

type WaitUntil = (promise: Promise<void>) => void

type PublicPostCachePurgeInput = {
  env: Env
  communityId?: string | null
  postId: string
  waitUntil?: WaitUntil
}

export function publicPostCacheTags(input: {
  communityId?: string | null
  postId: string
}): string[] {
  const tags = [`post:${publicPostId(input.postId)}`]
  if (input.communityId) {
    tags.push(`community:${publicCommunityId(input.communityId)}`)
  }
  return tags
}

function cloudflareCachePurgeConfig(env: Env): { zoneId: string; token: string } | null {
  const zoneId = env.CLOUDFLARE_CACHE_PURGE_ZONE_ID?.trim()
    || env.CLOUDFLARE_ZONE_ID?.trim()
  const token = env.CLOUDFLARE_CACHE_PURGE_API_TOKEN?.trim()
    || env.CLOUDFLARE_API_TOKEN?.trim()
  if (!zoneId || !token) {
    return null
  }
  return { zoneId, token }
}

export async function purgePublicReadCacheTags(input: {
  env: Env
  tags: string[]
  fetcher?: typeof fetch
}): Promise<void> {
  const config = cloudflareCachePurgeConfig(input.env)
  if (!config || input.tags.length === 0) {
    return
  }

  const response = await (input.fetcher ?? fetch)(
    `https://api.cloudflare.com/client/v4/zones/${encodeURIComponent(config.zoneId)}/purge_cache`,
    {
      method: "POST",
      headers: {
        "Authorization": `Bearer ${config.token}`,
        "Content-Type": "application/json",
      },
      body: JSON.stringify({ tags: [...new Set(input.tags)] }),
    },
  )
  if (!response.ok) {
    const body = await response.text().catch(() => "")
    throw new Error(`Cloudflare cache purge failed with ${response.status}${body ? `: ${body.slice(0, 500)}` : ""}`)
  }
}

export function schedulePublicPostCachePurge(input: PublicPostCachePurgeInput): Promise<void> {
  const tags = publicPostCacheTags(input)
  const task = purgePublicReadCacheTags({
    env: input.env,
    tags,
  }).catch((error) => {
    console.error("[public-read-cache] failed to purge public post cache tags", {
      post_id: input.postId,
      community_id: input.communityId ?? null,
      tags,
      error: error instanceof Error ? error.message : String(error),
    })
  })

  if (input.waitUntil) {
    input.waitUntil(task)
    return Promise.resolve()
  }
  return task
}
