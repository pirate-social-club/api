# Song Study fill-blank human-review rubric

## Purpose

Use this rubric to decide whether generated fill-blank cards are suitable for
learner exposure in `/study` and Telegram. It evaluates card quality; it does
not authorize a rollout, change lesson-slot allocation, or establish that a
generated card will actually be served.

Review the frozen report for the exact generator version and source snapshot.
The report's `card_digest` is an identity and regression tripwire only. A stable
digest proves that the same cards were generated; it does not prove that those
cards are good.

## Current generator limitation

The current generator chooses distractors from other words in the same song.
It filters by script bucket, minimum length, stopwords, visible words, and
duplicates, then orders the remaining words by a deterministic hash rank. It
does not evaluate part of speech, inflection, syntactic fit, or semantic fit.

Consequently, grammatically impossible distractors are an expected failure
mode, not an exceptional edge case. A reviewer must score every distractor;
same-script tokens and deterministic output are not evidence of plausibility.

## Review prerequisites

A review record must identify:

- the frozen report or snapshot reference, generator version, source
  fingerprint, and `card_digest`;
- the song and card identifiers without including lyrics in the identifier;
- detected lyrics language and confidence;
- whether the card is actually included in a generated lesson session;
- every surface reviewed: `/study`, Telegram, or both;
- a language-qualified role identifier such as `reviewer_es`, never a person's
  name.

The reviewer must be proficient enough in the lyrics language to judge
ordinary grammar, inflection, and idiom. Mark the card `unreviewable` when that
condition is not met. Do not infer quality from a translation alone.

Prioritize cards with `actual_session_inclusion=true`. Generated but unserved
cards may be reviewed as generator diagnostics, but they must be reported
separately so theoretical yield cannot be mistaken for learner exposure.

## Review procedure

1. Inspect the rendered prompt, token bank, and enough surrounding lyrics to
   understand the line, with the expected answer hidden.
2. For each blank, record every bank token that produces a grammatically and
   contextually defensible completion. Score ambiguity, difficulty, and any
   giveaway before revealing the expected placement.
3. Reveal the expected placement and score each distractor for part of speech,
   inflection, grammatical possibility, and competitiveness.
4. Repeat the giveaway check on every target surface. Rendering, button order,
   wrapping, capitalization, and helper copy can create surface-specific clues.
5. Assign a disposition and a short evidence note. Do not average away a hard
   failure.

For a two-blank card, evaluate each blank independently and then evaluate the
pair. A token may be plausible in isolation while the combined placement is
ambiguous or mechanically forced by the other blank.

## Hard gates

A card fails review if any of these conditions applies:

- more than one bank token or token placement is a defensible answer under the
  displayed context;
- the expected answer is ungrammatical, semantically incoherent, or not the
  source lyric;
- exact grading would mark a reasonable learner choice wrong;
- the answer is exposed or mechanically identifiable without recalling the
  lyric;
- every distractor is grammatically impossible or immediately removable;
- a two-blank card becomes ambiguous when both placements are considered;
- a qualified review cannot be completed in the detected lyrics language.

Hard-gate failures receive `reject`, regardless of the numeric scores below.

## Dimension scores

### 1. Answer ambiguity

| Score | Definition |
| --- | --- |
| `0` | Multiple tokens or placements are clearly valid, or the expected answer is not valid. Hard failure. |
| `1` | One alternative is defensible through a common idiom, ellipsis, agreement pattern, or reasonable reading. Hard failure because grading is exact. |
| `2` | The expected token or placement is the only defensible completion given the rendered line and available context. |

Do not require a distractor to reproduce the original lyric to count as an
alternative. If it forms natural language that a learner could reasonably
choose from the displayed evidence, the card is ambiguous even when it changes
the lyric's intended meaning.

### 2. Retrieval difficulty

| Score | Definition |
| --- | --- |
| `1` | Trivial: surface clues or obviously impossible distractors reveal the answer with negligible recall. |
| `2` | Light: one plausible competitor remains, but broad grammar or meaning removes the rest quickly. |
| `3` | Productive: several tokens require lyric recall or attentive language knowledge, while the answer remains unique. Target. |
| `4` | Demanding: the answer is unique but requires uncommon vocabulary, distant context, or a difficult two-blank dependency. Usable only when intentional for the learner level. |
| `5` | Unfair: the displayed context is insufficient, the distinction is specialist-only, or success depends on guessing. Hard failure. |

A normal review target is `2` or `3`. A score of `4` requires an explicit note
explaining why the difficulty is appropriate. Difficulty is not quality by
itself: an ambiguous card is not made useful by being hard.

