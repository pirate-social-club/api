CREATE TABLE song_study_pack (
    id TEXT PRIMARY KEY,
    post_id TEXT NOT NULL,
    target_language TEXT NOT NULL,
    source_language TEXT,
    study_pack_version INTEGER NOT NULL,
    status TEXT NOT NULL CHECK (
        status IN ('ready', 'processing', 'unavailable')
    ),
    unavailable_reason TEXT CHECK (
        unavailable_reason IS NULL OR unavailable_reason IN (
            'not_song',
            'no_lyrics',
            'unsupported_language',
            'generation_failed'
        )
    ),
    generated_at TEXT,
    created_at TEXT NOT NULL,
    updated_at TEXT NOT NULL,
    FOREIGN KEY (post_id) REFERENCES posts(post_id) ON DELETE CASCADE,
    UNIQUE (post_id, target_language, study_pack_version)
);

CREATE INDEX idx_song_study_pack_lookup
    ON song_study_pack(post_id, target_language, status);

CREATE TABLE song_study_exercise (
    id TEXT PRIMARY KEY,
    pack_id TEXT NOT NULL,
    line_id TEXT NOT NULL,
    line_index INTEGER NOT NULL,
    exercise_type TEXT NOT NULL CHECK (
        exercise_type IN ('say_it_back', 'translation_choice')
    ),
    prompt_text TEXT NOT NULL,
    question TEXT,
    reference_text TEXT,
    translation_text TEXT,
    options_json TEXT,
    correct_option_id TEXT,
    max_attempts INTEGER NOT NULL,
    created_at TEXT NOT NULL,
    FOREIGN KEY (pack_id) REFERENCES song_study_pack(id) ON DELETE CASCADE,
    CHECK (max_attempts > 0)
);

CREATE INDEX idx_song_study_exercise_pack
    ON song_study_exercise(pack_id, line_index);

CREATE UNIQUE INDEX idx_song_study_exercise_pack_unit
    ON song_study_exercise(pack_id, line_id, exercise_type);

CREATE TABLE song_study_attempt (
    id TEXT PRIMARY KEY,
    user_id TEXT NOT NULL,
    post_id TEXT NOT NULL,
    exercise_id TEXT NOT NULL,
    line_id TEXT NOT NULL,
    exercise_type TEXT NOT NULL CHECK (
        exercise_type IN ('say_it_back', 'translation_choice')
    ),
    target_language TEXT NOT NULL,
    study_pack_version INTEGER NOT NULL,
    attempt_number INTEGER NOT NULL,
    idempotency_key TEXT NOT NULL,
    selected_option_id TEXT,
    transcript TEXT,
    outcome TEXT NOT NULL CHECK (
        outcome IN ('correct', 'incorrect', 'revealed')
    ),
    feedback_json TEXT,
    fsrs_rating TEXT CHECK (
        fsrs_rating IS NULL OR fsrs_rating IN ('again', 'hard', 'good', 'easy')
    ),
    created_at TEXT NOT NULL,
    FOREIGN KEY (exercise_id) REFERENCES song_study_exercise(id) ON DELETE CASCADE,
    CHECK (attempt_number > 0),
    UNIQUE (user_id, exercise_id, attempt_number),
    UNIQUE (user_id, idempotency_key)
);

CREATE INDEX idx_song_study_attempt_review_unit
    ON song_study_attempt(
        user_id,
        post_id,
        line_id,
        exercise_type,
        target_language,
        created_at
    );

CREATE TABLE song_study_review_state (
    user_id TEXT NOT NULL,
    post_id TEXT NOT NULL,
    line_id TEXT NOT NULL,
    exercise_type TEXT NOT NULL CHECK (
        exercise_type IN ('say_it_back', 'translation_choice')
    ),
    target_language TEXT NOT NULL,
    state TEXT NOT NULL CHECK (
        state IN ('new', 'learning', 'review', 'relearning')
    ),
    stability REAL NOT NULL,
    difficulty REAL NOT NULL,
    due_at TEXT NOT NULL,
    last_reviewed_at TEXT,
    reps INTEGER NOT NULL DEFAULT 0,
    lapses INTEGER NOT NULL DEFAULT 0,
    fsrs_params_version INTEGER NOT NULL,
    updated_at TEXT NOT NULL,
    PRIMARY KEY (
        user_id,
        post_id,
        line_id,
        exercise_type,
        target_language
    ),
    CHECK (reps >= 0),
    CHECK (lapses >= 0)
);

CREATE INDEX idx_song_study_review_due
    ON song_study_review_state(user_id, due_at);
