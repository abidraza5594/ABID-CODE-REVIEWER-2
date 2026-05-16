# Roadmap

Three tracks: **MVP**, **Enterprise**, **VSCode**. The tracks share infrastructure but ship at different cadences.

---

## MVP (8 weeks) — credible AI reviewer for one Angular repo

**Goal:** prove the voice + false-positive rate. Ship to *one* internal Angular repo with developer trust as the only metric.

### Week 1–2 — foundation

- Monorepo scaffold (`pnpm` workspaces, TS project references).
- `packages/core` types (`Finding`, `Evidence`, `Guarantee`, `Location`).
- `packages/git-diff-engine` — diff parsing + line map.
- `packages/azure-devops` — webhook verify + thread comment poster.
- `apps/webhook-gateway` — receive webhook, enqueue job (Redis Streams).

**Demo:** push to PR → see a hardcoded "hello from Abid Review" comment on the right line.

### Week 3–4 — AST engine + first real rule

- `packages/ast-engine` — ts-morph wrapper + Angular template parser.
- Cross-binding resolver (template binding → TS symbol → type).
- `packages/angular-analyzer` rule: subscription leak detection.
  - This is the rule we calibrate everything else against. Pick it because it's high-value and has clear true/false-positive boundaries.
- `packages/confidence-engine` — initial weights, threshold at 0.75.
- `packages/llm-mistral` — voice rewrite + false-positive filter.

**Demo:** open a PR with a real subscription leak → high-confidence comment, no false positives on 5 sample PRs.

### Week 5–6 — second rule wave + dedup

- Rules: null-without-guard (with resolver awareness), template method-call under default CD, `trackBy` missing on `*ngFor`.
- `packages/repo-context-engine` — import graph + resolver registry.
- `packages/deduplication-engine` — exact + semantic clustering.
- PR summary post (one summary thread per PR, updated on each iteration).

**Demo:** PR that touches 5 files with the same issue → 1 comment with siblings listed.

### Week 7–8 — pilot

- Deploy to staging Azure (1 webhook gateway, 1 orchestrator pod, 1 Redis).
- Run silent mode on a real Angular repo for 1 week: comments are generated but routed to an internal channel, not the PR.
- Calibrate thresholds against the silent-mode dataset.
- Flip the switch: post on real PRs.
- Daily retrospective with the pilot team for 2 weeks.

**Exit criteria:** ≥ 70% of posted comments resolved by the author without "this isn't a real issue" pushback.

---

## Enterprise (months 3–6) — runtime intelligence

### Runtime instrumentation

- `apps/runtime-runner` — Playwright + CDP, scriptable scenarios.
- `packages/runtime-instrumentation` — Angular profiler hook, RxJS subscription tracking, signal update counting.
- `packages/memory-analyzer` — heap snapshot diffing, detached DOM detection.
- Runtime-aware rules: actual render counts, real subscription leaks, real heap growth.

### Scale

- Repo cache layer: project graphs stored per `(repo, sha)` in S3-compatible object store.
- Incremental graph updates: invalidate only affected subgraphs on each PR.
- Parallel rule execution: rules are pure functions over typed AST, embarrassingly parallel.
- Job priority queue: small PRs ahead of monorepo rebuilds.

### Multi-repo + multi-team

- Per-repo `abid-review.config.ts`: enable/disable rules, set thresholds, declare runtime scenarios.
- Per-team voice tuning: glossary, banned terms, severity overrides.
- Dashboards (`apps/api`): findings over time, comment resolution rate, false-positive feedback loop.

### Feedback loop

- "Was this useful?" reaction buttons on every comment (via ADO thread emoji).
- Authors can reply `@abid not-useful` and we use it as a negative training signal for the confidence calibrator.
- Weekly automatic threshold recalibration per rule.

---

## VSCode (months 4–8) — pre-PR feedback

The PR reviewer ships first because it has a clean API surface. The VSCode extension comes after the rule pack is calibrated.

### VSCode extension

- Reuses every `packages/*` engine. The extension is a thin host that wires engines to VSCode diagnostics + code actions.
- On save: run static engines locally, show diagnostics squiggles.
- "Run runtime check" command: spawns local Playwright in the background, attaches CDP, runs the scenario closest to the changed component (heuristic: nearest `*.spec.ts` or last manually-run scenario).
- Code actions for fixes the rule engine can autofix (e.g., add `takeUntilDestroyed`, add `trackBy`).
- Shares calibration data with the cloud service (opt-in).

### Why this is hard

- Local performance budget is tighter than CI. The AST engine must be incremental and persistent across editor sessions.
- Runtime tracing during development is intrusive. We default it off and require explicit user invocation.
- Diagnostics that are noisy in the editor destroy trust faster than noisy PR comments. The threshold for editor diagnostics is **higher** than for PR comments (≥ 0.85, vs. ≥ 0.75).

---

## Non-goals (deliberately)

- **GitHub support in MVP.** Adding GitHub is straightforward (different webhook format, different comment API) but the value is in Angular intelligence, not platform coverage. We add it after the rule pack is calibrated.
- **Non-Angular framework support.** Vue, React, Svelte — all in scope eventually, but Angular-first because that's where the runtime intelligence pays off most (lifecycle, change detection, signals, RxJS).
- **General code-style review.** ESLint and Prettier do this well. We don't compete with them.
- **Architecture review.** We don't flag "this should be a separate module." That's a human conversation.