### 3. Distractor plausibility

Score every distractor against every blank it could occupy. Use `0`, `1`, or
`2` for each test:

| Test | `0` | `1` | `2` |
| --- | --- | --- | --- |
| Part of speech | Wrong lexical category; immediate elimination. | Category is context-dependent or only loosely comparable. | Same required category in this construction. |
| Inflection | Cannot agree with the visible subject, tense, number, gender, case, or other required morphology. | Related form, but the surface form is strained or mismatched. | Surface form is morphologically possible in the blank. |
| Grammatical possibility | Cannot form a grammatical line. | Possible only under an uncommon parse or marked usage. | Produces a natural grammatical construction. |
| Competitiveness | Unrelated or visibly absurd. | Superficially related but easy to dismiss. | Credible enough to test recall while remaining uniquely wrong in context. |

A good distractor normally scores `2` for part of speech, inflection, and
grammatical possibility, then loses on the lyric's meaning or remembered source
rather than on basic syntax. A card is `revise` when any distractor scores `0`
on two or more of the first three tests. It is `reject` when no distractor is
competitive or when a highly competitive distractor creates answer ambiguity.

For two-blank cards, also record whether a distractor becomes plausible only
after the other blank is filled. Do not credit a bank as strong merely because
the first placement mechanically determines the second.

### 4. Giveaway detection

Record each observed clue. Mark it `hard` when it identifies the answer without
lyric recall; otherwise mark it `soft` and include it in the difficulty score.

Check for:

- only one token with the required part of speech or inflection;
- capitalization, punctuation, apostrophes, diacritics, or script differences
  that match only one token;
- token length, blank width, line wrapping, or button layout that reveals the
  answer;
- the answer repeated in visible lyrics, translation, helper text, title, or
  surrounding context;
- token ordering or stable placement that consistently favors the answer;
- audio, transliteration, or pronunciation help that states the missing word;
- in two-blank cards, a forced leftover token or an obvious one-to-one pairing;
- all distractors belonging to visibly different grammatical categories or
  semantic fields from the answer.

Surface-specific giveaway findings must name the surface. A card can pass in
`/study` and fail in Telegram, or the reverse.

## Disposition

| Disposition | Meaning |
| --- | --- |
| `pass` | All hard gates pass; ambiguity is `2`; difficulty is normally `2` or `3`; distractors provide a fair recall test; no hard giveaway exists. |
| `revise` | The expected answer is uniquely valid, but weak distractors, an avoidable soft giveaway, or intentionally high difficulty should be improved before exposure. |
| `reject` | Any hard gate fails. The card must not be served. |
| `unreviewable` | The source, language expertise, rendering, or frozen evidence required for review is unavailable. This is not a pass. |

Review outcomes must feed a generator or presentation change plus a regression
fixture. Do not repair a rejected production card by hand-editing stored cloze
rows or language-reliability fields.

## Review record

Use one record per card with these fields:

| Field | Required value |
| --- | --- |
| `snapshot_ref` | Frozen report reference and `card_digest` |
| `card_id` | Stable non-lyric identifier |
| `source_fingerprint` | Generator input identity |
| `generator_version` | Cloze generation version |
| `lyrics_language` | Detected language and confidence |
| `actual_session_inclusion` | `true` or `false` for the frozen session simulation |
| `surfaces` | `/study`, Telegram, or both |
| `reviewer_role` | Language-qualified role identifier |
| `acceptable_placements` | All defensible token placements found blind |
| `ambiguity_score` | `0`–`2` |
| `difficulty_score` | `1`–`5` |
| `distractor_scores` | Per-token, per-blank four-test scores |
| `giveaways` | Surface, severity, clue, and evidence |
| `disposition` | `pass`, `revise`, `reject`, or `unreviewable` |
| `notes` | Concise linguistic rationale |

## Rollout evidence

For an initial canary, review every card that is actually included in the
selected canary songs' frozen sessions on both learner surfaces. No included
card may have a hard-gate failure. Report generated-but-unserved cards in a
separate diagnostic section.

Before broader exposure, publish aggregate results by language and surface:

- counts of `pass`, `revise`, `reject`, and `unreviewable`;
- ambiguity and difficulty distributions;
- distractor failures by part of speech, inflection, grammar, and
  competitiveness;
- giveaway counts by type and surface;
- reviewed generation yield versus actual session inclusion;
- the frozen `card_digest` so later runs can detect a changed corpus.

Do not use averages to waive individual ambiguity, exact-grading, or giveaway
failures. A new digest invalidates the prior card-level review until the diff is
reviewed.
