# Deployment

## Topology

```
                    Azure DevOps PR
                          │
                          │ webhook (HTTPS, HMAC-signed)
                          ▼
              ┌────────────────────────┐
              │   API Management /     │
              │   Azure Front Door     │
              │   (TLS, WAF, rate lim) │
              └───────────┬────────────┘
                          ▼
              ┌────────────────────────┐
              │   webhook-gateway      │   stateless · HPA · 2–10 pods
              │   (Node 20)            │
              └───────────┬────────────┘
                          │ XADD job
                          ▼
              ┌────────────────────────┐
              │   Redis Streams        │   primary queue
              │   (Azure Cache Redis,  │   consumer-group per orchestrator
              │   Enterprise tier)     │
              └───────────┬────────────┘
                          │ XREADGROUP
                          ▼
              ┌────────────────────────┐
              │   orchestrator         │   stateful per job · HPA · 4–40 pods
              │   - clones repo        │
              │   - runs static engine │
              │   - delegates runtime  │
              └────┬────────────┬──────┘
                   │            │
                   │            ▼
                   │   ┌──────────────────────┐
                   │   │  runtime-runner      │  Playwright/CDP · KEDA-scaled
                   │   │  (Linux, Chromium)   │  on runtime-jobs stream
                   │   └──────────────────────┘
                   │
                   ▼
              ┌────────────────────────┐         ┌──────────────────────┐
              │  Mistral API           │         │  Object store (S3 /  │
              │  (TLS, signed reqs)    │         │  Azure Blob)         │
              └────────────────────────┘         │  - repo graphs       │
                                                 │  - heap snapshots    │
                                                 │  - traces            │
                                                 └──────────────────────┘
              ┌────────────────────────┐
              │  Postgres              │   findings · feedback · calibration
              │  (Azure Postgres Flex) │
              └────────────────────────┘
```

## Containers

Every app is a multi-stage Docker build on `node:20-bookworm-slim` for size + glibc compatibility with Playwright's bundled Chromium.

- `webhook-gateway` — ~80 MB, stateless. Liveness `/healthz`, readiness `/readyz`.
- `orchestrator` — ~200 MB + cloned repo + AST graph (5–500 MB depending on repo). Stateful per job, stateless across jobs.
- `runtime-runner` — ~1.2 GB (includes Chromium). Always memory-pressured; we constrain with `cgroup` memory limits and let OOM kills happen rather than buffer-bloat the heap.
- `api` — internal results API + dashboards.

## Kubernetes

- Namespace `abid-review`.
- HPA on CPU + custom Redis-queue-length metric (KEDA).
- PodDisruptionBudget: minAvailable=1 for gateway, 2 for orchestrator.
- NetworkPolicy: only `webhook-gateway` reaches the internet ingress; only `orchestrator` egress-allowed to `mistral.ai` (via outbound IP allowlist).
- Secrets: Azure Key Vault via CSI driver (Mistral API key, ADO PAT per tenant, HMAC secret).

## Scaling levers

| Bottleneck                  | Lever                                                          |
| --------------------------- | -------------------------------------------------------------- |
| Webhook spikes              | HPA on `webhook-gateway`, async enqueue                        |
| Orchestrator concurrency    | Increase Redis consumer-group consumers                        |
| Mistral latency             | Per-tenant token bucket, batch findings into one LLM call      |
| Runtime-runner cold start   | Warm pool (kept at min 2 idle, pre-launched Playwright)        |
| Monorepo AST cost           | Repo graph cache (S3) + incremental update on PR-only          |
| Heap snapshot storage       | TTL 7 days on object store with lifecycle policy               |

## Repo graph cache

The single biggest cost saver. Without it, each PR re-builds the full project graph (10–60s on a large Angular monorepo). With it:

- Key: `sha256(repo_url + commit_sha)` → object store path.
- On PR open: fetch base-SHA graph (likely already cached from a prior PR). Apply diff. Cache head-SHA result.
- LRU on cache: keep the last `N` SHAs per repo, plus `main`'s last 30 days.

## Observability

- **Logs:** structured JSON, one log line per finding decision (`rule_id`, `confidence`, `posted | summarized | dropped`, `reason`). Searchable in Grafana Loki.
- **Metrics (Prometheus):**
  - `findings_total{rule_id, posted}` counter
  - `confidence_histogram{rule_id}`
  - `pr_pipeline_duration_seconds{stage}` histogram per stage
  - `mistral_tokens_total{tenant, purpose}` cost tracking
  - `runtime_runner_duration_seconds{scenario}`
- **Traces:** OpenTelemetry, one trace per PR review, spans per pipeline stage.

## Cost model (rough)

Per medium PR (~10 changed files, ~500 LOC):

| Item                         | Rough cost  |
| ---------------------------- | ----------- |
| Orchestrator CPU             | ~$0.001     |
| Mistral tokens (cached repo) | ~$0.02–0.05 |
| Runtime runner (if invoked)  | ~$0.05      |
| Storage / network            | negligible  |
| **Total**                    | ~$0.07/PR median |

Heavy PRs that trigger full runtime tracing: ~$0.30. Cap per repo per day to prevent runaway costs.

## Disaster recovery

- Redis Streams replicate to a secondary region (Azure Cache Redis Geo-replication).
- Object store cross-region replication on the repo-graph bucket only (others are recreatable).
- Postgres point-in-time-restore retention 7 days.
- Webhook gateway is the only stateful-from-the-outside component; replay is supported by the gateway storing the last 100 event IDs and dropping duplicates.
