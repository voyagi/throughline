-- 001: the memory table, its audit trail, and the constraints that make provenance non-optional.
--
-- Every statement here is idempotent. Migrations run OUTSIDE a transaction, because CockroachDB
-- restricts combining schema changes with writes in one transaction, and the version row is a
-- write. The consequence is that a migration interrupted halfway leaves its version unrecorded and
-- will be re-run, so re-running has to be safe. That is a property of every statement below, not a
-- hope about them.
--
-- Object names are UNQUALIFIED on purpose. The runner creates the configured schema and pins
-- search_path before executing this file, so the schema name lives in exactly one place instead of
-- being both a setting and a hardcoded prefix that could disagree with it.

-- schema_migrations is NOT created here. The runner owns it, because it has to read that table to
-- decide whether this file needs running at all, and a table that only exists after the first
-- migration cannot answer that question on a fresh cluster.

CREATE TABLE IF NOT EXISTS memory (
    id                 UUID         PRIMARY KEY DEFAULT gen_random_uuid(),
    workspace_id       STRING       NOT NULL,
    kind               STRING       NOT NULL,
    content            STRING       NOT NULL,

    -- Nullable, and the pair below is enforced. A memory can legitimately exist before it has been
    -- embedded (the embedder was down, the write still had to be recorded), and a vector whose
    -- producer is unknown cannot be compared to anything safely, so the two travel together.
    embedding          VECTOR(1024),
    embedding_model    STRING,

    -- Provenance. Not metadata: a memory nobody can attribute is a rumour, and the CHECK below is
    -- what makes "rejected at the boundary" true at the layer that cannot be bypassed.
    asserted_by        STRING       NOT NULL,
    incident_id        STRING,
    source_ref         STRING,

    created_at         TIMESTAMPTZ  NOT NULL DEFAULT now(),
    last_confirmed_at  TIMESTAMPTZ  NOT NULL DEFAULT now(),
    confirm_count      INT8         NOT NULL DEFAULT 0,
    contradict_count   INT8         NOT NULL DEFAULT 0,

    -- The interval over which this is claimed to hold. valid_until is set when something
    -- supersedes it, which is why superseding does not need to destroy the old row.
    valid_from         TIMESTAMPTZ  NOT NULL DEFAULT now(),
    valid_until        TIMESTAMPTZ,
    superseded_by      UUID,

    -- The grace window, stamped at write time. Eviction consults this BEFORE it consults any
    -- score, which is what stops the newest memory being eaten by the write that stored it.
    protected_until    TIMESTAMPTZ  NOT NULL,

    -- Tombstone. An evicted memory stays queryable, so an eviction is auditable rather than a
    -- disappearance.
    evicted_at         TIMESTAMPTZ,
    eviction_reason    STRING,

    CONSTRAINT kind_is_known CHECK (
        kind IN ('observation', 'resolution', 'runbook_fact', 'rejected_hypothesis', 'entity_fact')
    ),
    CONSTRAINT content_is_present CHECK (length(content) > 0),
    CONSTRAINT provenance_is_present CHECK (length(asserted_by) > 0),
    CONSTRAINT counts_are_not_negative CHECK (confirm_count >= 0 AND contradict_count >= 0),
    CONSTRAINT validity_window_is_ordered CHECK (valid_until IS NULL OR valid_until >= valid_from),
    CONSTRAINT eviction_is_explained CHECK ((evicted_at IS NULL) = (eviction_reason IS NULL)),
    CONSTRAINT embedding_is_attributed CHECK ((embedding IS NULL) = (embedding_model IS NULL)),
    CONSTRAINT supersede_is_not_self CHECK (superseded_by IS NULL OR superseded_by != id)
);

-- Recall reads live rows for one workspace. Partial, because the tombstones it excludes will
-- eventually outnumber the rows it returns, and an index that carries them pays for them forever.
CREATE INDEX IF NOT EXISTS memory_live_by_workspace
    ON memory (workspace_id, kind, last_confirmed_at DESC)
    WHERE evicted_at IS NULL;

-- Walking a supersede chain ("what replaced this, and what replaced that") is the query behind
-- every "why did you tell me that in June" question.
CREATE INDEX IF NOT EXISTS memory_supersede_chain
    ON memory (superseded_by)
    WHERE superseded_by IS NOT NULL;

-- The eviction sweep orders by protection first, so it can find what it is allowed to touch
-- without scanning what it is not.
CREATE INDEX IF NOT EXISTS memory_eviction_candidates
    ON memory (workspace_id, protected_until)
    WHERE evicted_at IS NULL;

-- Every memory operation, including the ones that changed nothing. A refusal is the interesting
-- half: an eviction run that reports only removals cannot be told apart from one whose protections
-- never fired.
CREATE TABLE IF NOT EXISTS memory_audit (
    id            UUID         PRIMARY KEY DEFAULT gen_random_uuid(),
    occurred_at   TIMESTAMPTZ  NOT NULL DEFAULT now(),
    workspace_id  STRING       NOT NULL,
    -- No foreign key on purpose: an audit row has to outlive the row it describes, including a
    -- hard delete somebody performs by hand during an incident.
    memory_id     UUID,
    operation     STRING       NOT NULL,
    actor         STRING       NOT NULL,
    detail        JSONB        NOT NULL DEFAULT '{}'::JSONB,

    -- Only operations something actually writes. A value nobody can produce reads as coverage and
    -- provides none, so 'migrate' is deliberately absent: schema_migrations is the migration
    -- record, and this table is for memory operations.
    CONSTRAINT operation_is_known CHECK (
        operation IN ('remember', 'supersede', 'confirm', 'contradict', 'evict', 'evict_refused',
                      'recall', 'verify')
    ),
    CONSTRAINT actor_is_present CHECK (length(actor) > 0)
);

CREATE INDEX IF NOT EXISTS memory_audit_by_workspace
    ON memory_audit (workspace_id, occurred_at DESC);

CREATE INDEX IF NOT EXISTS memory_audit_by_memory
    ON memory_audit (memory_id, occurred_at DESC)
    WHERE memory_id IS NOT NULL;
