-- 003: make the vector index usable by the query recall actually runs.
--
-- 002 created a vector index on the embedding column alone, and it worked: an unfiltered
-- nearest-neighbour query plans as a `vector search` over it. Recall is never unfiltered, and that
-- is where it fell apart. MEASURED on the live cluster, with statistics freshly collected so a
-- stale row estimate could not be mistaken for the cause:
--
--   no filter                             -> vector search over memory_embedding_ann
--   WHERE evicted_at IS NULL              -> FULL SCAN
--   WHERE workspace_id = $1               -> FULL SCAN
--   WHERE workspace_id = $1 AND is_live   -> vector search, with prefix spans  (after this file)
--
-- CockroachDB accelerates a filtered vector search only when the filters match the index's PREFIX
-- columns. An index on the vector alone therefore accelerates a query nobody runs. This is the
-- kind of thing that stays invisible until someone reads a query plan, because the index exists,
-- the query returns correct rows, and only the speed is a lie.
--
-- `is_live` is a STORED COMPUTED column rather than a plain boolean kept in step by application
-- code. `evicted_at IS NULL` is the single source of truth and the database derives the rest, so
-- the two cannot drift. A plain column would need a CHECK to get the same guarantee, and a trigger
-- or discipline to maintain it.
--
-- The rewrite is safe to re-run: every statement is guarded, and on a fresh install this applies to
-- an empty table. Applying it to a POPULATED table rebuilds the vector index, and CockroachDB
-- blocks writes to the table while that backfill runs. That is a maintenance window, not a deploy.

ALTER TABLE memory ADD COLUMN IF NOT EXISTS is_live BOOL NOT NULL AS (evicted_at IS NULL) STORED;

DROP INDEX IF EXISTS memory_embedding_ann;

CREATE VECTOR INDEX IF NOT EXISTS memory_embedding_ann
    ON memory (workspace_id, is_live, embedding vector_cosine_ops);
