import { readFile } from "node:fs/promises"
import {
  SONG_LYRICS_CONTENT_CLASSIFICATION_PROMPT,
  SONG_LYRICS_CONTENT_RATINGS,
  type SongLyricsContentRating,
} from "../src/lib/song-artifacts/song-lyrics-content-policy"

type EvaluationCase = {
  id: string
  lyrics?: string
  public_post_id?: string
  expected?: SongLyricsContentRating
}

type EvaluationResult = {
  id: string
  expected: SongLyricsContentRating | null
  model: string
  rating: SongLyricsContentRating | null
  reason: string | null
  error: string | null
}

function requiredEnv(name: string): string {
  const value = process.env[name]?.trim()
  if (!value) throw new Error(`${name} is required`)
  return value
}

function parseModels(): string[] {
  const models = requiredEnv("SONG_POLICY_EVAL_MODELS")
    .split(",")
    .map((model) => model.trim())
    .filter(Boolean)
  if (models.length === 0) throw new Error("SONG_POLICY_EVAL_MODELS must contain at least one model")
  return models
}

function isRating(value: unknown): value is SongLyricsContentRating {
  return typeof value === "string" && SONG_LYRICS_CONTENT_RATINGS.includes(value as SongLyricsContentRating)
}

async function resolveLyrics(evaluationCase: EvaluationCase): Promise<string> {
  if (typeof evaluationCase.lyrics === "string") return evaluationCase.lyrics
  if (!evaluationCase.public_post_id) {
    throw new Error(`Case ${evaluationCase.id} requires lyrics or public_post_id`)
  }
  const origin = process.env.PIRATE_API_ORIGIN?.trim() || "https://api.pirate.sc"
  const response = await fetch(
    `${origin.replace(/\/+$/, "")}/public-posts/${encodeURIComponent(evaluationCase.public_post_id)}`,
  )
  if (!response.ok) throw new Error(`post_http_${response.status}`)
  const body = await response.json() as { post?: { lyrics?: unknown } }
  if (typeof body.post?.lyrics !== "string") throw new Error("post_lyrics_missing")
  return body.post.lyrics
}

async function classify(input: {
  apiKey: string
  baseUrl: string
  model: string
  lyrics: string
}): Promise<{ rating: SongLyricsContentRating; reason: string }> {
  const response = await fetch(`${input.baseUrl.replace(/\/+$/, "")}/chat/completions`, {
    method: "POST",
    headers: {
      authorization: `Bearer ${input.apiKey}`,
      "content-type": "application/json",
    },
    body: JSON.stringify({
      model: input.model,
      temperature: 0,
      max_completion_tokens: 500,
      response_format: {
        type: "json_schema",
        json_schema: {
          name: "song_lyrics_age_gate",
          strict: true,
          schema: {
            type: "object",
            additionalProperties: false,
            required: ["age_gate_rating", "reason"],
            properties: {
              age_gate_rating: { type: "string", enum: SONG_LYRICS_CONTENT_RATINGS },
              reason: { type: "string" },
            },
          },
        },
      },
      messages: [
        { role: "system", content: SONG_LYRICS_CONTENT_CLASSIFICATION_PROMPT },
        { role: "user", content: input.lyrics },
      ],
    }),
  })
  if (!response.ok) throw new Error(`http_${response.status}`)
  const body = await response.json() as {
    choices?: Array<{ message?: { content?: string } }>
  }
  const content = body.choices?.[0]?.message?.content
  if (!content) throw new Error("invalid_response")
  const parsed = JSON.parse(content) as { age_gate_rating?: unknown; reason?: unknown }
  if (!isRating(parsed.age_gate_rating) || typeof parsed.reason !== "string") {
    throw new Error("invalid_classification")
  }
  return { rating: parsed.age_gate_rating, reason: parsed.reason }
}

const inputPath = process.argv[2]
if (!inputPath) {
  throw new Error("Usage: bun scripts/evaluate-song-lyrics-content-policy.ts <cases.json>")
}

const cases = JSON.parse(await readFile(inputPath, "utf8")) as EvaluationCase[]
if (!Array.isArray(cases) || cases.some((item) => !item?.id || (
  typeof item.lyrics !== "string" && typeof item.public_post_id !== "string"
))) {
  throw new Error("Input must be an array of { id, lyrics|public_post_id, expected? } cases")
}

const apiKey = requiredEnv("OPENROUTER_API_KEY")
const baseUrl = process.env.OPENROUTER_BASE_URL?.trim() || "https://openrouter.ai/api/v1"
const models = parseModels()
const results: EvaluationResult[] = []

for (const evaluationCase of cases) {
  const lyrics = await resolveLyrics(evaluationCase)
  for (const model of models) {
    try {
      const classification = await classify({ apiKey, baseUrl, model, lyrics })
      results.push({
        id: evaluationCase.id,
        expected: evaluationCase.expected ?? null,
        model,
        rating: classification.rating,
        reason: classification.reason,
        error: null,
      })
    } catch (error) {
      results.push({
        id: evaluationCase.id,
        expected: evaluationCase.expected ?? null,
        model,
        rating: null,
        reason: null,
        error: error instanceof Error ? error.message : String(error),
      })
    }
  }
}

console.log(JSON.stringify({
  prompt: SONG_LYRICS_CONTENT_CLASSIFICATION_PROMPT,
  max_completion_tokens: 500,
  results,
}, null, 2))
