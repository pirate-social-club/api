import { RtcRole, RtcTokenBuilder } from "agora-token"
import type { Env } from "../../../env"
import { sha256Hex } from "../../crypto"
import { conflictError, internalError } from "../../errors"
import type { LiveRoom } from "./types"

export type LiveRoomSeat = "host" | "guest"
export type LiveRoomAudienceSeat = "viewer"

export type LiveRoomRuntimeAttachResponse = {
  runtime: {
    status: "attached"
    seat: LiveRoomSeat
    room_runtime_id: string
  }
  bridge: {
    ticket: string
    ticket_expires_at: number | null
  }
  agora: {
    app_id: string | null
    channel: string
    uid: number
    token: string | null
    token_expires_at: number | null
    configured: boolean
  }
}

export type LiveRoomRuntimeViewerAttachResponse = {
  runtime: {
    status: "attached"
    seat: LiveRoomAudienceSeat
    room_runtime_id: string
  }
  agora: LiveRoomRuntimeAttachResponse["agora"]
}

export type LiveRoomRuntimeEndResponse = {
  ok: true
  status: "ended"
  ended_at: number
  bridge_ticket_valid_until: number
}

type RuntimeMeta = {
  room_id: string
  community_id: string
  host_user_id: string
  guest_user_id: string | null
  status: "created" | "live" | "ended"
  agora_channel: string
  host_bridge_ticket_hash?: string
  host_bridge_ticket?: string
  host_agora_uid?: number
  guest_bridge_ticket_hash?: string
  guest_bridge_ticket?: string
  guest_bridge_ticket_revoked_hash?: string
  guest_agora_uid?: number
  ended_at?: number
  bridge_ticket_valid_until?: number
  created_at: number
  updated_at: number
}

const META_KEY = "meta"
const DEFAULT_TOKEN_TTL_SECONDS = 3600
const BRIDGE_TICKET_GRACE_AFTER_END_SECONDS = 300
const devRuntimeMetaById = new Map<string, RuntimeMeta>()

function nowSeconds(): number {
  return Math.floor(Date.now() / 1000)
}

function randomTicket(): string {
  const bytes = new Uint8Array(24)
  crypto.getRandomValues(bytes)
  return Array.from(bytes).map((byte) => byte.toString(16).padStart(2, "0")).join("")
}

function randomAgoraUid(): number {
  const value = new Uint32Array(1)
  crypto.getRandomValues(value)
  return value[0]
}

function agoraChannelForRoom(room: Pick<LiveRoom, "id">): string {
  return `pirate-live-${room.id}`
}

function runtimeIdForRoom(room: Pick<LiveRoom, "community" | "id">): string {
  return `${room.community}:${room.id}`
}

function buildAgoraBlock(input: {
  env: Env
  channel: string
  uid: number
  role?: number
}): LiveRoomRuntimeAttachResponse["agora"] {
  const appId = input.env.AGORA_APP_ID?.trim() || null
  const appCertificate = input.env.AGORA_APP_CERTIFICATE?.trim() || null
  const ttlSeconds = liveRoomRuntimeTokenTtlSeconds(input.env)
  const tokenExpiresAt = nowSeconds() + ttlSeconds
  const token = appId && appCertificate
    ? RtcTokenBuilder.buildTokenWithUid(
      appId,
      appCertificate,
      input.channel,
      input.uid,
      input.role ?? RtcRole.PUBLISHER,
      tokenExpiresAt,
      tokenExpiresAt,
    )
    : null
  return {
    app_id: appId,
    channel: input.channel,
    uid: input.uid,
    token,
    token_expires_at: token ? tokenExpiresAt : null,
    configured: Boolean(token),
  }
}

