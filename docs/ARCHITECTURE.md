# Architecture

## Design principles

1. **Static is cheap, runtime is gold.** Static analysis runs on every PR. Runtime analysis runs only when static analysis says "this *might* be a problem" — never as a fishing expedition.
2. **Confidence is a first-class property of every finding.** A finding without a confidence score is a bug.
3. **Cross-evidence beats single-source.** A finding backed by AST + type-checker + runtime trace is reported. AST-only findings with no corroboration are downgraded.
4. **The LLM does not invent findings.** Findings come from rules and instrumentation. The LLM *explains* them in human voice and *judges* whether existing code already guards against them.
5. **One issue, one comment.** Dedup happens before posting. Sibling locations are bullet-listed inline.

## High-level flow

```
        ┌──────────────────────────────────────────────────────────────┐
        │                      Azure DevOps PR                          │
        └──────────────────────────────┬───────────────────────────────┘
                                       │ webhook
                                       ▼
        ┌──────────────────────────────────────────────────────────────┐
        │                    Webhook Gateway                            │
        │      verify HMAC · dedupe events · enqueue review job         │
        └──────────────────────────────┬───────────────────────────────┘
                                       │ job
                                       ▼
        ┌──────────────────────────────────────────────────────────────┐
        │                       Orchestrator                            │
        │                                                                │
        │  1. clone PR + base                                            │
        │  2. git-diff-engine → changed-line map                         │
        │  3. ast-engine → typed AST (TS + Angular templates)            │
        │  4. repo-context-engine → import graph, call graph,            │
        │                            resolver registry, signal graph    │
        │  5. angular-analyzer → static findings (per rule)              │
        │  6. confidence-engine → score every finding                    │
        │  7. need-runtime-evidence? → runtime-runner                    │
        │  8. dedup-engine → cluster findings                            │
        │  9. llm-mistral → rewrite each cluster into plain English,     │
        │                   verify guarantees, filter false positives   │
        │ 10. azure-devops → post inline comments + PR summary           │
        └──────────────────────────────────────────────────────────────┘
```

## Components

### 1. Git Diff Engine — `packages/git-diff-engine`

**Job:** turn a PR diff into an *exact-line map* the rest of the system can trust.

Most reviewers post on "the closest changed line" — that's how comments end up two lines off. The diff engine:

- Parses unified diffs into hunks.
- Builds a bidirectional map: `(file, base_line) ↔ (file, head_line)`.
- Tracks line *intent*: `added | removed | context | moved`.
- Provides `line.isPostable()` — true only for lines visible in the head revision *and* inside an added/modified hunk. Never returns deleted lines.
- Reconstructs multi-line spans (function bodies, template fragments) for findings that need range posting.

### 2. AST Engine — `packages/ast-engine`

Two parsers, one unified output:

- **TypeScript:** `ts-morph` wrapping the TypeScript Compiler API. We need `getTypeChecker()` and `getSignaturesOfType()`, so a thin wrapper isn't enough — we keep the full project graph in memory.
- **Angular templates:** `@angular/compiler`'s template parser produces a real AST (not regex matching). Pipes, structural directives, interpolations, two-way bindings, `@if/@for` (control flow), and signal calls all become typed nodes.

**Cross-binding.** This is the engine's headline feature. For each template binding, we resolve:

- which `*.ts` symbol it refers to
- the symbol's TypeScript type
- whether a resolver/guard guarantees non-null
- whether a signal has a default value
- whether an observable is wrapped in `async` pipe with `*ngIf` null-guard upstream

This is what stops the "missing null check" false-positive epidemic.

### 3. Repository Context Engine — `packages/repo-context-engine`

Builds four graphs the first time it sees a repo, then incrementally updates:

- **Import graph** — who imports what. Used for blast-radius scoring.
- **Call graph** — `methodA` calls `serviceB.fetch()`. Used to trace whether an API can return empty.
- **Resolver/guard registry** — which routes guarantee which data shape. Used by Angular analyzer.
- **Signal/observable graph** — which signals feed which computed values, which observables drive which subscriptions.

Stored in a project-scoped on-disk cache keyed by `(repo, commit-sha)`. Incremental updates use the diff to invalidate only affected subgraphs.

### 4. Angular Analyzer — `packages/angular-analyzer`

Rule pack. Each rule:

- declares which AST node kinds it cares about
- runs against the typed cross-bound AST
- returns `Finding[]` with an initial confidence and an evidence trail
- can request runtime evidence via `runtimeNeeds`

Rule categories:

- **Lifecycle:** subscription leaks, `ngOnDestroy` missing, `takeUntilDestroyed` patterns.
- **Change detection:** template method calls under default CD, OnPush misses, trackBy.
- **State sync:** signal mutation outside `effect`, `set` vs `update`, store mutation outside reducer.
- **RxJS:** nested subscribes, missing `unsubscribe`, hot/cold confusion, `shareReplay` leaks.
- **Memory:** retained event listeners, retained DOM refs, growing arrays in services.
- **IndexedDB / cache:** read-after-write hazards, missing cache-invalidation on mutations.
- **Performance:** heavy expressions in templates, large `*ngFor` without virtualization, blocking sync work in lifecycle hooks.
- **Forms / DI / SSR / hydration:** focused sub-rules.

### 5. Runtime Instrumentation Engine — `packages/runtime-instrumentation` + `apps/runtime-runner`

Triggered selectively — only when:

- A static finding has `runtimeNeeds` set, OR
- The changed files touch hot paths (frequently rendered components, services in the call graph of `>N` consumers).

