CREATE TABLE IF NOT EXISTS app_sync (
    sync_key      text PRIMARY KEY,
    value         jsonb NOT NULL,
    version       bigint NOT NULL DEFAULT 1 CHECK (version > 0),
    updated_at    timestamptz NOT NULL DEFAULT now(),
    updated_by    text NOT NULL,
    CONSTRAINT app_sync_key_length
        CHECK (char_length(sync_key) BETWEEN 1 AND 120),
    CONSTRAINT app_sync_actor_length
        CHECK (char_length(updated_by) BETWEEN 1 AND 200)
);

CREATE INDEX IF NOT EXISTS idx_app_sync_updated_at
    ON app_sync (updated_at DESC);

CREATE TABLE IF NOT EXISTS app_accounts (
    account_key   text PRIMARY KEY,
    profile       jsonb NOT NULL,
    ordinal       integer NOT NULL DEFAULT 0 CHECK (ordinal >= 0),
    updated_at    timestamptz NOT NULL DEFAULT now(),
    updated_by    text NOT NULL,
    CONSTRAINT app_accounts_profile_object
        CHECK (jsonb_typeof(profile) = 'object'),
    CONSTRAINT app_accounts_key_length
        CHECK (char_length(account_key) BETWEEN 1 AND 200),
    CONSTRAINT app_accounts_actor_length
        CHECK (char_length(updated_by) BETWEEN 1 AND 200)
);

CREATE INDEX IF NOT EXISTS idx_app_accounts_ordinal
    ON app_accounts (ordinal, account_key);

CREATE INDEX IF NOT EXISTS idx_app_accounts_student_id
    ON app_accounts ((profile ->> 'studentId'));

CREATE INDEX IF NOT EXISTS idx_app_accounts_email
    ON app_accounts (lower(profile ->> 'email'));

CREATE TABLE IF NOT EXISTS app_records (
    id            bigserial PRIMARY KEY,
    record_type   text NOT NULL,
    payload       jsonb NOT NULL,
    version       bigint NOT NULL DEFAULT 1 CHECK (version > 0),
    created_at    timestamptz NOT NULL DEFAULT now(),
    updated_at    timestamptz NOT NULL DEFAULT now(),
    created_by    text NOT NULL,
    updated_by    text NOT NULL,
    CONSTRAINT app_records_payload_object
        CHECK (jsonb_typeof(payload) = 'object'),
    CONSTRAINT app_records_type_length
        CHECK (char_length(record_type) BETWEEN 1 AND 80),
    CONSTRAINT app_records_created_actor_length
        CHECK (char_length(created_by) BETWEEN 1 AND 200),
    CONSTRAINT app_records_updated_actor_length
        CHECK (char_length(updated_by) BETWEEN 1 AND 200)
);

CREATE INDEX IF NOT EXISTS idx_app_records_type_updated
    ON app_records (record_type, updated_at DESC, id DESC);

CREATE INDEX IF NOT EXISTS idx_app_records_payload_gin
    ON app_records USING gin (payload jsonb_path_ops);

CREATE TABLE IF NOT EXISTS audit_events (
    id            bigserial PRIMARY KEY,
    event_type    text NOT NULL,
    actor         text NOT NULL,
    subject_type  text,
    subject_id    text,
    details       jsonb NOT NULL DEFAULT '{}'::jsonb,
    created_at    timestamptz NOT NULL DEFAULT now(),
    CONSTRAINT audit_events_details_object
        CHECK (jsonb_typeof(details) = 'object'),
    CONSTRAINT audit_events_type_length
        CHECK (char_length(event_type) BETWEEN 1 AND 120),
    CONSTRAINT audit_events_actor_length
        CHECK (char_length(actor) BETWEEN 1 AND 200),
    CONSTRAINT audit_events_subject_type_length
        CHECK (subject_type IS NULL OR char_length(subject_type) BETWEEN 1 AND 80),
    CONSTRAINT audit_events_subject_id_length
        CHECK (subject_id IS NULL OR char_length(subject_id) <= 200)
);

CREATE INDEX IF NOT EXISTS idx_audit_events_created_at
    ON audit_events (created_at DESC, id DESC);

CREATE INDEX IF NOT EXISTS idx_audit_events_actor_created
    ON audit_events (actor, created_at DESC);

CREATE INDEX IF NOT EXISTS idx_audit_events_subject
    ON audit_events (subject_type, subject_id, created_at DESC);
