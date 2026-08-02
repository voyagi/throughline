# ADR 0001: Stack and deployment target

Status: accepted
Date: 2026-08-02

## Context

Throughline is an incident-response agent with an auditable memory layer. It needs:

- CockroachDB as the system of record for memory, reached over the Postgres wire protocol and over
  the CockroachDB Cloud managed MCP server.
- AWS carrying the runtime, because the AWS service has to be load-bearing rather than decorative.
- A public demo URL that stays up and stays cheap, reachable by anyone with no credentials.
- Content pages that score well on Lighthouse and are readable by search engines.
- A console that streams agent output next to a live memory pane, which is genuinely interactive.
- A memory layer that is testable on its own, with no web framework in its import graph.

Those last two pull in opposite directions. Content pages want static HTML. The console wants a
component runtime. A framework chosen for one is a compromise for the other.

## Decision

An npm workspaces monorepo with four packages and a clean import direction.

| Package | Contents | Depends on |
|---|---|---|
| `packages/memory` | The memory layer: schema, migrations, capability probe, recall pipeline, deterministic scoring, eviction, receipts. Plain TypeScript plus `pg`. | nothing in this repo |
| `apps/api` | Hono HTTP app: agent loop, tool surface, rate limiting, health. Runs as a Node server locally and as a Lambda handler in AWS. | `packages/memory` |
| `apps/web` | Astro static site plus Preact islands for the console and the inspector. | nothing in this repo |
| `infra` | AWS CDK v2 app describing every deployed resource. | nothing in this repo |

`packages/memory` importing anything from `apps/` is a dependency-cruiser error, not a convention.
The memory layer is the artifact being judged; it does not get to depend on the demo around it.

Deployment: one CloudFront distribution with two origins. S3 serves the built Astro output. A
Lambda Function URL serves `/api/*`. The Function URL is set to `AWS_IAM` auth with Origin Access
Control, so the API cannot be called directly, only through the distribution. One domain, no CORS,
one place to rate limit.

AWS services in the runtime path: Lambda, S3, CloudFront, Bedrock, Secrets Manager, EventBridge.
The requirement is one; six are load-bearing.

## Why Astro rather than Next.js or SvelteKit

- The site is mostly content. Astro ships zero JavaScript for those pages by default, which is the
  difference between a Lighthouse score that is claimed and one that is measured.
- Islands keep the interactive surface small and explicit. The console is an island, the inspector
  is an island, and nothing else pays for a runtime.
- Full control of the markup matters here, because the design bar is the hardest part of this build
  and a component library's defaults are exactly the look being avoided.
- Next.js on Lambda means an adapter layer between us and the runtime for no benefit we need.
  SvelteKit would be a fair choice and loses on the content half.

Preact rather than React for the islands: same API, a fraction of the bytes, and the islands are
small enough that nothing in the React ecosystem is missed.

## Why Lambda rather than App Runner, ECS or Amplify

- App Runner and ECS Fargate bill continuously with no free tier. A demo that has to survive two
  weeks of judging should not have a meter running.
- Lambda's free tier is permanent rather than a twelve month trial, and the demo's traffic profile
  is bursty, which is the shape Lambda is good at.
- Amplify Hosting would cover the static half and still leave the API on Lambda, so it adds a
  service without removing one.

The known cost of this choice is cold starts and connection churn against CockroachDB. Both are
handled rather than ignored:

- A module-scope `pg` pool with a small maximum is created once per execution environment and
  reused across invocations. Handlers never open their own connections.
- An EventBridge rule invokes a lightweight warm path every five minutes. That is roughly 8,600
  invocations per month against a one million invocation free tier, and it keeps both the Lambda
  execution environment and its database connection warm through a judging window.
- The warm path exercises a real query, not a no-op, so a warm Lambda with a dead connection is a
  detectable state rather than a silent one.

## Local development

CockroachDB runs in Docker from the `cockroachdb/cockroach` image. The whole memory layer,
including migrations, the capability probe, recall and eviction, is buildable and testable with no
cloud account. Moving to CockroachDB Cloud is a connection string and an MCP credential, not a
rewrite. This matters because the cloud accounts are owner-provisioned and the build starts before
they exist.

## Consequences

- Four workspaces means more configuration than a single app. The boundary is worth it: the memory
  layer can be read, tested and criticised without the demo in the way.
- CDK means the owner runs `cdk bootstrap` once. That is three documented commands against a
  deploy story that is inspectable and reproducible.
- Static Astro plus a separate API means the console fetches its data. There is no server-rendered
  first paint of live memory. Acceptable: the console is an application surface, not a landing page.

## What was not independently reviewed

This decision was written after live research. A second opinion from a different model family was
attempted on 2026-08-02 and refused by a usage guard, so the cold-start and connection-reuse
reasoning here has not been checked by anything outside this repo. Re-examine it when the first
real deployment produces measurements, rather than treating it as settled.

The code in the first commit was reviewed adversarially and the review found five significant
issues, all fixed before anything was pushed. Two of them were quality gates that reported clean
while protecting nothing. That record lives in `docs/gates.md`.
