import type { Env } from "../../env"
import type { Community, Post } from "../../types"
import {
  firstTrimmedEnv,
  parsePositiveIntegerEnv,
  requestOpenRouterChatCompletion,
} from "../openrouter-client"

export type PostLabelProviderResult = {
  provider: "openrouter"
  model: string
  labelId: string
  confidence: number | null
  providerResult: Record<string, unknown> | null
}

export async function requestPostLabel(input: {
  env: Env
  community: Pick<Community, "display_name">
  post: Pick<Post, "post_type" | "title" | "body" | "caption" | "link_url">
  labels: Array<{
    label_id: string
    label: string
    description?: string | null
  }>
}): Promise<PostLabelProviderResult> {
  const apiKey = firstTrimmedEnv(input.env.OPENROUTER_API_KEY)
  if (!apiKey) {
    throw new Error("OPENROUTER_API_KEY is not configured")
  }

  const model = firstTrimmedEnv(
    input.env.OPENROUTER_LABELING_MODEL,
    input.env.OPENROUTER_MODEL,
  )
    || "google/gemini-2.5-flash-lite-preview-09-2025"
  const timeoutMs = parsePositiveIntegerEnv(firstTrimmedEnv(
    input.env.OPENROUTER_LABELING_TIMEOUT_MS,
    input.env.OPENROUTER_TIMEOUT_MS,
  ))

  const { body, content } = await requestOpenRouterChatCompletion({
    apiKey,
    baseUrl: input.env.OPENROUTER_BASE_URL,
    errorLabel: "labeling",
    timeoutMs,
    body: {
      model,
      temperature: 0,
      max_completion_tokens: 160,
      response_format: {
        type: "json_schema",
        json_schema: {
          name: "post_label_assignment",
          strict: true,
          schema: {
            type: "object",
            additionalProperties: false,
            required: ["label_id", "confidence"],
            properties: {
              label_id: {
                type: "string",
                enum: input.labels.map((label) => label.label_id),
              },
              confidence: {
                type: ["number", "null"],
                minimum: 0,
                maximum: 1,
              },
            },
          },
        },
      },
      messages: [
        {
          role: "system",
          content:
            "Classify the supplied community post into exactly one existing community label. " +
            "Only use one of the provided label_id values. Do not invent labels or return prose.",
        },
        {
          role: "user",
          content: JSON.stringify({
            community: {
              display_name: input.community.display_name,
            },
            labels: input.labels.map((label) => ({
              label_id: label.label_id,
              label: label.label,
              description: label.description ?? null,
            })),
            post: {
              post_type: input.post.post_type,
              title: input.post.title ?? null,
              body: input.post.body ?? null,
              caption: input.post.caption ?? null,
              link_url: input.post.link_url ?? null,
            },
          }),
        },
      ],
    },
  })

  const parsed = JSON.parse(content) as {
    label_id: string
    confidence: number | null
  }

  return {
    provider: "openrouter",
    model,
    labelId: parsed.label_id,
    confidence: typeof parsed.confidence === "number" ? parsed.confidence : null,
    providerResult: body,
  }
}
