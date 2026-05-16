# Production Blueprint: Runtime-Aware Azure DevOps AI Reviewer

This document is the product and engineering blueprint for Abid Review as a production platform. The goal is not to wrap a diff with an LLM. The goal is to combine compiler-grade static analysis, Angular-specific knowledge, runtime evidence, confidence scoring, and a low-noise comment policy.

## Product Contract

Abid Review must post only comments that are useful, specific, and high confidence.

Every inline comment must have:

- Exact file and head-revision line.
- Evidence from at least one trusted engine.
- A confidence score.
- A short explanation in simple English.
- A practical fix.

Low-confidence findings do not become inline comments. They can appear in a PR summary or stay internal for calibration.

## Research Anchors

The implementation should track these primary sources:

- Angular signals, `DestroyRef`, `effect`, template and lifecycle behavior.
- TypeScript Compiler API and Language Service API for semantic analysis.
- RxJS subscription and teardown semantics.
- Chrome DevTools Protocol domains: Runtime, Performance, Tracing, HeapProfiler, DOM, Network.
- Playwright traces and browser automation.
- Azure DevOps PR threads, iterations, and iteration changes APIs.
- Semgrep-style AST pattern matching and rule authoring.
- SonarQube-style scanner/server separation and issue lifecycle.

## Target Architecture

```
Azure DevOps webhook
  -> webhook-gateway
  -> orchestrator
  -> git-diff-engine
  -> ast-engine
  -> repo-context-engine
  -> angular-analyzer
  -> optional runtime-runner
  -> confidence-engine
  -> deduplication-engine
  -> llm-mistral
  -> azure-devops poster
  -> findings store + feedback loop
```

## Folder Structure

Current structure is already close to the production shape:

```
apps/
  cli/                 local interactive runner
  webhook-gateway/     Azure DevOps webhook intake
  orchestrator/        pipeline coordinator
  runtime-runner/      Playwright + CDP worker
  api/                 internal findings API
packages/
  core/                shared PR, finding, evidence, runtime types
  git-diff-engine/     unified diff parser and postability mapping
  ast-engine/          ts-morph + Angular template AST
  repo-context-engine/ import graph, call graph, resolver/signal registry
  angular-analyzer/    Angular rule pack
  runtime-instrumentation/ browser probes
  memory-analyzer/     heap/listener/subscription analysis
  confidence-engine/   scoring and disposition
  deduplication-engine/ fingerprinting and clustering
  llm-mistral/         prompts, filtering, voice rewrite, summaries
  azure-devops/        PR API, statuses, inline threads
  findings/            persistence and feedback contracts
```

## Database Design

Production should use Postgres for transactional records and object storage for heavy traces.

Tables:

- `tenants`: tenant id, org mapping, policy config, secret refs.
- `repositories`: ADO repo id, default branch, language/framework metadata.
- `pull_requests`: PR coordinates, source/base SHA, status, iteration id.
- `review_jobs`: job id, state, timings, engine versions, failure reason.
- `findings`: finding id, rule id, confidence, stage, file, line, fingerprint, JSON evidence.
- `finding_clusters`: cluster id, anchor finding id, sibling finding ids.
- `posted_threads`: finding id, ADO thread id, iteration id, changeTrackingId.
- `runtime_traces`: trace id, job id, scenario id, object storage URI, summary metrics.
- `feedback_events`: thread id, resolved/refuted/ignored, author text, timestamp.
- `calibration_rules`: rule id, tenant id, precision estimate, post floor override.
- `repo_graph_snapshots`: repo id, commit SHA, graph hash, object storage URI.

Indexes:

- `(repository_id, pull_request_id, iteration_id)` for job lookup.
- `(job_id, stage)` for summaries.
- `(repository_id, commit_sha)` for cached repo graphs.
- `(rule_id, fingerprint, pull_request_id)` for duplicate control.
- `(ado_thread_id)` for feedback polling.

## Git Diff Engine

Responsibilities:

- Parse unified diffs from git or Azure DevOps.
- Normalize paths to repo-relative forward slashes.
- Reject deleted and binary files.
- Map head lines to base lines.
- Keep changed-hunk and added-line sets.
- Allow inline comments anywhere in a changed file by default, because Azure DevOps can place a thread on existing head lines in changed files.
- Expose stricter modes for new-issues-only policies.

Posting must use Azure DevOps `changeTrackingId` from the PR iteration changes endpoint so comments pin to the correct file diff.

## AST Engine

Use `ts-morph` over the real repo `tsconfig.json` so path mappings, strict flags, decorators, and project references match production.

Static model:

- Component class metadata.
- External and inline templates.
- Constructor and `inject()` dependencies.
- Fields and initializer kinds.
- Methods, lifecycle hooks, and subscribe calls.
- Template bindings mapped back to TS symbols.

Semantic model:

- TypeChecker symbol resolution.
- Nullish type guarantees.
- Resolver and guard guarantees.
- Signal defaults and computed dependencies.
- Async pipe and template guard narrowing.

## Angular Analyzer

Rules should be narrow and evidence-led.

High-value rule families:

- Subscription leaks and nested subscribes.
- Template null access without proven guard.
- Default change detection with expensive template calls.
- `ngFor` without stable tracking on large dynamic lists.
- Signal writes inside effects that cause over-triggering.
- `shareReplay` without refCount on long-lived streams.
- IndexedDB read-after-write or stale cache usage.
- Repeated API calls from lifecycle/render paths.
- Event listener or modal callback leaks.
- Reactive form valueChanges leaks.
- SSR/hydration unsafe browser globals.