The runner:

1. Boots the app under Playwright (headless Chromium).
2. Attaches Chrome DevTools Protocol sessions for `Performance`, `HeapProfiler`, `DOM`, `Runtime`, `Network`.
3. Injects an Angular profiler hook (via `ng.profiler` when available, or a small instrumentation bundle).
4. Executes scripted scenarios (declared per repo in `abid-review.config.ts`) — login, key navigations, repeated actions.
5. Collects:
   - Render counts per component
   - Change detection cycles + duration
   - RxJS subscription open/close events (via patched `Subscription.prototype.unsubscribe`)
   - Signal update frequency
   - Heap snapshots before/after each scenario
   - Event listener counts
   - Network request graph

Output is a `RuntimeTrace` object joined to static findings via `(component, location)`.

### 6. Memory Analyzer — `packages/memory-analyzer`

Diffs heap snapshots. Specifically:

- Detached DOM nodes counted across iterations.
- Retainers traced for the top growing object types.
- Listener counts compared across scenario iterations.
- Subscription open/close imbalance.

Findings here are rare but very high-confidence — actual evidence beats heuristics.

### 7. Confidence Engine — `packages/confidence-engine`

Each finding gets a `confidence ∈ [0, 1]` from a weighted ensemble:

| Signal                                          | Weight |
| ----------------------------------------------- | -----: |
| Rule's intrinsic precision (calibrated)         |   0.25 |
| Type-checker corroboration                      |   0.15 |
| Resolver / guard guarantee absent               |   0.10 |
| Runtime trace corroboration                     |   0.20 |
| Cross-file pattern (same issue elsewhere)       |   0.10 |
| LLM agreement after seeing full context         |   0.20 |

Thresholds:

- `≥ 0.75` → post inline.
- `0.50–0.75` → include in PR summary only.
- `< 0.50` → drop (kept in internal log for calibration).

The thresholds are configurable per repo and recalibrated weekly from comment-resolution data (merged-without-pushback vs reverted/refuted).

### 8. Deduplication Engine — `packages/deduplication-engine`

Two-stage:

- **Exact dedup** by `(rule_id, normalized_code_fingerprint)`.
- **Semantic dedup** by embedding similarity (Mistral embeddings) for findings within the same rule family.

When a cluster has `n > 1` members, we pick the "anchor" by:

1. Highest individual confidence.
2. Tiebreaker: file most frequently imported (highest centrality).
3. Tiebreaker: file changed in the PR (over a context file).

The anchor gets the comment. Siblings are bullet-listed in the anchor's body.

### 9. LLM Layer (Mistral) — `packages/llm-mistral`

Mistral has three jobs — *not* "find issues."

1. **False-positive filter.** Given a finding + surrounding code + cross-binding context, decide whether existing code already guards against the issue. If yes, drop the finding.
2. **Voice rewrite.** Take the structured finding and write it in [the project voice](COMMENT_VOICE.md): short sentences, simple English, no jargon.
3. **PR summary.** Aggregate posted findings + skipped low-confidence findings into a single PR-level summary.

**The LLM is never asked "review this code."** It is asked specific, narrow questions with structured inputs and structured expected outputs (JSON schema-constrained). This is the single biggest difference from generic LLM reviewers.

### 10. Azure DevOps Integration — `packages/azure-devops`

- PR webhook verification (HMAC + replay protection).
- PR API: list iterations, list changes, post threaded comments, update status checks.
- Comment posting: maps internal `Finding.location` → ADO `(filePath, line, offset)` with `git-diff-engine`'s line map.
- Status check: `pending → succeeded | failed` with summary link.

## Data model

```ts
type Finding = {
  id: string;                          // ULID
  ruleId: string;                      // e.g. "angular/subscription-leak"
  severity: 'info' | 'warn' | 'error';
  confidence: number;                  // 0..1
  location: {
    file: string;
    startLine: number;
    endLine?: number;
    startColumn?: number;
    endColumn?: number;
  };
  evidence: Evidence[];                // why we believe this
  guarantees: Guarantee[];             // why we might be wrong
  message: {
    title: string;                     // short, plain English
    body: string;                      // rewritten by LLM
    suggestion?: string;               // concrete fix
  };
  siblings?: Array<{ file: string; line: number }>;
  runtimeRefs?: string[];              // trace IDs
};

type Evidence =
  | { kind: 'ast'; node: string; description: string }
  | { kind: 'type'; typeText: string; description: string }
  | { kind: 'callgraph'; path: string[] }
  | { kind: 'runtime'; traceId: string; metric: string; value: number }
  | { kind: 'heap'; snapshotPair: [string, string]; deltaBytes: number };

type Guarantee =
  | { kind: 'resolver'; route: string; field: string }
  | { kind: 'guard'; type: string }
  | { kind: 'type-narrowing'; description: string }
  | { kind: 'template-ngIf'; expression: string };
```

## Why this is hard to copy

- **Cross-binding** requires holding both the template AST and the TS type checker in the same address space with consistent symbol resolution. Reviewers that shell out to `tsc` and `regex` the template can't do this.
- **Confidence calibration** requires a feedback loop: which comments got resolved without pushback? Without that loop, thresholds are guesses.
- **Selective runtime tracing** requires both a static "is this worth running?" classifier and per-repo scenario scripts. It's expensive to set up but pays for itself in finding quality.
- **The "don't comment unless you're sure" discipline** is a product decision, not a feature. Most tools optimize for recall; we optimize for trust.
