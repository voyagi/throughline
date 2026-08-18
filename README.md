# Throughline

An incident-response agent whose memory you can audit.

Every recall comes back with a receipt: what was searched, which retrieval path actually ran, what
was excluded and under which rule, and whether the search covered what it claims to have covered.
When the search cannot run, the answer is UNKNOWN, and a boundary guard makes it an error to draw
"no prior incidents" from that. The guard is in the memory layer today; the agent that will sit
behind it is not built yet. See Status below, which is kept honest rather than aspirational.

CockroachDB is the system of record for the memory. The agent runs on AWS.

## The three failures this is built against

Agent memory is easy to demo and hard to trust. Three failures break that trust in production, and
every one of them is silent.

**A fact that stopped being true.** A runbook step is correct until a migration lands, and then it
is confidently wrong. A plain embedding store has nowhere to record that.

**Absence of evidence reported as evidence of absence.** The embedding call times out, the index is
missing, the query gets cut short, and the agent reports "no prior incidents". The caller cannot
tell that from a genuine empty result. During an incident those are opposite facts.

**Eviction that eats the newest entries.** Value-based eviction ranks by usage. A memory written
four minutes ago has no usage. The incident that just happened, the one most likely to recur within
the hour, is the first thing thrown away.

Throughline treats all three as engineering problems with tests attached rather than as prompt
instructions.

## How the memory works

Memories are typed, and the type is load-bearing rather than decorative. It sets the half-life and
it changes what recall does with the row.

| Kind | Half-life | Why |
|---|---|---|
| `entity_fact` | 14 days | "The primary is db-7" is true on Tuesday and dangerous on Friday |
| `observation` | 30 days | A single reading. It ages, but it was true when recorded |
| `runbook_fact` | 90 days | Should be durable, right up until a migration quietly invalidates it |
| `resolution` | 180 days | What actually fixed something. Worth keeping |
| `rejected_hypothesis` | 365 days | "Restarting the pods did not help" stays true, and it is the cheapest thing an on-call engineer can be told |

`rejected_hypothesis` is the one most systems throw away. Knowing what did NOT fix an outage is
half the value of an incident archive, and it is the first thing a conversation summariser deletes.

Every memory carries its provenance, how many times it has been confirmed and contradicted, the
interval over which it is claimed to hold, a pointer to whatever superseded it, and the instant
before which it cannot be evicted. A write with no provenance will be rejected at the boundary
rather than warned about, once the write path lands.

Contradicting a fact does not overwrite it. It closes the old row's validity interval and links the
two, so the old row stays queryable with its end date. "Why did you tell me that in June" is a
question incident reviews actually ask.

Ranking is deterministic. Similarity, time decay, confirmation and contradiction combine into a
single score computed in code. The language model writes the narrative around a result and never
produces the number that ordered it.

## Which CockroachDB and AWS pieces are used

CockroachDB, three of the four listed technologies:

- **Distributed vector indexing** for semantic recall over the `VECTOR` column, using the cosine
  operator class. The index is treated as an accelerator and never as a correctness dependency: a
  capability probe asks the live database what it actually supports, and if the index is
  unavailable, recall falls back to an exact scan and says so in the receipt and on the status page.

  Two things worth knowing, both measured against a live cluster rather than taken from
  documentation. Vector indexing **works on the free Basic tier**, which is not documented anywhere
  we could find. And a vector index on the embedding column alone is useless here: CockroachDB
  accelerates a filtered nearest-neighbour query only when the filters match the index's **prefix
  columns**, so an unprefixed index plans as a full scan for every query this system actually runs.
  The index is `(workspace_id, is_live, embedding vector_cosine_ops)`, where `is_live` is a stored
  computed column so it cannot drift from the tombstone it is derived from. The probe confirms the
  planner really chooses it, by reading the query plan rather than by checking that an index exists.
- **The Cloud managed MCP server** as an independent verification channel and as the operator
  plane. It is deliberately not in the hot path. Reasoning in
  [docs/adr/0003](docs/adr/0003-mcp-as-verification-channel.md).
- **The ccloud CLI** for provisioning, scripted rather than clicked.

AWS: Lambda, S3, CloudFront, Bedrock, Secrets Manager and EventBridge. Bedrock runs both the agent
model and the embeddings, in eu-central-1.

## Status

Honest, and updated as it changes rather than at the end.

Working now:

