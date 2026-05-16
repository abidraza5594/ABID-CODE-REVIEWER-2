# Contributing & local development

## Prerequisites

- Node 20.10+
- pnpm 9+
- Docker (for runtime-runner local test) and a local Redis (`docker run -p 6379:6379 redis:7-alpine`)
- A Mistral API key for live LLM steps. For local dev without a key, set `ABID_FAKE_EMBED=1` to bypass embedding calls; the false-positive filter + voice rewrite still require Mistral access.

## First-time setup

```sh
pnpm install
pnpm build
```

This builds every package and app via TypeScript project references.

## Running locally

```sh
# Terminal 1 — local Redis
docker run --rm -p 6379:6379 redis:7-alpine

# Terminal 2 — webhook gateway
REDIS_URL=redis://localhost:6379 \
  ABID_TENANTS_JSON=$(pwd)/infra/dev/tenants.example.json \
  pnpm dev:gateway

# Terminal 3 — orchestrator
REDIS_URL=redis://localhost:6379 \
  ABID_ADO_PAT=... \
  MISTRAL_API_KEY=... \
  ABID_PROMPTS_DIR=$(pwd)/prompts \
  ABID_FAKE_EMBED=1 \
  pnpm dev:orchestrator
```

You can POST a synthetic envelope to the gateway:

```sh
curl -u ado:change-me-locally -H 'content-type: application/json' \
  --data @infra/dev/synthetic-pr.json \
  http://localhost:8080/webhook/abid-dev
```

## Testing

```sh
pnpm test
```

Unit tests live next to source as `*.test.ts`. Integration tests against a
live Mistral key live in `tests/integration/` and are gated by `ABID_RUN_INTEGRATION=1`.

## What to read first

- [docs/ARCHITECTURE.md](docs/ARCHITECTURE.md) — the full system design.
- [docs/COMMENT_VOICE.md](docs/COMMENT_VOICE.md) — *the* product-defining doc.
- `packages/angular-analyzer/src/rules/*` — one rule per file. Copy-paste a similar one as a starting point for a new rule.

## How to add a new rule

1. Add `packages/angular-analyzer/src/rules/<name>.ts` exporting a `const fooRule = { ... } as const;`.
2. Register it in `packages/angular-analyzer/src/registry.ts`.
3. Add unit tests next to it.
4. Add a calibrated `basePrecision` based on a hand-labelled sample of ~30 examples.
5. Open a PR with the calibration data in `tests/fixtures/calibration/<rule_id>/`.
