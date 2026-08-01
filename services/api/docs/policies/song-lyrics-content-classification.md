# Song lyrics content classification

## Purpose

Pirate classifies song lyrics on two separate axes: content notice and access.
The classifier never recommends blocking or removal. Prohibited-content policy
is enforced by the platform moderation system, not by this classifier.

## Ratings

- `safe`: no material requiring an explicit-content notice. Mild isolated
  language such as “damn” or “hell” does not require a notice by itself.
- `sensitive`: strong or repeated language, substance references, mature themes,
  non-graphic violence, suggestive slang, or sexual innuendo that warrants an
  Explicit notice but does not require verified-adult access.
- `adult`: direct depictions of sexual acts, or comparably explicit sexual
  content whose overall substance is suitable only for verified adults.
  Graphic detail is not required, but merely mentioning sex, nudity, desire, or
  lovemaking does not satisfy this threshold.

Classification considers the lyrics as a whole and in context. Isolated words,
profanity, substance references, mature themes, suggestive slang, and innuendo
do not by themselves make lyrics `adult`.

## Product mapping

- `safe` has no content notice and no age gate.
- `sensitive` carries an Explicit notice and is subject to the listener's
  explicit-content preference. It does not require identity or age proof.
- `adult` requires the existing verified `18_plus` capability.

The Explicit tier is a notice and optional-filtering standard. Its threshold is
deliberately not mapped directly to the 18+ gate.

## Failure and review

Non-empty lyrics require a valid classifier verdict before publication. Missing,
truncated, malformed, unconfigured, or unsuccessful provider responses are
retryable provider failures; absence of a verdict is never treated as `safe`.
Empty lyrics remain `safe` because there is no lyrics content to classify.

Model output is evidence, not authorization to reverse a moderation decision.
Changing a published post from `adult` to `sensitive` or `safe` requires a
reviewed moderation action that records the previous state, next state, actor,
reason, and durable evidence reference.