async function attachToMeta(input: {
  env: Env
  room: LiveRoom
  seat: LiveRoomSeat
  current: RuntimeMeta | null
}): Promise<{ meta: RuntimeMeta; response: LiveRoomRuntimeAttachResponse }> {
  const roomRuntimeId = runtimeIdForRoom(input.room)
  const now = nowSeconds()
  const meta: RuntimeMeta = input.current ?? {
    room_id: input.room.id,
    community_id: input.room.community,
    host_user_id: input.room.host_user,
    guest_user_id: input.room.guest_user,
    status: "created",
    agora_channel: agoraChannelForRoom(input.room),
    created_at: now,
    updated_at: now,
  }

  if (meta.status === "ended") {
    throw conflictError("Live room has ended")
  }

  const existingTicket = input.seat === "host" ? meta.host_bridge_ticket : null
  const ticket = existingTicket ?? randomTicket()
  const uid = input.seat === "host"
    ? meta.host_agora_uid ?? randomAgoraUid()
    : meta.guest_agora_uid ?? randomAgoraUid()

  if (input.seat === "host") {
    meta.host_bridge_ticket = ticket
    meta.host_bridge_ticket_hash = await sha256Hex(ticket)
    meta.host_agora_uid = uid
    meta.status = "live"
  } else {
    meta.guest_bridge_ticket = ticket
    meta.guest_bridge_ticket_hash = await sha256Hex(ticket)
    meta.guest_bridge_ticket_revoked_hash = undefined
    meta.guest_agora_uid = uid
  }
  meta.updated_at = now

  return {
    meta,
    response: {
      runtime: {
        status: "attached",
        seat: input.seat,
        room_runtime_id: roomRuntimeId,
      },
      bridge: {
        ticket,
        ticket_expires_at: null,
      },
      agora: buildAgoraBlock({
        env: input.env,
        channel: meta.agora_channel,
        uid,
      }),
    },
  }
}

async function parseRuntimeJson<T>(response: Response): Promise<T> {
  const body = await response.json().catch(() => null) as { error?: string } | T | null
  if (!response.ok) {
    if (response.status === 409) {
      throw conflictError(typeof body === "object" && body && "error" in body ? body.error ?? "Live room runtime conflict" : "Live room runtime conflict")
    }
    throw internalError("Live room runtime request failed")
  }
  return body as T
}

export function attachLiveRoomViewerRuntime(input: {
  env: Env
  room: LiveRoom
}): LiveRoomRuntimeViewerAttachResponse {
  return {
    runtime: {
      status: "attached",
      seat: "viewer",
      room_runtime_id: runtimeIdForRoom(input.room),
    },
    agora: buildAgoraBlock({
      env: input.env,
      channel: agoraChannelForRoom(input.room),
      uid: randomAgoraUid(),
      role: RtcRole.SUBSCRIBER,
    }),
  }
}

export function renewLiveRoomViewerRuntime(input: {
  env: Env
  room: LiveRoom
  uid: number
}): LiveRoomRuntimeViewerAttachResponse {
  return {
    runtime: {
      status: "attached",
      seat: "viewer",
      room_runtime_id: runtimeIdForRoom(input.room),
    },
    agora: buildAgoraBlock({
      env: input.env,
      channel: agoraChannelForRoom(input.room),
      uid: input.uid,
      role: RtcRole.SUBSCRIBER,
    }),
  }
}

export async function attachLiveRoomRuntime(input: {
  env: Env
  room: LiveRoom
  seat: LiveRoomSeat
}): Promise<LiveRoomRuntimeAttachResponse> {
  const binding = input.env.LIVE_ROOM_RUNTIME
  if (binding) {
    const id = binding.idFromName(runtimeIdForRoom(input.room))
    const stub = binding.get(id)
    const response = await stub.fetch("https://live-room-runtime.invalid/attach", {
      method: "POST",
      headers: { "content-type": "application/json" },
      body: JSON.stringify({
        room: input.room,
        seat: input.seat,
      }),
    })
    return await parseRuntimeJson<LiveRoomRuntimeAttachResponse>(response)
  }

  const runtimeId = runtimeIdForRoom(input.room)
  const attached = await attachToMeta({
    env: input.env,
    room: input.room,
    seat: input.seat,
    current: devRuntimeMetaById.get(runtimeId) ?? null,
  })
  devRuntimeMetaById.set(runtimeId, attached.meta)
  return attached.response
}

export async function endLiveRoomRuntime(input: {
  env: Env
  room: LiveRoom
}): Promise<LiveRoomRuntimeEndResponse> {
  const binding = input.env.LIVE_ROOM_RUNTIME
  if (binding) {
    const id = binding.idFromName(runtimeIdForRoom(input.room))
    const stub = binding.get(id)
    const response = await stub.fetch("https://live-room-runtime.invalid/end", { method: "POST" })
    return await parseRuntimeJson<LiveRoomRuntimeEndResponse>(response)
  }

  const runtimeId = runtimeIdForRoom(input.room)
  const current = devRuntimeMetaById.get(runtimeId)
  if (!current) {
    throw conflictError("Live room runtime is not initialized")
  }
  const ended = endMeta(current)
  devRuntimeMetaById.set(runtimeId, current)
  return ended
}

