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
- 99 tests, including property tests and several written specifically to go red if a protection is
  removed.
- The quality gate chain, with a written record of which gates have actually been proven to fail
  in [docs/gates.md](docs/gates.md).

Not built yet:

- The repository layer: remembering, superseding and evicting against real rows.
- The agent, the HTTP surface and the Bedrock adapter.
- The web console, the memory inspector and the status page.
- The deployed stack and the public demo URL.

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

`npm run probe` is the one to run first against any new cluster. It reports the server version, the
embedding column width, whether vector indexing is available, and whether the planner really uses
the index, each as an observation or an explicit unknown. It exits non-zero when there is no usable
retrieval path, because a probe that called that state a success would be committing the exact
error this system exists to catch.

The memory layer's logic runs and is tested with no database and no cloud account, using a
deterministic local embedder. That embedder captures lexical overlap only, and it is never a silent
fallback for a failed hosted embedder: a recall that could not embed returns coverage UNKNOWN.

Copy `.env.example` to `.env` to change anything. Every value there has a working local default
except the ones marked OWNER.

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

## Development disclosure

This project was built with AI assistance (Claude). It was created from scratch for the CockroachDB
and AWS agentic memory hackathon and contains no pre-existing code from earlier work. Third-party
dependencies are declared in the lockfile and carry their own licenses.

## License

MIT. See [LICENSE](LICENSE).
