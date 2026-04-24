import type { CommunityRepository } from "./db-community-repository"
import { badRequestError, notFoundError } from "../errors"
import { nowIso } from "../helpers"
import { openCommunityDb } from "./community-db-factory"
import {
  parseCommunitySettingsJson,
  requireOwnedCommunity,
} from "./create/service"
import type { Env } from "../../types"

const MACHINE_ACCESS_POLICY_SETTINGS_KEY = "machine_access_policy"
const TOP_COMMENTS_LIMIT = 10

export type CommunityMachineAccessPolicy = {
  community_id: string
  policy_origin: "default" | "explicit"
  access_mode: "structured_api" | "structured_api_enhanced"
  included_surfaces: {
    community_identity: true
    community_stats: boolean
    thread_cards: boolean
    thread_bodies: boolean
    top_comments: boolean
    events: boolean
  }
  allowed_uses: {
    summarization: true
    analytics: true
    ai_training: "prohibited"
  }
  operational_limits: {
    anonymous_rate_tier: "low"
    authenticated_rate_tier: "standard"
    top_comments_limit: number
    max_lookback_window: string
  }
  updated_at: string
}

export type CommunityMachineAccessPolicyPatch = {
  access_mode?: CommunityMachineAccessPolicy["access_mode"]
  included_surfaces?: Partial<CommunityMachineAccessPolicy["included_surfaces"]>
}

export type MachineAccessSurface = keyof CommunityMachineAccessPolicy["included_surfaces"]

export type OmittedStructuredSurface = {
  surface: Exclude<MachineAccessSurface, "community_identity">
  reason: "community_opt_out" | "platform_disabled" | "not_visible" | "not_in_v0"
}

const configurableSurfaces = [
  "community_stats",
  "thread_cards",
  "thread_bodies",
  "top_comments",
  "events",
] as const satisfies Array<Exclude<MachineAccessSurface, "community_identity">>

const machineAccessSurfaces = [
  "community_identity",
  ...configurableSurfaces,
] as const satisfies MachineAccessSurface[]

function isRecord(value: unknown): value is Record<string, unknown> {
  return Boolean(value && typeof value === "object" && !Array.isArray(value))
}

function isAccessMode(value: unknown): value is CommunityMachineAccessPolicy["access_mode"] {
  return value === "structured_api" || value === "structured_api_enhanced"
}

function normalizeStoredPolicy(input: {
  communityId: string
  updatedAt: string
  value: unknown
}): CommunityMachineAccessPolicy | null {
  if (!isRecord(input.value)) {
    return null
  }

  const defaultPolicy = defaultCommunityMachineAccessPolicy({
    communityId: input.communityId,
    updatedAt: input.updatedAt,
  })
  const includedSurfaces = isRecord(input.value.included_surfaces)
    ? input.value.included_surfaces
    : {}

  return {
    ...defaultPolicy,
    policy_origin: "explicit",
    access_mode: isAccessMode(input.value.access_mode)
      ? input.value.access_mode
      : defaultPolicy.access_mode,
    included_surfaces: {
      ...defaultPolicy.included_surfaces,
      ...Object.fromEntries(
        configurableSurfaces.flatMap((surface) =>
          typeof includedSurfaces[surface] === "boolean"
            ? [[surface, includedSurfaces[surface]]]
            : []),
      ),
      community_identity: true,
    },
    updated_at: typeof input.value.updated_at === "string" && input.value.updated_at.trim()
      ? input.value.updated_at
      : input.updatedAt,
  }
}

async function readStoredMachineAccessPolicy(input: {
  env: Env
  communityId: string
  updatedAt: string
  communityRepository: CommunityRepository
}): Promise<CommunityMachineAccessPolicy> {
  const db = await openCommunityDb(input.env, input.communityRepository, input.communityId)
  try {
    const result = await db.client.execute({
      sql: `
        SELECT settings_json
        FROM communities
        WHERE community_id = ?1
        LIMIT 1
      `,
      args: [input.communityId],
    })
    const settings = parseCommunitySettingsJson(result.rows[0]?.settings_json)
    const storedPolicy = normalizeStoredPolicy({
      communityId: input.communityId,
      updatedAt: input.updatedAt,
      value: settings[MACHINE_ACCESS_POLICY_SETTINGS_KEY],
    })

    return storedPolicy ?? defaultCommunityMachineAccessPolicy({
      communityId: input.communityId,
      updatedAt: input.updatedAt,
    })
  } finally {
    db.close()
  }
}