False-positive gates:

- Do not report HttpClient one-shot calls as leaks.
- Do not report if `takeUntilDestroyed`, `takeUntil`, `take(1)`, `first`, or proven manual cleanup exists.
- Do not report template null access if a resolver, guard, type narrowing, signal default, or upstream template guard proves safety.
- Do not report performance findings without a changed path, hot path, or runtime signal.

## Runtime Instrumentation

Runtime is selective. It runs only when static analysis finds a plausible issue or when changed files touch hot paths.

Runtime runner:

- Launch app with Playwright.
- Attach CDP sessions.
- Inject a small instrumentation bundle.
- Execute repo-defined scenarios.
- Collect metrics and trace artifacts.

Tracked signals:

- Component render counts.
- Change detection cycles and duration.
- RxJS subscriptions opened and closed.
- Signal updates and dependency fanout.
- Network requests and duplicate calls.
- Long tasks and blocking script.
- DOM mutation volume.
- Event listener counts.
- Heap snapshots before and after scenario loops.

Runtime traces must be summarized before sending to Mistral. Do not send raw traces to the LLM.

## Memory Analysis

Memory findings require strong evidence:

- Repeated heap snapshots across scenario loops.
- Retained detached DOM nodes.
- Growing listener counts.
- RxJS subscription open without close.
- Retained component instances after navigation.

Post only when the growth is repeatable and tied to changed code.

## Confidence Engine

Confidence is a disposition system, not a decorative score.

Inputs:

- Rule precision.
- Type evidence.
- Runtime evidence.
- Resolver/guard guarantees.
- Cross-file repetition.
- LLM false-positive agreement.
- Historical feedback by tenant and rule.

Disposition:

- `post`: high confidence, inline comment.
- `summarize`: useful but not strong enough for inline.
- `drop`: too weak or guarded.

The default should favor trust over recall.

## Deduplication

One logical issue should create one comment.

Dedup stages:

- Exact fingerprint by normalized rule + code shape.
- Semantic embedding within the same rule id.
- Anchor selection by confidence, evidence richness, changed-line relevance, and import centrality.

The comment body lists sibling locations instead of spamming every file.

## Mistral Prompt Architecture

Mistral should not invent findings.

Prompt jobs:

- False-positive filter.
- Voice rewrite.
- PR summary.
- Runtime trace summary.
- Repository pattern summary.

Inputs:

- Structured finding.
- Small code snippet.
- Relevant type/template/runtime evidence.
- Rule explanation.
- Known guarantees.
- Sibling list.

Outputs must be schema-checked JSON. Failed schema means keep the structured finding or drop safely, never post hallucinated text.

Voice:

- Short sentences.
- Basic English.
- No jargon unless needed.
- Exact issue.
- Why it matters.
- Practical fix.

## Azure DevOps Integration

Required API behavior:

- Fetch PR details and latest iteration.
- Fetch iteration changes and map `file -> changeTrackingId`.
- Post inline threads with:
  - `threadContext.filePath`
  - `rightFileStart`
  - `rightFileEnd`
  - `pullRequestThreadContext.changeTrackingId`
  - `iterationContext`
- Post PR summary as a closed PR-level thread.
- Publish status checks.
- Record posted thread ids for feedback.

Posting must never report green success when zero comments were posted.

## Scaling Strategy

Large monorepos need incremental analysis:

- Cache repo graphs by commit SHA.
- Rebuild only invalidated graph slices.
- Analyze changed components first.
- Expand to dependencies only when a rule needs it.
- Run runtime scenarios only for hot paths.
- Parallelize independent rule packs.
- Cap LLM calls by pre-filtering and deduping first.
- Store heavy traces outside Postgres.

## Security

Minimum controls:

- PATs and Mistral keys in secret storage only.
- No raw secrets in prompts or logs.
- Redact `.env`, auth headers, tokens, cookies, and local storage.
- Tenant-isolated caches and object storage prefixes.
- Webhook HMAC verification and replay protection.
- Least-privilege ADO scopes: code read/write and PR threads read/write.
- Audit every posted comment with rule id, prompt version, model, and evidence hash.

## MVP Roadmap

1. Reliable ADO inline comments with `changeTrackingId`.
2. Static Angular rule pack for lifecycle, template guards, tracking, and cache hazards.
3. Confidence scoring and summary-only disposition.
4. Dedup anchor comments with sibling lists.
5. Mistral false-positive filter and voice rewrite.
6. CLI runner for local PR validation.
7. Full build and test reliability.

## Enterprise Roadmap

1. Persistent Postgres findings store.
2. Runtime scenario registry per repo.
3. CDP trace collection and memory analysis.
4. Feedback polling from ADO threads.
5. Tenant-level calibration of rule thresholds.
6. Dashboard for precision, posted comments, accepted findings, and noisy rules.
7. Multi-worker orchestrator with queue backpressure.
8. Policy controls per repo and branch.

## VSCode Extension Roadmap

1. Show current PR findings inline before posting.
2. Explain evidence and confidence locally.
3. Let developers mark false positive/useful.
4. Run selected static rules on save.
5. Preview generated ADO comments.
6. Open matching Azure DevOps thread.

## Engineering Rule

The reviewer must earn trust. A missing comment is better than a noisy comment. Runtime evidence and framework guarantees should raise confidence. Unproven guesses should stay out of inline review.
