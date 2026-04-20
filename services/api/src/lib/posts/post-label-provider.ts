import type { Community, Env, Post } from "../../types"

export type PostLabelProviderResult = {
  provider: "openrouter"
  model: string
  labelId: string
  confidence: number | null
  providerResult: Record<string, unknown> | null
}

function trimEnv(value: string | undefined): string {
  return String(value || "").trim()
}

function normalizeMessageContent(content: unknown): string {
  if (typeof content === "string") {
    return content
  }
  if (!Array.isArray(content)) {
    return ""
  }
  return content
    .filter((part) => part && typeof part === "object" && (part as { type?: string }).type === "text")
    .map((part) => String((part as { text?: string }).text ?? ""))
    .join("")
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
  const apiKey = trimEnv(input.env.OPENROUTER_API_KEY)
  if (!apiKey) {
    throw new Error("OPENROUTER_API_KEY is not configured")
  }

  const baseUrl = trimEnv(input.env.OPENROUTER_BASE_URL) || "https://openrouter.ai/api/v1"
  const model = trimEnv(input.env.OPENROUTER_LABELING_MODEL)
    || trimEnv(input.env.OPENROUTER_MODEL)
    || "google/gemini-2.5-flash-lite-preview-09-2025"
  const timeoutMs = Number.parseInt(
    trimEnv(input.env.OPENROUTER_LABELING_TIMEOUT_MS) || trimEnv(input.env.OPENROUTER_TIMEOUT_MS),
    10,
  )
  const controller = new AbortController()
  const timer = Number.isFinite(timeoutMs) && timeoutMs > 0
    ? setTimeout(() => controller.abort(), timeoutMs)
    : null

  try {
    const response = await fetch(`${baseUrl.replace(/\/+$/, "")}/chat/completions`, {
      method: "POST",
      headers: {
        authorization: `Bearer ${apiKey}`,
        "content-type": "application/json",
      },
      body: JSON.stringify({
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
      }),
      signal: controller.signal,
    })

    if (!response.ok) {
      throw new Error(`OpenRouter labeling request failed with http_${response.status}`)
    }

    const body = await response.json().catch(() => null) as
      | {
          choices?: Array<{ message?: { content?: unknown } }>
        }
      | null
    if (!body) {
      throw new Error("OpenRouter labeling response was not valid JSON")
    }

    const normalizedContent = normalizeMessageContent(body.choices?.[0]?.message?.content)
    if (!normalizedContent.trim()) {
      throw new Error("OpenRouter labeling response was empty")
    }

    const parsed = JSON.parse(normalizedContent) as {
      label_id: string
      confidence: number | null
    }

    return {
      provider: "openrouter",
      model,
      labelId: parsed.label_id,
      confidence: typeof parsed.confidence === "number" ? parsed.confidence : null,
      providerResult: body as Record<string, unknown>,
    }
  } finally {
    if (timer) {
      clearTimeout(timer)
    }
  }
}