export async function revokeGuestLiveRoomRuntime(input: {
  env: Env
  room: LiveRoom
}): Promise<void> {
  const binding = input.env.LIVE_ROOM_RUNTIME
  if (binding) {
    const id = binding.idFromName(runtimeIdForRoom(input.room))
    const stub = binding.get(id)
    const response = await stub.fetch("https://live-room-runtime.invalid/guest-revoke", { method: "POST" })
    await parseRuntimeJson<{ ok: true }>(response)
    return
  }

  const current = devRuntimeMetaById.get(runtimeIdForRoom(input.room))
  if (current) {
    await revokeGuestTicket(current)
  }
}

export class LiveRoomRuntimeDO {
  constructor(
    private readonly state: DurableObjectState,
    private readonly env: Env,
  ) {}

  async fetch(request: Request): Promise<Response> {
    const url = new URL(request.url)
    if (request.method === "POST" && url.pathname === "/attach") {
      return await this.handleAttach(request)
    }
    if (request.method === "POST" && url.pathname === "/end") {
      return await this.handleEnd()
    }
    if (request.method === "POST" && url.pathname === "/guest-revoke") {
      return await this.handleGuestRevoke()
    }
    return Response.json({ error: "not_found" }, { status: 404 })
  }

  private async handleAttach(request: Request): Promise<Response> {
    const body = await request.json().catch(() => null) as { room?: LiveRoom; seat?: LiveRoomSeat } | null
    if (!body?.room || (body.seat !== "host" && body.seat !== "guest")) {
      return Response.json({ error: "invalid_attach_request" }, { status: 400 })
    }
    try {
      const current = await this.state.storage.get<RuntimeMeta>(META_KEY) ?? null
      const { meta, response } = await attachToMeta({
        env: this.env,
        room: body.room,
        seat: body.seat,
        current,
      })
      await this.state.storage.put(META_KEY, meta)
      devRuntimeMetaById.set(runtimeIdForRoom(body.room), meta)
      return Response.json(response)
    } catch (error) {
      if (error instanceof Error && error.message === "Live room has ended") {
        return Response.json({ error: error.message }, { status: 409 })
      }
      throw error
    }
  }

  private async handleEnd(): Promise<Response> {
    const current = await this.state.storage.get<RuntimeMeta>(META_KEY) ?? null
    if (!current) {
      return Response.json({ error: "runtime_not_initialized" }, { status: 404 })
    }
    const response = endMeta(current)
    await this.state.storage.put(META_KEY, current)
    return Response.json(response)
  }

  private async handleGuestRevoke(): Promise<Response> {
    const current = await this.state.storage.get<RuntimeMeta>(META_KEY) ?? null
    if (!current) {
      return Response.json({ error: "runtime_not_initialized" }, { status: 404 })
    }
    await revokeGuestTicket(current)
    await this.state.storage.put(META_KEY, current)
    return Response.json({ ok: true })
  }
}

async function revokeGuestTicket(meta: RuntimeMeta): Promise<void> {
  if (meta.guest_bridge_ticket_hash) {
    meta.guest_bridge_ticket_revoked_hash = meta.guest_bridge_ticket_hash
  }
  meta.guest_bridge_ticket = undefined
  meta.guest_bridge_ticket_hash = undefined
  meta.guest_agora_uid = undefined
  meta.updated_at = nowSeconds()
}

function endMeta(meta: RuntimeMeta): LiveRoomRuntimeEndResponse {
  const now = nowSeconds()
  if (meta.guest_bridge_ticket_hash) {
    meta.guest_bridge_ticket_revoked_hash = meta.guest_bridge_ticket_hash
  }
  meta.guest_bridge_ticket = undefined
  meta.guest_bridge_ticket_hash = undefined
  meta.guest_agora_uid = undefined
  meta.status = "ended"
  meta.ended_at = now
  meta.bridge_ticket_valid_until = now + BRIDGE_TICKET_GRACE_AFTER_END_SECONDS
  meta.updated_at = now
  return {
    ok: true,
    status: meta.status,
    ended_at: meta.ended_at,
    bridge_ticket_valid_until: meta.bridge_ticket_valid_until,
  }
}

export function liveRoomRuntimeTokenTtlSeconds(env: Env): number {
  const parsed = Number(env.LIVE_ROOM_AGORA_TOKEN_TTL_SECONDS)
  return Number.isInteger(parsed) && parsed > 0 ? parsed : DEFAULT_TOKEN_TTL_SECONDS
}