- The memory layer's decision logic: typed memories, deterministic scoring with per-kind decay,
  coverage verdicts, and eviction planning with a grace window and refusal reporting.
- The live database path: schema, migrations, a connection layer that keeps credentials out of
  logs, and a capability probe that asks the running cluster what it can actually do. Migrations
  are applied and the probe runs green against a real CockroachDB Cloud cluster.
- A large test suite, including property tests and many written specifically to go red if a
  protection is removed. `npm run verify:ship` prints the count, and this line deliberately does not:
  it carried a number twice, and both times the number was stale within the same afternoon that
  wrote it. A figure nothing re-derives is a claim waiting to go false.
- The quality gate chain, with a written record of which gates have actually been proven to fail
  in [docs/gates.md](docs/gates.md).

- The repository layer: remembering, recalling, superseding, evicting and listing against real rows,
  with every recall AND every listing returning a receipt. `npm run verify:live` exercises all five
  end to end against a real cluster and asserts each outcome rather than printing it for a human to
  eyeball. That includes a superseded row being EXCLUDED from recall and PRESENT in the listing,
  which is the difference the archive page exists to show. It did not cover listing at all until a
  reviewer noticed this sentence claiming it did.
- The agent tool surface and loop, offline end to end.
- The HTTP surface: `/agent/turn`, `/memories`, `/verify`, `/status` and `/health`, with CORS from an
  exact allowlist, a per-client rate limiter and a daily ceiling counted in the database.
- The web console: five pages, the live archive at `/memory`, and the annunciator at `/status`.
  Driven in a real browser against a running API on 2026-08-08: all five pages, the agent turn, the
  archive and every filter chip, plus the rate-limited refusal and the API-is-down case. Nothing
  automated repeats that, so it is a measurement with a date on it rather than a gate.
- The hosted path on AWS Bedrock, both halves of it. `EMBEDDING_PROVIDER=bedrock` sends recall's
  embeddings to Bedrock and `AGENT_PROVIDER=bedrock` runs the loop over the Converse API. Neither
  has a default model, on purpose: each needs its own id (`EMBEDDING_MODEL_ID`, `AGENT_MODEL_ID`)
  and an `AWS_REGION`, and each refuses to start without them rather than guessing. Two optional
  variables sit beside them. `AGENT_MAX_TOKENS` caps the output of a single reply, defaults to 2048
  when unset or blank, and refuses to start on anything that is not a whole number above zero and no
  greater than 1000000. A ceiling read as NaN is not a smaller ceiling, it is a request the provider
  rejects on every turn, and so is one that is too large. `EMBEDDING_DIMENSIONS` declares how wide
  the vectors are, defaults to 1024 and refuses anything above 16000. It is read on the local path
  too, and it belongs in this list because it is what lets the width guard fire at all: a hosted
  model of a different width to the `VECTOR` column has to be refused, and a check written against a
  constant instead of a setting would be comparing a constant to a constant. Measured against
  the real account on 2026-08-12, with `amazon.titan-embed-text-v2:0` for embeddings and
  `eu.anthropic.claude-haiku-4-5-20251001-v1:0` for the agent, both in eu-central-1: rows written
  and recalled through the ANN index at similarity 0.81,
  with a deliberately unrelated control query returning nothing, and a `POST /agent/turn` answering
  in 5.4 s carrying a receipt for the recall behind it. Like the browser run above, that is a
  measurement with a date on it and not a gate. Model ids are read off the account rather than
  chosen from documentation, because an id that merely APPEARS in `list-foundation-models` can still
  refuse on-demand invocation and demand an inference profile instead. This account has models in
  exactly that state.

Not built yet:

- `npm run probe`, `npm run verify:live` and `npm run seed:demo` on the hosted embedder. The adapter
  lives in `apps/api`, and the dependency rule `memory-core-is-independent` forbids
  `packages/memory` from importing it, so all three refuse and say why rather than quietly building
  the local embedder instead. That fallback is the dangerous option, not the safe one: seeding or
  verifying with a different embedder from the one recall uses puts two vector spaces in one column,
  and nothing throws. The fix is to move the adapter into `packages/memory`.
- The deployed stack and the public demo URL.
- Three of the four islands have no test of their own. What IS covered on the console side is the
  archive page's state logic (`apps/web/test/archive-state.test.ts`) and the response-shape guard on
  all three endpoints (`apps/web/test/api-shape.test.ts`). `Console.tsx`, `StatusBoard.tsx` and
  `Annunciator.tsx` decide their states inline and nothing tests them; no test mounts any rendering.
  An earlier version of this line said "the decision logic behind each page state", which was one
  island out of four. `docs/gates.md` records which gates have been watched failing.

