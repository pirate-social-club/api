import { Hono } from "hono"
import type { AuthenticatedEnv } from "../lib/auth-middleware"
import {
  getCommunityAssistantChat,
  listCommunityAssistantChats,
  sendCommunityAssistantMessage,
  type CommunityAssistantChatBody,
} from "../lib/communities/assistant-policy/chat-service"
import {
  synthesizeCommunityAssistantSpeech,
  transcribeCommunityAssistantAudio,
  type CommunityAssistantSpeechBody,
} from "../lib/communities/assistant-policy/speech-service"
import { badRequestError } from "../lib/errors"
import {
  getResolvedCommunityRouteContext,
  requireJsonBody,
} from "./communities-route-helpers"

export function registerCommunityAssistantRoutes(communities: Hono<AuthenticatedEnv>): void {
  communities.post("/:communityId/assistant/chat", async (c) => {
    const { actor, communityId, communityRepository } = await getResolvedCommunityRouteContext(c)
    const body = await requireJsonBody<CommunityAssistantChatBody>(c, "Invalid community assistant chat payload")
    const result = await sendCommunityAssistantMessage({
      env: c.env,
      communityRepository,
      communityId,
      actor,
      body,
    })
    return c.json(result, 200)
  })

  communities.post("/:communityId/assistant/chat/audio", async (c) => {
    const { actor, communityId, communityRepository } = await getResolvedCommunityRouteContext(c)
    const formData = await c.req.formData().catch(() => null)
    const file = formData?.get("file")
    if (!(file instanceof File)) {
      throw badRequestError("file is required")
    }
    const chatId = formData?.get("chat_id")
    const transcription = await transcribeCommunityAssistantAudio({
      env: c.env,
      communityRepository,
      communityId,
      actor,
      file,
    })
    const result = await sendCommunityAssistantMessage({
      env: c.env,
      communityRepository,
      communityId,
      actor,
      body: {
        message: transcription.text,
        chat_id: typeof chatId === "string" && chatId.trim() ? chatId.trim() : null,
      },
      userMessageMetadata: {
        source: {
          kind: "voice",
          provider: transcription.provider,
          model: transcription.model,
          confidence: transcription.confidence,
          language_code: transcription.language_code,
          language_probability: transcription.language_probability,
          duration_seconds: transcription.duration_seconds,
          audio_mime_type: file.type || null,
          audio_size_bytes: file.size,
          audio_retention: "not_stored",
        },
      },
    })
    return c.json(result, 200)
  })

  communities.post("/:communityId/assistant/transcriptions", async (c) => {
    const { actor, communityId, communityRepository } = await getResolvedCommunityRouteContext(c)
    const formData = await c.req.formData().catch(() => null)
    const file = formData?.get("file")
    if (!(file instanceof File)) {
      throw badRequestError("file is required")
    }
    const result = await transcribeCommunityAssistantAudio({
      env: c.env,
      communityRepository,
      communityId,
      actor,
      file,
    })
    return c.json(result, 200)
  })

  communities.post("/:communityId/assistant/speech", async (c) => {
    const { actor, communityId, communityRepository } = await getResolvedCommunityRouteContext(c)
    const body = await requireJsonBody<CommunityAssistantSpeechBody>(c, "Invalid community assistant speech payload")
    const result = await synthesizeCommunityAssistantSpeech({
      env: c.env,
      communityRepository,
      communityId,
      actor,
      body,
    })
    return new Response(result.audio, {
      status: 200,
      headers: {
        "cache-control": "no-store",
        "content-type": result.contentType,
        "x-pirate-tts-model": result.model,
        "x-pirate-tts-provider": result.provider,
        "x-pirate-tts-voice": result.voiceId,
        ...(result.characterCount ? { "x-pirate-tts-character-count": result.characterCount } : {}),
        ...(result.requestId ? { "x-pirate-tts-request-id": result.requestId } : {}),
      },
    })
  })

  communities.get("/:communityId/assistant/chats", async (c) => {
    const { actor, communityId, communityRepository } = await getResolvedCommunityRouteContext(c)
    const result = await listCommunityAssistantChats({
      env: c.env,
      communityRepository,
      communityId,
      actor,
    })
    return c.json(result, 200)
  })

  communities.get("/:communityId/assistant/chats/:chatId", async (c) => {
    const { actor, communityId, communityRepository } = await getResolvedCommunityRouteContext(c)
    const result = await getCommunityAssistantChat({
      env: c.env,
      communityRepository,
      communityId,
      actor,
      chatId: c.req.param("chatId"),
    })
    return c.json(result, 200)
  })
}
