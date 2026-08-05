-- 004: the demo's daily spend ceiling, as a row rather than as a variable.
--
-- WHY THIS TABLE IS IN THE MEMORY PACKAGE'S MIGRATIONS AND NOT SOMEWHERE NEARER ITS ONE READER.
-- The migration runner owns a SCHEMA, not a package: one ordered set of files, one
-- `schema_migrations` table, one checksum chain. A second migration source for the API would mean
-- two runners racing for the same version numbers, which is a worse coupling than this one. The
-- boundary that actually matters is the import graph, and it is untouched: `packages/memory` has no
-- knowledge of this table, and `apps/api` reads it through the `Database` port like any other
-- caller. `.dependency-cruiser.cjs` still forbids the memory core from importing an app.
--
-- The ceiling is counted here rather than in the process because the demo runs on Lambda, where a
-- cold start is a normal event and an in-memory counter is a counter that resets whenever the
-- platform decides to scale. The in-memory token bucket next to it in `apps/api/src/http` is the
-- fast guard against one impatient visitor; this is the one that protects the bill.
--
-- One row per UTC day. The day is supplied by the application rather than taken from `current_date`,
-- because the cluster's session time zone is a setting somebody can change without touching this
-- repository, and a budget that rolls over at an hour the operator does not expect is a bug that
-- only ever shows up on an invoice.
--
-- Re-runnable, like every file here: the runner applies statements outside a transaction because
-- CockroachDB restricts what a transaction containing schema changes may also do, so an interrupted
-- migration is re-applied on the next attempt.

CREATE TABLE IF NOT EXISTS demo_budget (
    day    DATE   PRIMARY KEY,

    -- Never negative. The only writer increments, so a negative value would mean either a manual
    -- edit or a bug, and both are worth a loud failure rather than a budget that reads as unspent.
    calls  INT8   NOT NULL DEFAULT 0,

    CONSTRAINT calls_not_negative CHECK (calls >= 0)
);
