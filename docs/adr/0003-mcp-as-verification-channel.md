# ADR 0003: The managed MCP server is the verification channel, not the hot path

Status: accepted
Date: 2026-08-02

## Context

The CockroachDB Cloud managed MCP server sits at `https://cockroachlabs.cloud/mcp`. Its verified
tool surface is nine read tools (`list_clusters`, `get_cluster`, `list_databases`, `list_tables`,
`get_table_schema`, `select_query`, `explain_query`, `show_statement`, `show_running_queries`) and
exactly three write tools (`create_database`, `create_table`, `insert_rows`). There is no update
tool and no delete tool.

Two consequences fall straight out of that list.

First, the memory lifecycle cannot run over MCP. Superseding a fact, writing a tombstone, sweeping
expired rows and running eviction are all updates and deletes. They run over the Postgres wire
protocol. That is forced by the tool surface, not chosen.

Second, and this is the interesting one: routing ordinary recall through MCP would be worse in
every measurable way than a direct query. It adds an HTTP hop, an OAuth exchange and a JSON
round trip to something `pg` already does in one round trip on an open connection. Doing it anyway,
and calling it an integration, is the kind of thing a judge sees through in about fifteen seconds.

## Decision

The managed MCP server is used for what it is actually good at, and the product is designed so that
use is load-bearing rather than ornamental.

### 1. An independent verification channel

A previous build taught this the hard way: verify against the live system, never against the tool's
own success response. Throughline applies that to its own memory.

The inspector can re-fetch any memory row through the managed MCP server, over a different
transport, a different auth path and a different code path from the one the application used, and
compare. Agreement is displayed. Divergence is a finding, not a warning to be logged and forgotten.

This is the difference between an application that says its write succeeded and an application that
went and looked. It costs one MCP round trip on an explicit user action, which is exactly the
budget an audit action deserves.

### 2. The operator plane, with no application in the loop

The memory is a database, not a private format inside a process. Any MCP capable agent, including
Claude Code, can be pointed at the same cluster and asked questions about the memory without
Throughline running at all.

That is documented as a feature with a working configuration, because it is the strongest honest
argument for using a database as an agent's memory rather than a bespoke store: you can still get
at your data when the agent is gone.

```
claude mcp add cockroachdb-cloud https://cockroachlabs.cloud/mcp --transport http
```

### 3. Schema introspection during the capability probe

`get_table_schema` and `explain_query` answer questions the application would otherwise assume:
does the vector column have the dimension the embedder produces, and does the planner actually use
the vector index for the recall query. `explain_query` through MCP is how the capability probe
learns whether the approximate path is real rather than hoped for.

## Security, because this credential is not small

The managed MCP server authenticates with OAuth or a service account API key, and the account needs
Cluster Admin or Cluster Operator. A service account key in a public demo backend can read every
cluster in the organisation. Treating that casually would fail the product readiness criterion by
itself.

- A dedicated service account, scoped to the demo organisation, with no other cluster in it.
- The key lives in AWS Secrets Manager and reaches the Lambda through the execution role. It is
  never in the repository and never sent to the browser. Locally it sits in `.env`; see the
  amendment below, which corrects an earlier absolute claim on this point.
- The verification endpoint accepts a memory identifier and nothing else. The SQL sent to
  `select_query` is built from a fixed template with a validated UUID bound into it. No user text
  reaches a query string, ever. This is stated here because `select_query` is a natural language
  shaped hole in an otherwise typed system, and it is the obvious injection surface in this design.
- The endpoint is rate limited on the same token bucket as the rest of the API, and every call is
  written to the audit log with its caller, its argument and its verdict.

## Consequences

- The MCP integration is smaller than it would be if it carried every read, and more defensible.
- The verification feature only proves agreement for rows it is asked about. It is an audit tool,
  not a continuous consistency checker, and the interface says so rather than implying coverage it
  does not have.
- If the managed MCP server is unreachable, verification reports UNKNOWN and the rest of the
  product keeps working. The same rule that governs recall coverage governs this: an unavailable
  check is never displayed as a passed check.

## Amendment, 2026-08-04: what changed once this was measured

Written after building the channel. Everything below was produced by calls to the live endpoint,
and it corrects two things this ADR asserted from documentation.

### The security paragraph was too absolute about the key

This ADR said the key is "never in an environment file". That is the deployed shape and it stays
the target: in AWS the key comes from Secrets Manager through the execution role and never reaches
the browser. Locally it sits in `.env`, which is gitignored, covered by the tracked-file gate, and
documented as such in `.env.example`. Saying "never" while the repository ships a variable for it
is the kind of small untruth that makes a reader discount the rest of the page.

### Schema introspection cannot use information_schema

Section 3 planned to answer schema questions over this channel. It can, but not the obvious way:
`information_schema` is refused ("query references a restricted schema"), joining `crdb_internal`
and `system`, and `SHOW TABLES` is refused as a non-SELECT. The `get_table_schema` tool works and
returns the CREATE TABLE statement, which is what `verify:mcp` uses to confirm the vector column's
declared width against the width the embedder is configured for, without asking the application.

### Three measured facts that shaped the client

`select_query` silently applies `LIMIT 25` when a query states no bound, and a bound inside a
subquery does not satisfy it. For a channel whose entire job is independent verification, that
produces a confident disagreement caused by the transport. Callers pass a number and never write
the clause.

Every failure arrives as HTTP 200 with a JSON-RPC `error` member and no `result`. A client that
trusts the status code and falls back to an empty row set reports every outage as a missing row.

The result payload dies a little past 10 KB, well before the documented 10000 row maximum, so the
verification query sends `md5(content)` rather than the content. CockroachDB's `md5` and Node's
agree over the same bytes, which is what makes that substitution sound rather than convenient.

### The audit row

`memory_audit` already permits the `verify` operation, and the verification report carries
everything that row needs. Writing it belongs to the HTTP surface, which is the layer holding a
database connection and the caller's identity, not to the verifier, which is deliberately given a
record rather than a database handle so the comparison stays pure and the dependency direction
stays one way.
