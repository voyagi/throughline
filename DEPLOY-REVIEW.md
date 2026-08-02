# Deploy review

Written before anything is started or deployed, and updated before each new target. Two targets
exist: a local database container, and the AWS stack. Only the first is live at the moment.

## Target 1: local CockroachDB container (docker compose)

Command: `docker compose up -d`. Defined in `docker-compose.yml`.

| Item | Value |
|---|---|
| Image | `cockroachdb/cockroach:v26.2.2` |
| Process | `start-single-node --insecure` |
| Published ports | `127.0.0.1:26257 -> 26257` (SQL) and nothing else |
| Admin UI port | Deliberately NOT published |
| Binding address | Loopback only. The container port is reachable from this machine and from nowhere else |
| Firewall change | None. No inbound rule is added, and none is needed because nothing listens off loopback |
| Data | A named docker volume, `crdb-data`. Seeded demo incidents only. No personal data, no credentials, nothing from any other project |
| Authentication | None, and that is the reason for every restriction above |

Why insecure mode is acceptable here and nowhere else: the node is unreachable from the network,
it holds only seeded demo content, and the alternative (generating and managing certificates for a
throwaway local node) buys no real security while adding a failure mode. The moment this points at
CockroachDB Cloud instead, authentication and TLS come from the cluster and this file gets a
second section.

Residual risk, stated plainly: any process already running as this user on this machine can reach
the database with no password. That is the same trust boundary as the source tree itself, so it
adds no new exposure. Anything wider than loopback would.

To stop and remove it: `docker compose down`. To also discard the data: `docker compose down -v`.

## Target 2: AWS stack (not yet deployed)

Nothing is deployed. When it is, this section gets filled in before `cdk deploy` runs, and the
review covers at minimum: the CloudFront distribution and its origins, the Lambda Function URL auth
mode and its Origin Access Control, every IAM policy attached to the execution role, which
secrets exist and where they live, the Bedrock invocation permissions, and the budget alarm.

Two commitments recorded now so they are not decided under deadline pressure:

- The budget alarm is armed BEFORE the first Bedrock call, not after the first bill.
- The Lambda Function URL is never left on `NONE` auth "just to test it". A publicly callable
  function that talks to a database and a paid model is the exact shape of an expensive mistake.
