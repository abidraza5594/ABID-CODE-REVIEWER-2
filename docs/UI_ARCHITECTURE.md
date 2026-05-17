# Abid Review Command Center UI Architecture

## Product Shape

Abid Review Command Center is an AI-native Azure DevOps review surface. It is not a generic dashboard. It is a live review room that shows the reviewer what the system is checking, what evidence it used, what it skipped, and why each Azure comment exists.

Primary user: a developer or reviewer watching an AI review a PR in real time.

## Frontend Architecture

Recommended production stack:

- Angular latest or Next.js with React, TypeScript, Tailwind, and strict mode.
- Monaco Editor for exact file and changed-line inspection.
- React Flow or D3 for repository graph traversal.
- Canvas/WebGL for high-volume runtime heatmaps and flame tracks.
- Virtual scrolling for file lists, timeline events, findings, and context chunks.
- Zustand or NgRx store split into small event-driven slices.

Core screens:

- Live Review Timeline: PR received, diff parse, repo index, Angular template analysis, runtime trace, dedup, rewrite, Azure posting.
- File Analysis: current file, changed lines, related files, dependency chain, and reason each file was opened.
- AI Reasoning: safe summarized reasoning only. No hidden chain-of-thought.
- Runtime View: render counts, CD cycles, RxJS leaks, DOM mutations, heap deltas, long tasks, network repeats.
- Comment Preview: exact comment, file, line, confidence, evidence, duplicate group, skip reason.
- False Positive Explainer: skipped findings with resolver, type, guard, runtime, and duplicate proof.
- Context Window: retrieved files, summarized chunks, trace summaries, token budget.

## State Design

Suggested store slices:

- `reviewSession`: PR metadata, status, active stage, current iteration.
- `timeline`: append-only stream of stage events.
- `fileContext`: current file, related files, dependency reasons, Monaco decorations.
- `reasoning`: safe model summaries and confidence deltas.
- `runtime`: traces, metrics, heatmaps, heap snapshots, network buckets.
- `graph`: nodes, edges, active traversal path, collapsed clusters.
- `findings`: raw, filtered, grouped, summarized, posted, dropped.
- `contextBudget`: chunks selected, token counts, prompt sections.

## Backend Streaming

Production event path:

1. Webhook Gateway accepts Azure DevOps PR events.
2. Orchestrator emits review events into Redis Streams.
3. API exposes server-sent events or WebSocket rooms per `jobId`.
4. Frontend subscribes to `/api/reviews/:jobId/events`.
5. UI applies events incrementally without refetching full session state.

Event types:

- `timeline`
- `file`
- `reasoning`
- `runtime`
- `finding`
- `duplicate-group`
- `skip`
- `comment`
- `post-result`
- `complete`

## Graph System

Graph nodes:

- Angular component
- Template
- Service
- Resolver
- NgRx effect/store
- API endpoint
- Runtime trace
- Comment target

Graph edges:

- imports
- injects
- template-binds
- subscribes-to
- calls-api
- reads-signal
- writes-signal
- runtime-confirms

Rendering strategy:

- Layout is computed off-main-thread in a Web Worker.
- Large graphs render clustered first, then expand on selection.
- Canvas layer renders edges and heat; DOM/SVG layer renders selected labels and controls.

## Monaco Integration

Monaco decorations:

- changed line gutter
- active AI inspection line
- comment preview target
- runtime-confirmed hot line
- false-positive skipped line
- duplicate sibling line

Monaco side panel:

- evidence stack
- related file reason
- runtime metrics for selected line
- confidence breakdown

## Performance Strategy

- Use append-only streams and normalized state.
- Virtualize all long lists.
- Render graph edges on Canvas.
- Use requestAnimationFrame batching for streaming UI events.
- Keep Monaco models only for open files.
- Store runtime trace detail separately; load heavy trace data on demand.
- Use Web Workers for graph layout and trace aggregation.

## Security

- Never show raw chain-of-thought.
- Show safe reasoning summaries only.
- Redact secrets from snippets and runtime traces before streaming.
- Tenant and PR authorization must be checked before joining a review stream.
- Context chunks should include source references and hashes for auditability.

## Current Prototype

Standalone prototype:

- `mockups/designs/ai-review-command-center/index.html`

Backend streaming contract:

- `apps/api/src/server.ts`
- `GET /api/reviews/:jobId/events`

