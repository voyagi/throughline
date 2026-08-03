-- 002: the vector index.
--
-- Its own file, separate from 001, for one reason: it is the only statement in this repo whose
-- availability depends on the cluster tier, so an isolated failure names itself instead of taking
-- the table definition down with it.
--
-- MEASURED, not assumed: this succeeds on CockroachDB Cloud **Basic**, the free tier, on
-- v26.2.1. `SHOW CLUSTER SETTING feature.vector_index.enabled` reports true there and the CREATE
-- below completed against a live Basic cluster on 2026-08-03. That was the single largest open
-- unknown in the design, and it is closed. It is written down here because the next person to read
-- this will otherwise re-derive it from documentation that does not say.
--
-- Recall does NOT depend on this index. Without it the capability probe reports an exact scan and
-- every recall receipt says so; the answers are the same, the query is slower. The index is an
-- accelerator, and the system is built to tell you which path it actually took rather than to
-- assume the fast one.
--
-- TIMING: CockroachDB blocks writes to a table while a vector index backfills over existing rows.
-- On a fresh install this runs against an empty table and costs nothing. Applying it to a
-- populated table is a maintenance operation, not a deploy-time one.

CREATE VECTOR INDEX IF NOT EXISTS memory_embedding_ann
    ON memory (embedding vector_cosine_ops);
