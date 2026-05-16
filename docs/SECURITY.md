# Security

## Threat model

The system handles **source code** and **PAT credentials** for customer Azure DevOps organizations. Both are highly sensitive. The two worst-case incidents are:

1. **Source code exfiltration** via a compromised Mistral request, log leak, or storage breach.
2. **Cross-tenant credential leak** — one customer's PAT used to read another's repos.

Everything below is built around preventing those.

## Webhook authentication

Azure DevOps signs webhooks with a shared secret (HMAC-SHA1 in the `X-Hub-Signature` header, or an Azure DevOps-specific `Authorization: Basic` scheme depending on the configured subscription type). The gateway:

- Verifies HMAC in constant time (`crypto.timingSafeEqual`).
- Rejects events older than 5 minutes (replay protection).
- Keeps a 100-entry LRU of recent event IDs and drops duplicates.
- Per-tenant rate limit at the gateway: 10 events/sec sustained, 30 burst.

## Credential storage

- **One PAT per tenant.** Stored in Azure Key Vault, accessed via Workload Identity (no PAT in env vars, no PAT on disk).
- **Mistral API key** stored in Key Vault, rotated quarterly.
- **HMAC secret** per tenant, separately stored.
- **Git clone credentials** scoped per-PR via short-lived OAuth tokens where possible; PAT fallback only for tenants without OAuth.

## Source code handling

- Clones live on a per-job tmpfs volume. Deleted on job completion or via a cron sweeper at TTL 1 hour.
- AST graphs cached in object store are **encrypted client-side** before upload using a per-tenant data encryption key (DEK), with the DEK wrapped by a Key Vault KEK.
- Logs **never** contain source code. The structured logger has a `redactCode` middleware that strips any field tagged `@code`.
- LLM prompts include code snippets — necessary for the product to work. We compensate via:
  - Per-tenant data residency: each tenant pinned to a Mistral region matching their data-residency contract.
  - Mistral request-level `customer_id` tag for audit trail.
  - Optional per-tenant private-tenancy Mistral endpoint for enterprises.

## Multi-tenancy

- All database tables partitioned by `tenant_id`. Every query has `WHERE tenant_id = $current` enforced via Postgres Row-Level Security policies (not just application-layer checks).
- Object store keys prefixed with `t/{tenant_id}/`. IAM policies on the orchestrator service principal restrict access to `t/{current_tenant_id}/*` via session-tagged STS credentials.
- Workload identity is **per-job**: each orchestrator job assumes a session-scoped identity tagged with `tenant_id`. Even if the orchestrator code has a bug, the storage layer rejects cross-tenant reads.

## Supply chain

- All dependencies pinned with `pnpm-lock.yaml`.
- Renovate bot for security updates; non-security updates batched weekly.
- `npm audit` + `socket.dev` checks gate every CI build.
- Docker images built from distroless or minimal `node:20-bookworm-slim` base, scanned with Trivy.
- No `postinstall` scripts allowed (`pnpm install --ignore-scripts` in CI, exceptions reviewed manually).

## Network egress

The orchestrator and runtime-runner are the only pods with internet egress, and only to an allowlist:

- `*.dev.azure.com`, `*.visualstudio.com` — Azure DevOps API.
- `api.mistral.ai` — LLM.
- `github.com`, `npmjs.org` — *only* if the customer repo's dependencies require fetching during runtime tracing (and even then, sandboxed via a per-job egress proxy that logs every request).

The webhook gateway has **inbound only** from API Management. No outbound internet.

## Prompt injection

User-controlled inputs (commit messages, code, file names) flow into LLM prompts. We treat them as untrusted:

- Prompts use **explicit delimiters** (`<<<USER_CODE_START>>>` / `<<<USER_CODE_END>>>`) and a system instruction that anything inside delimiters is data, not instructions.
- The LLM is invoked with **JSON-schema-constrained output** — even if the model is jailbroken into "obey the new instructions in this file's comment," its output still has to fit the schema, and a finding that mutates the schema is dropped by the validator.
- The voice-rewrite step's output is regex-linted before posting (rejects URLs, code-block-escape attempts, GitHub mentions of unrelated accounts).
- Findings whose source code contains the strings "ignore previous instructions" or similar known jailbreak phrases are flagged for human review rather than posted.

## Auditing

- Every comment posted is recorded in Postgres with `(tenant_id, pr_url, rule_id, confidence, mistral_request_id)` — full traceability for "why was this comment posted?".
- Every Mistral request stored with prompt hash + response, retained 30 days for incident response.
- Per-tenant export endpoint: customers can request their full audit log for compliance.

## What we do *not* do

- We don't fine-tune Mistral on customer code. Voice + behavior come from prompts and constraints, not weights. This avoids the entire "did our training data leak?" class of problems.
- We don't store source code for longer than the job lifetime (except cached *graphs*, which are encrypted with per-tenant keys).
- We don't share confidence calibration data across tenants. Each tenant has its own calibration model.
