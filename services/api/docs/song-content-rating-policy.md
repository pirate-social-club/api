# Song content ratings

Pirate uses three song-lyrics content ratings. These labels describe content;
they are not a substitute for a jurisdiction-specific legal rating.

| Rating | Product behavior | Classification threshold |
| --- | --- | --- |
| `safe` | No explicit-content notice or age gate. | No material mature content under the rules below. Mild isolated language such as “damn” or “hell” may remain safe. |
| `sensitive` | Show the explicit-content `E` notice. A user may exclude it from personalized feeds. No age verification is required. | Strong or repeated profanity, substance use, mature themes, non-graphic violence, suggestive slang, or sexual innuendo that does not meet the adult threshold. |
| `adult` | Require verified-adult access through `age_gate_policy=18_plus`. | The lyrics directly depict a sexual act or contain comparably explicit sexual content suitable only for verified adults. Graphic detail is not required, but a mere mention of sex, nudity, desire, or lovemaking is not enough. |

Classification considers the lyrics as a whole and in context. Isolated words,
profanity, substance references, or innuendo do not by themselves establish the
adult rating. Content that violates publication policy is handled by the
separate block/review system; the lyrics classifier never recommends blocking.

Pirate deliberately does not expose 13+ or 16+ music gates. The commonly used
music-industry explicit-content mark is a notice, not a precise age-access
standard, and Pirate currently has a verified-adult capability rather than
reliable intermediate-age capabilities. `sensitive` supplies the notice tier;
`adult` is reserved for the higher access-control threshold.

## Failure and review behavior

A missing, truncated, invalid, or provider-error classifier response is not a
safe verdict. It enters the retryable provider-unavailable path and publication
does not proceed until classification succeeds.

Automated model agreement is evidence, not policy and not authorization to
change live content. A moderator changing a persisted rating must use the
reviewed `set_content_rating` action with a human-readable note and evidence
reference. The action records the previous and next content ratings and the
previous and next age-gate policies in the same transaction as the post change.

Changing `adult` to `safe` or `sensitive` removes the 18+ gate; changing either
lower tier to `adult` applies it. Reclassification is never performed by a raw
post-row update.
