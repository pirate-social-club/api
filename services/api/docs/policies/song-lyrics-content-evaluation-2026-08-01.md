# Song lyrics policy evaluation — 2026-08-01

The policy prompt was evaluated at temperature 0 with a strict JSON schema and
`max_completion_tokens: 500` against Gemini 3.1 Flash Lite, Claude Sonnet 4.6,
GPT-5.6 Luna, and DeepSeek V4 Flash 0731.

All valid responses matched the labelled boundary cases:

- ordinary lyrics: `safe`
- isolated “damn” / “hell”: `safe`
- strong repeated profanity: `sensitive`
- substance use: `sensitive`
- sexual innuendo without a depicted act: `sensitive`
- a direct graphic depiction of a sexual act: `adult`

DeepSeek produced two malformed or empty responses. Those are provider failures,
not classification votes; the production path retries and prevents publication.

Results for the three existing gated songs were:

| Song | Gemini | Claude | GPT-5.6 Luna | DeepSeek |
| --- | --- | --- | --- | --- |
| Tip Your Drink Up | adult | sensitive | adult | adult |
| Flash of Fantasy | sensitive | sensitive | sensitive | sensitive |
| In Time Girl | sensitive | sensitive | adult | adult |

This evaluation validates that the prompt expresses the intended boundaries; it
does not authorize changing a live moderation decision. The remaining splits are
human policy judgements about whether the exact lyrics directly depict a sexual
act. Run the checked-in evaluator against the current public post payload before
using results in a future review.

Example:

```sh
SONG_POLICY_EVAL_MODELS=model-a,model-b \
  bun scripts/evaluate-song-lyrics-content-policy.ts cases.json
```
