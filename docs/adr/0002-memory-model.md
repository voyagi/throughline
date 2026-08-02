# ADR 0002: The memory model, and what it refuses to do

Status: accepted
Date: 2026-08-02

## Context

Every agent memory product optimises recall quality. Mem0 ships three memory scopes and a hosted
API. Zep builds a temporal knowledge graph and posts 63.8 percent on LongMemEval where Mem0 posts
49.0. Letta makes the agent's memory the runtime itself. Cognee builds a graph from documents.
Those are real products with real funding and they are better at breadth than anything built in
sixteen days.

Competing on recall quality is therefore a losing move. The gap they leave is different, and it is
a gap you only notice after operating a memory system rather than benchmarking one.

None of them makes a recall answer AUDITABLE, and none of them distinguishes "there is nothing"
from "I could not check". Those are the same output in every system above, and they are opposite
facts. During an incident that difference is a safety property.

## The three failures this model is designed around

1. **A fact that stopped being true.** A runbook step is correct until a migration lands, and then
   it is confidently wrong. Nothing in a plain embedding store records that.
2. **Absence of evidence reported as evidence of absence.** The embedding call times out, the index
   is missing, the query is cut short, and the agent says "no prior incidents". A caller cannot
   tell that from a genuine empty result.
3. **Eviction that eats the newest entries.** Value-scored eviction ranks by usage. A memory
   written four minutes ago has no usage. The incident that just happened, which is the one most
   likely to recur this hour, is the first thing thrown away.

## Decision

### Memories are typed, and rejected hypotheses are memories

`observation`, `resolution`, `runbook_fact`, `rejected_hypothesis`, `entity_fact`.

The type is not decoration. It sets the half-life (below) and it changes what recall does with the
row. `rejected_hypothesis` exists because knowing what did NOT fix the outage is half the value of
an incident archive, and it is the first thing a summariser deletes.

### Every memory carries its own evidence

Content and embedding, plus: who or what asserted it and from which incident, when it was first
asserted and when it was last confirmed, how many times it has been confirmed and contradicted,
the interval over which it is claimed to hold, a pointer to whatever superseded it, the instant
before which it cannot be evicted, and its tombstone state if it has been evicted.

A write with no provenance is rejected at the boundary. Not warned about, rejected.

### Superseding, never overwriting

Writing a fact that contradicts an existing one closes the old row's validity interval and links
the two. The old row stays queryable with its end date. An agent that was right in June and wrong
in August should be able to show both, because "why did you tell me that" is a question incident
reviews actually ask.

### Scoring is deterministic

Recall combines vector similarity, structured filters, recency, confirmation count and type
half-life into a single score computed in code. The language model writes the narrative around the
result. It never produces the number that ordered the result.

This is a hard rule, taken from a previous build where an LLM was allowed to produce a figure that
gated a decision, and the figure could not be reproduced afterwards.

### Staleness is computed and flagged, not silently dropped

Each type has a half-life. An `entity_fact` like "the primary is host db-7" decays fast. A
`rejected_hypothesis` decays slowly, because "restarting the pods did not help" stays true. A
memory past its confidence floor is returned FLAGGED rather than hidden, because a stale memory a
human can see is safer than one that vanished without trace.

### Eviction has a grace window and leaves tombstones

Entries younger than the grace window cannot be evicted at any score. Eviction runs in a
transaction that writes a tombstone, so an evicted memory is auditable rather than absent. Every
run reports what it removed AND what it refused to remove and why.

This is the direct fix for failure 3. It is also the cheapest thing in the model to test: remove
the grace clause and a test must go red.

### Recall returns a receipt, and UNKNOWN is a first-class answer

Every recall returns, alongside the rows: the query, how many candidates were considered, which
retrieval path actually ran (approximate index or exact scan), what was excluded and under which
named rule, elapsed milliseconds, and a coverage verdict.

Coverage is one of COVERED, PARTIAL or UNKNOWN. UNKNOWN is returned when the search could not be
completed: the embedding provider failed, the query timed out, the capability probe found no
usable retrieval path. UNKNOWN is not an error to be swallowed and it is not an empty list.

The agent is structurally forbidden from converting UNKNOWN into "no prior incidents". The check
lives in the tool boundary, not in the prompt, because a prompt is a request and a boundary is a
guarantee.

Build state, so this ADR is not read as a description of finished code: the guard itself exists
(`assertAnswerable`, and a coverage sentence generated from the receipt rather than by the model).
The agent and the tool surface that will call them do not exist yet. An ADR states the decision;
`README.md` states what is built.

## What this buys that a chat-history table plus pgvector does not

One demonstration, and it is the reason the domain is incident response. Break retrieval on
purpose, then ask the agent whether this has happened before.

A conventional stack answers "I found no prior incidents", confidently, and it is wrong in the
most expensive way an on-call tool can be wrong. Throughline answers that it cannot tell, names
the reason, and shows the receipt.

That is not a schema difference. It is a protocol difference, and it survives being copied.

## Consequences

- More columns and more write-path work than a plain embedding table.
- Recall is more expensive, because exclusions have to be counted rather than filtered away
  silently. That cost is the feature.
- UNKNOWN propagating to the user interface means the interface has to have a real state for it.
  Designing that state is not optional polish.
- The model is opinionated about half-lives. Those numbers are configuration with defaults, and the
  defaults are guesses until real usage argues with them. They are recorded as such rather than
  presented as findings.
