import type { Env } from "../../../env"

export type LiveRoomJacktripBlock = {
  required: boolean
  configured: boolean
  server: string | null
  port: number | null
  bind_port: number | null
  quality: string
  buffer_strategy: string
  linux_audio_setup_recommended: boolean
}

type LiveRoomJacktripRoom = {
  community: string
  id: string
  room_kind: "solo" | "duet"
}

function cleanString(value: unknown): string | null {
  if (typeof value !== "string") return null
  const trimmed = value.trim()
  return trimmed || null
}

function parseOptionalPositiveInteger(value: string | undefined): number | null {
  if (!value?.trim()) return null
  const parsed = Number(value)
  return Number.isInteger(parsed) && parsed > 0 ? parsed : null
}

function parseBooleanEnv(value: string | undefined, fallback: boolean): boolean {
  if (!value?.trim()) return fallback
  const normalized = value.trim().toLowerCase()
  if (normalized === "1" || normalized === "true" || normalized === "yes") return true
  if (normalized === "0" || normalized === "false" || normalized === "no") return false
  return fallback
}

function jacktripServerForRoom(env: Env, room: LiveRoomJacktripRoom): string | null {
  const template = cleanString(env.LIVE_ROOM_JACKTRIP_HOST_TEMPLATE)
  if (template) {
    return template
      .replaceAll("{community}", room.community)
      .replaceAll("{room}", room.id)
      .replaceAll("{live_room}", room.id)
  }
  return cleanString(env.LIVE_ROOM_JACKTRIP_HOST)
}

export function buildJacktripBlock(env: Env, room: LiveRoomJacktripRoom): LiveRoomJacktripBlock {
  const required = room.room_kind === "duet"
  const server = required ? jacktripServerForRoom(env, room) : null
  const port = required ? parseOptionalPositiveInteger(env.LIVE_ROOM_JACKTRIP_PORT) ?? 4464 : null
  return {
    required,
    configured: !required || Boolean(server),
    server,
    port,
    bind_port: required ? parseOptionalPositiveInteger(env.LIVE_ROOM_JACKTRIP_BIND_PORT) : null,
    quality: cleanString(env.LIVE_ROOM_JACKTRIP_QUALITY) ?? "4",
    buffer_strategy: cleanString(env.LIVE_ROOM_JACKTRIP_BUFFER_STRATEGY) ?? "3",
    linux_audio_setup_recommended: required
      ? parseBooleanEnv(env.LIVE_ROOM_JACKTRIP_LINUX_AUDIO_SETUP_RECOMMENDED, true)
      : false,
  }
}