## Running it locally

Requires Node 22 or newer and Docker.

```bash
npm install
docker compose up -d      # single node CockroachDB, published to loopback only
npm test                  # the memory layer decision logic, no database needed
npm run gate              # the quality floor

cp .env.example .env      # then set DATABASE_URL
npm run migrate           # apply the schema
npm run probe             # ask the live cluster what it can actually do
```

To run the console against the API. The first two are servers and each wants a terminal of its own;
the third is a one-off:

```bash
CORS_ALLOWED_ORIGINS=http://127.0.0.1:4321,http://localhost:4321 npm run dev:api
npm run dev:web           # http://127.0.0.1:4321
npm run seed:demo         # one incident, so the archive has something to show
```

On PowerShell the first line is two statements, because `VAR=value command` is POSIX shell syntax
and sets nothing there:

```powershell
$env:CORS_ALLOWED_ORIGINS = "http://127.0.0.1:4321,http://localhost:4321"; npm run dev:api
```

Both loopback spellings, because a browser treats `127.0.0.1` and `localhost` as different origins
and `npm run dev:web` serves the first one. Without them the API boots with an empty allowlist, every
page still loads, and the console reports that it could not reach the API. It now says so at boot
rather than leaving you to work it out from the word `none` at the end of a line.

`npm run seed:demo` writes one scripted incident to the demo workspace and refuses to run twice.
Every row it writes is asserted by `system:demo-seed` rather than by an invented person, because the
provenance column is one of the things the archive is for.

`npm run probe` is the one to run first against any new cluster. It reports the server version, the
embedding column width, whether vector indexing is available, and whether the planner really uses
the index, each as an observation or an explicit unknown. It exits non-zero when there is no usable
retrieval path, because a probe that called that state a success would be committing the exact
error this system exists to catch.

The memory layer's logic runs and is tested with no database and no cloud account, using a
deterministic local embedder. That embedder captures lexical overlap only, and it is never a silent
fallback for a failed hosted embedder: a recall that could not embed returns coverage UNKNOWN.

Copy `.env.example` to `.env` to change anything. Every value there has a working local default
except the ones marked OWNER. Not everything this README documents is in that file, though.
`AGENT_MAX_TOKENS` and `CORS_ALLOWED_ORIGINS` are both read by the code and neither has a line
there, so both have to be set by hand until somebody adds them. The second is the one that costs
you a working console, which is why the API now says so at boot rather than leaving you to work it
out. Said here rather than left implied, because "copy the example and you have seen everything" is
the kind of sentence an operator only finds out is wrong at the point it costs them something.

No count is given, deliberately. The sentence this replaces said "one variable", and the variable it
left out was the one whose absence makes every page in the console fail its API calls.

## Layout

```text
packages/memory   the memory layer. Plain TypeScript, no web framework, no cloud SDK
apps/api          the agent and the HTTP surface. Node locally, Lambda in AWS
apps/web          the site and the console
infra             the CDK app describing every deployed resource
```

`packages/memory` importing anything from `apps/` is a build error rather than a convention. The
memory layer is the thing worth reading, and it does not get to depend on the demo around it.

## Design decisions

- [0001 Stack and deployment target](docs/adr/0001-stack.md)
- [0002 The memory model, and what it refuses to do](docs/adr/0002-memory-model.md)
- [0003 The managed MCP server is the verification channel, not the hot path](docs/adr/0003-mcp-as-verification-channel.md)
- [Quality gates, and which have been seen to fail](docs/gates.md)
- [Security notes](docs/security-notes.md)
- [Deploy review](DEPLOY-REVIEW.md)

## Prior art

The agent-memory space is crowded and well funded. Mem0 is a memory layer you attach to an existing
agent. Zep builds a temporal knowledge graph from conversation. Letta makes the agent's memory the
runtime itself. Cognee builds a graph from unstructured documents. All four are better at breadth
than anything built in two weeks, and Throughline does not try to beat them on recall quality.

The gap they leave is narrower. None of them makes a recall answer auditable, and none distinguishes
"there is nothing" from "I could not check". Those are the same output in every one of them.

## License

MIT. See [LICENSE](LICENSE).
