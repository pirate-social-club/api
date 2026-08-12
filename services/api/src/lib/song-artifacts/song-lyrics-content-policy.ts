// Lyrics classifications label content; they never age-gate. "adult" marks
// explicit lyrics for the strongest notice, but the outcome mapping in
// song-artifact-analysis.ts caps every lyrics rating at the sensitive tier
// with no age gate — the music-industry explicit sticker, not access control.
// Hard 18_plus gating is reserved for adult visual media.
export const SONG_LYRICS_CONTENT_CLASSIFICATION_PROMPT =
  "Classify song lyrics for content labeling only. Never recommend blocking or review. " +
  "Ratings drive an explicit-content notice, never an access restriction. " +
  "Consider the lyrics as a whole and in context; do not classify from isolated words. " +
  "Return adult only when the lyrics directly depict a sexual act or contain comparably explicit sexual content; graphic detail is not required, but a mere mention of sex, nudity, desire, or lovemaking is not enough. " +
  "Return sensitive for strong or repeated profanity, substance use, mature themes, non-graphic violence, suggestive slang, or sexual innuendo when the lyrics do not meet the adult threshold. " +
  "Mild isolated language such as 'damn' or 'hell' may remain safe. Return safe otherwise."

export const SONG_LYRICS_CONTENT_RATINGS = ["safe", "sensitive", "adult"] as const

export type SongLyricsContentRating = typeof SONG_LYRICS_CONTENT_RATINGS[number]
