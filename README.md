# Abid Review — Runtime-Aware AI Code Review for Azure DevOps

> An AI reviewer that thinks like a senior Angular engineer, not a chatbot stapled to a diff.

Most "AI code reviewers" send the diff to an LLM and post whatever comes back. They miss runtime behavior, misunderstand Angular's lifecycle, over-comment, and burn developer trust in a week.

**Abid Review is different.** It combines:

1. **Static AST analysis** of TypeScript + Angular templates *together* (not separately).
2. **Runtime instrumentation** via Chrome DevTools Protocol — actual render counts, real subscription lifetimes, real heap growth.
3. **Repository-wide context** — dependency graph, call graph, resolver guarantees, type guarantees.
4. **Confidence scoring** — only high-confidence findings become comments. Everything else stays internal.
5. **Aggressive deduplication** — one comment per logical issue, with sibling locations listed inline.
6. **Plain English voice** — sounds like a friendly senior teammate, not a compliance checklist.

The product is opinionated about *what not to say*. Most reviewers fail not because they miss bugs, but because they ship noise. Abid Review's primary KPI is **comments-merged-without-pushback / total-comments-posted**.

---

## What it understands that other reviewers don't

- **Template + TS cross-binding.** If `user.name` appears in HTML without `?`, but the TS has a resolver guaranteeing `user`, Abid Review does *not* report a null-check false positive.
- **Signals vs RxJS vs NgRx.** Subscription leaks in a component without `takeUntilDestroyed` are real; the same pattern inside an effect is not.
- **Change detection cost.** Method calls in templates with OnPush + signals are usually fine. The same call in default change detection on a frequently-updated parent is a real performance problem.
- **IndexedDB cache staleness.** Tracks read-after-write race conditions against the cache layer.
- **Resolver guarantees.** If a route resolver guarantees a non-null value, downstream `?.` chains are flagged as *unnecessary* — but only with high confidence.

## Repository layout

```
abid-code-review/
├── docs/                          # Architecture, deployment, security, roadmap
├── apps/
│   ├── webhook-gateway/           # Receives Azure DevOps PR webhooks
│   ├── orchestrator/              # Pipeline coordinator
│   ├── runtime-runner/            # Playwright + CDP runtime tracer
│   └── api/                       # Internal results API
├── packages/
│   ├── core/                      # Shared types
│   ├── git-diff-engine/           # Diff parsing + exact line mapping
│   ├── ast-engine/                # ts-morph + Angular template AST
│   ├── repo-context-engine/       # Dependency + call graph
│   ├── angular-analyzer/          # Angular-aware static rules
│   ├── runtime-instrumentation/   # CDP tracing primitives
│   ├── memory-analyzer/           # Heap + listener leak detection
│   ├── confidence-engine/         # Per-finding confidence scoring
│   ├── deduplication-engine/      # Cross-file clustering
│   ├── llm-mistral/               # Mistral client + prompt orchestration
│   ├── azure-devops/              # PR API + comment poster
│   └── findings/                  # Finding schema + rule registry
├── prompts/                       # Versioned prompt templates
└── infra/                         # Docker, K8s, Terraform
```

## Start here

- [docs/ARCHITECTURE.md](docs/ARCHITECTURE.md) — the full system design.
- [docs/ROADMAP.md](docs/ROADMAP.md) — MVP → Enterprise → VSCode.
- [docs/DEPLOYMENT.md](docs/DEPLOYMENT.md) — how it runs in production.
- [docs/SECURITY.md](docs/SECURITY.md) — threat model.
- [docs/COMMENT_VOICE.md](docs/COMMENT_VOICE.md) — the writing style rules.