function assertCommunityMachineAccessPolicyPatch(
  body: CommunityMachineAccessPolicyPatch | null,
): CommunityMachineAccessPolicyPatch {
  if (!isRecord(body)) {
    throw badRequestError("Invalid machine access policy payload")
  }

  if (body.access_mode !== undefined && !isAccessMode(body.access_mode)) {
    throw badRequestError("access_mode is invalid")
  }

  if (body.included_surfaces !== undefined && !isRecord(body.included_surfaces)) {
    throw badRequestError("included_surfaces is invalid")
  }

  const includedSurfaces: Partial<CommunityMachineAccessPolicy["included_surfaces"]> = {}
  if (isRecord(body.included_surfaces)) {
    for (const [surface, value] of Object.entries(body.included_surfaces)) {
      if (!machineAccessSurfaces.includes(surface as MachineAccessSurface)) {
        throw badRequestError(`Unknown machine access surface: ${surface}`)
      }
      if (surface === "community_identity") {
        if (value !== true) {
          throw badRequestError("community_identity cannot be disabled")
        }
        includedSurfaces.community_identity = true
        continue
      }
      if (typeof value !== "boolean") {
        throw badRequestError(`${surface} must be a boolean`)
      }
      includedSurfaces[surface as Exclude<MachineAccessSurface, "community_identity">] = value
    }
  }

  return {
    ...(body.access_mode ? { access_mode: body.access_mode } : {}),
    ...(Object.keys(includedSurfaces).length ? { included_surfaces: includedSurfaces } : {}),
  }
}

export function omittedSurface(surface: Exclude<MachineAccessSurface, "community_identity">): OmittedStructuredSurface {
  return {
    surface,
    reason: "community_opt_out",
  }
}

export function omittedSurfacesForPolicy(
  policy: CommunityMachineAccessPolicy,
  surfaces: Array<Exclude<MachineAccessSurface, "community_identity">>,
): OmittedStructuredSurface[] {
  return surfaces.flatMap((surface) =>
    policy.included_surfaces[surface] ? [] : [omittedSurface(surface)])
}

export function topCommentsLimit(): number {
  return TOP_COMMENTS_LIMIT
}

export function defaultCommunityMachineAccessPolicy(input: {
  communityId: string
  updatedAt: string
}): CommunityMachineAccessPolicy {
  return {
    community_id: input.communityId,
    policy_origin: "default",
    access_mode: "structured_api",
    included_surfaces: {
      community_identity: true,
      community_stats: true,
      thread_cards: true,
      thread_bodies: true,
      top_comments: true,
      events: true,
    },
    allowed_uses: {
      summarization: true,
      analytics: true,
      ai_training: "prohibited",
    },
    operational_limits: {
      anonymous_rate_tier: "low",
      authenticated_rate_tier: "standard",
      top_comments_limit: TOP_COMMENTS_LIMIT,
      max_lookback_window: "all_time",
    },
    updated_at: input.updatedAt,
  }
}

export async function getCommunityMachineAccessPolicy(input: {
  env: Env
  communityRepository: CommunityRepository
  communityId: string
  userId: string
}): Promise<CommunityMachineAccessPolicy> {
  const community = await requireOwnedCommunity(input.communityRepository, input.communityId, input.userId)
  return readStoredMachineAccessPolicy({
    env: input.env,
    communityRepository: input.communityRepository,
    communityId: community.community_id,
    updatedAt: community.updated_at,
  })
}

export async function getResolvedCommunityMachineAccessPolicy(input: {
  env: Env
  communityRepository: CommunityRepository
  communityId: string
}): Promise<CommunityMachineAccessPolicy> {
  const community = await input.communityRepository.getCommunityById(input.communityId)
  if (!community || community.provisioning_state !== "active" || community.status !== "active") {
    throw notFoundError("Community not found")
  }

  return readStoredMachineAccessPolicy({
    env: input.env,
    communityRepository: input.communityRepository,
    communityId: community.community_id,
    updatedAt: community.updated_at,
  })
}

export async function updateCommunityMachineAccessPolicy(input: {
  env: Env
  communityRepository: CommunityRepository
  communityId: string
  userId: string
  body: CommunityMachineAccessPolicyPatch | null
}): Promise<CommunityMachineAccessPolicy> {
  const body = assertCommunityMachineAccessPolicyPatch(input.body)
  const community = await requireOwnedCommunity(input.communityRepository, input.communityId, input.userId)
  const existingPolicy = await readStoredMachineAccessPolicy({
    env: input.env,
    communityRepository: input.communityRepository,
    communityId: community.community_id,
    updatedAt: community.updated_at,
  })
  const now = nowIso()
  const nextPolicy: CommunityMachineAccessPolicy = {
    ...existingPolicy,
    policy_origin: "explicit",
    access_mode: body.access_mode ?? existingPolicy.access_mode,
    included_surfaces: {
      ...existingPolicy.included_surfaces,
      ...body.included_surfaces,
      community_identity: true,
    },
    updated_at: now,
  }
  const db = await openCommunityDb(input.env, input.communityRepository, input.communityId)
  try {
    const result = await db.client.execute({
      sql: `
        SELECT settings_json
        FROM communities
        WHERE community_id = ?1
        LIMIT 1
      `,
      args: [input.communityId],
    })
    const existingSettings = parseCommunitySettingsJson(result.rows[0]?.settings_json)

    await db.client.execute({
      sql: `
        UPDATE communities
        SET settings_json = ?2,
            updated_at = ?3
        WHERE community_id = ?1
      `,
      args: [
        input.communityId,
        JSON.stringify({
          ...existingSettings,
          [MACHINE_ACCESS_POLICY_SETTINGS_KEY]: {
            access_mode: nextPolicy.access_mode,
            included_surfaces: nextPolicy.included_surfaces,
            updated_at: now,
          },
        }),
        now,
      ],
    })
  } finally {
    db.close()
  }

  return nextPolicy
}
