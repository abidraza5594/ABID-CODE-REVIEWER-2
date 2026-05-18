import * as path from 'node:path';
import * as fs from 'node:fs/promises';
import { tmpdir } from 'node:os';
import { Redis } from 'ioredis';
import { simpleGit } from 'simple-git';
import type { Logger } from 'pino';
import type { Finding, ReviewJob, RuntimeScenario, RuntimeTrace } from '@abid/core';
import { DiffIndex, isPostable, parseUnifiedDiff } from '@abid/git-diff-engine';
import { AstProject, type ComponentDescriptor } from '@abid/ast-engine';
import { buildContext } from '@abid/repo-context-engine';
import { ALL_RULES, runAnalyzer, type RuntimeBundle } from '@abid/angular-analyzer';
import { applyScore, classify, DEFAULT_THRESHOLDS } from '@abid/confidence-engine';
import { dedupFindings, FakeEmbedClient } from '@abid/deduplication-engine';
import {
  MistralClient,
  PromptLoader,
  buildPrSummary,
  filterFinding,
  rewriteFinding,
} from '@abid/llm-mistral';
import { AdoClient, postFinding, publishStatus } from '@abid/azure-devops';
import { InMemoryFindingsStore } from '@abid/findings';

/**
 * Single-job pipeline. Linear by design — observability and debuggability
 * matter more than micro-parallelism here. Each stage is structured-logged.
 */
export async function runReview(job: ReviewJob, log: Logger): Promise<void> {
  const cfg = await loadJobConfig(job);
  const ado = new AdoClient({ organizationUrl: cfg.organizationUrl, pat: cfg.pat });
  await publishStatus(ado, job.pr, { state: 'pending', description: 'Abid Review running' });

  // 1) Clone PR head + base into a per-job tmpfs directory.
  const workdir = await prepareWorkdir(job, cfg, log);

  try {
    // 2) Fetch unified diff from ADO.
    const diffText = await ado.getPullRequestDiff(job.pr);
    const diff = new DiffIndex(parseUnifiedDiff(diffText));

    // 3) Build typed AST view + RepoContext.
    const project = new AstProject(workdir);
    const context = await buildContext(project, job.pr.sourceSha);
    log.info({ jobId: job.id, components: context.components.length, buildMs: context.buildMs }, 'context built');

    // 4) Identify changed components.
    const changedComponents = context.components.filter((c) => {
      if (diff.fileByNewPath(c.tsFile)) return true;
      return c.templates.some((t) => diff.fileByNewPath(t.file));
    });

    const runtime = await collectRuntimeEvidence(job, cfg, changedComponents, log);

    // 5) Run static analyzer.
    const analyzerContext = runtime
      ? {
          jobId: job.id,
          tenantId: job.pr.tenantId,
          project,
          repo: context,
          diff,
          changedComponents,
          runtime,
        }
      : {
          jobId: job.id,
          tenantId: job.pr.tenantId,
          project,
          repo: context,
          diff,
          changedComponents,
        };
    let findings = runAnalyzer(
      analyzerContext,
      { preFilterFloor: 0.4 },
    );
    log.info({ jobId: job.id, rawFindings: findings.length }, 'analyzer done');

    // 6) Score findings.
    const mistral = new MistralClient({
      apiKey: cfg.mistralApiKey,
      model: cfg.mistralModel,
      customerId: job.pr.tenantId,
    });
    const prompts = new PromptLoader(cfg.promptsDir);

    findings = findings.map((f) =>
      applyScore(f, {
        rulePrecision: rulePrecisionOf(f.ruleId),
        evidence: f.evidence,
        guarantees: f.guarantees,
      }),
    );

    // 7) LLM false-positive filter (only above summarize floor).
    findings = await Promise.all(
      findings.map(async (f) => {
        const cls = classify(f.ruleId, f.confidence);
        if (cls === 'drop') return f;
        const snippet = await readSnippet(workdir, f.location.file, f.location.startLine, 12);
        const filter = await filterFinding(f, { file: f.location.file, snippet }, { mistral, prompts });
        return applyScore(f, {
          rulePrecision: rulePrecisionOf(f.ruleId),
          evidence: f.evidence,
          guarantees: f.guarantees,
          llmAgreement: filter.agreement,
        });
      }),
    );

    // 8) Dedup.
    const embedder = cfg.useFakeEmbeddings
      ? new FakeEmbedClient()
      : new MistralEmbedAdapter(mistral, cfg.mistralEmbedModel);
    const dedup = await dedupFindings(findings, embedder, context.imports);
    findings = dedup.outFindings;

    // 9) Voice rewrite only for findings that will be posted. Low-confidence
    // findings stay available for the PR summary but are not posted inline.
    for (const f of findings) {
      if (f.stage !== 'clustered') continue;
      const disposition = classify(f.ruleId, f.confidence);
      if (disposition === 'drop') {
        f.stage = 'dropped';
        f.dispositionReason = 'below-confidence-floor';
      } else if (disposition === 'summarize') {
        f.stage = 'summarized';
        f.dispositionReason = 'below-confidence-floor';
      } else if (!isExactAddedLine(f, diff)) {
        f.stage = 'summarized';
        f.dispositionReason = 'not-on-added-line';
        f.notes = 'Summary only: finding is not anchored to the exact added statement in this PR.';
      }
    }

    const toPost = findings.filter((f) => f.stage === 'clustered');
    for (const f of toPost) {
      const r = await rewriteFinding(f, { mistral, prompts });
      if (!r.ok) {
        f.stage = 'dropped';
        f.dispositionReason = 'voice-lint-failed';
        continue;
      }
      f.message.title = r.title ?? f.message.title;
      f.message.body = r.body ?? '';
      if (r.suggestion) f.message.suggestion = r.suggestion;
      f.stage = 'rewritten';
    }

    // 10) Post inline comments.
    const iterationId = await ado.getIteration(job.pr);
    const changeTrackingIds = await ado.getChangeTrackingMap(job.pr, iterationId);
    let posted = 0;
    for (const f of toPost) {
      if (f.stage !== 'rewritten') continue;
      const result = await postFinding(ado, job.pr, f, diff, { iterationId, changeTrackingIds, includeSuggestionBlock: true, closeThreadOnLowSeverity: true });
      if (result.posted) {
        posted++;
        f.stage = 'posted';
      } else {
        f.stage = 'dropped';
        f.notes = `ADO post skipped: ${result.reason ?? 'not-postable'}`;
      }
    }

    // 11) PR summary.
    const summary = await buildPrSummary(
      {
        prTitle: `PR #${job.pr.pullRequestId}`,
        filesChangedCount: [...diff.files()].length,
        posted: findings.filter((f) => f.stage === 'posted'),
        summarized: findings.filter((f) => f.stage === 'summarized'),
      },
      { mistral, prompts },
    );
    await ado.postThread(job.pr, {
      status: 'closed',
      comments: [{ commentType: 'text', content: summary }],
    });

    // 12) Persist findings + final status.
    const store = new InMemoryFindingsStore();
    await store.saveBatch(findings);

    await publishStatus(ado, job.pr, {
      state: 'succeeded',
      description: posted > 0 ? `Posted ${posted} comments` : 'No issues found',
    });
  } catch (err) {
    await publishStatus(ado, job.pr, { state: 'failed', description: `Review error: ${(err as Error).message.slice(0, 100)}` });
    throw err;
  } finally {
    await fs.rm(workdir, { recursive: true, force: true });
  }
}

async function collectRuntimeEvidence(
  job: ReviewJob,
  cfg: JobConfig,
  changedComponents: ComponentDescriptor[],
  log: Logger,
): Promise<RuntimeBundle | undefined> {
  if (!cfg.runtimeRedisUrl || !cfg.runtimeBaseUrl || cfg.runtimeScenarios.length === 0 || changedComponents.length === 0) {
    return undefined;
  }

  const scenarios = cfg.runtimeScenarios.filter((s) =>
    changedComponents.some((c) => scenarioExercisesComponent(s, c)),
  );
  if (scenarios.length === 0) return undefined;

  const redis = new Redis(cfg.runtimeRedisUrl);
  const requests = scenarios.map((scenario) => ({
    scenario,
    resultsKey: `abid:runtime:${job.id}:${scenario.id}`,
  }));

  try {
    if (requests.length > 0) await redis.del(...requests.map((r) => r.resultsKey));
    for (const req of requests) {
      await redis.xadd('jobs:runtime', '*', 'payload', JSON.stringify({
        jobId: job.id,
        baseUrl: cfg.runtimeBaseUrl,
        scenario: req.scenario,
        resultsKey: req.resultsKey,
      }));
    }

    const pending = new Map(requests.map((r) => [r.resultsKey, r.scenario]));
    const traces: RuntimeTrace[] = [];
    const deadline = Date.now() + cfg.runtimeTimeoutMs;
    while (pending.size > 0 && Date.now() < deadline) {
      const keys = [...pending.keys()];
      const values = await redis.mget(...keys);
      values.forEach((raw, index) => {
        if (!raw) return;
        const key = keys[index]!;
        try {
          traces.push(JSON.parse(raw) as RuntimeTrace);
          pending.delete(key);
        } catch (err) {
          log.warn({ jobId: job.id, key, err: (err as Error).message }, 'runtime trace parse failed');
          pending.delete(key);
        }
      });
      if (pending.size > 0) await sleep(1000);
    }

    if (pending.size > 0) {
      log.warn({ jobId: job.id, missing: [...pending.values()].map((s) => s.id) }, 'runtime evidence timed out');
    }
    if (traces.length === 0) return undefined;
    return tracesToRuntimeBundle(traces, scenarios, changedComponents);
  } finally {
    await redis.quit();
  }
}

function tracesToRuntimeBundle(
  traces: RuntimeTrace[],
  scenarios: RuntimeScenario[],
  changedComponents: ComponentDescriptor[],
): RuntimeBundle {
  const byComponent: RuntimeBundle['byComponent'] = new Map();
  const scenarioById = new Map(scenarios.map((s) => [s.id, s]));

  for (const trace of traces) {
    if (!trace.ok) continue;
    const scenario = scenarioById.get(trace.scenarioId);
    if (!scenario) continue;
    const exercised = changedComponents.filter((c) => scenarioExercisesComponent(scenario, c));
    const globallyAttributable = exercised.length === 1;

    for (const comp of exercised) {
      const current = byComponent.get(comp.className) ?? {
        avgRenderCount: 0,
        leakedSubscriptionCount: 0,
        longTaskMs: [],
        heapDeltaBytes: 0,
        traceIds: [],
      };

      current.avgRenderCount += runtimeRenderCount(trace, comp, scenario, globallyAttributable);
      current.leakedSubscriptionCount += trace.subscriptions.filter((s) =>
        s.leaked && subscriptionBelongsToComponent(s, comp, globallyAttributable),
      ).length;
      if (globallyAttributable) {
        current.longTaskMs.push(...trace.longTasks.map((t) => t.durationMs));
      }
      if (!current.traceIds.includes(trace.id)) current.traceIds.push(trace.id);
      byComponent.set(comp.className, current);
    }
  }

  return { byComponent };
}

function runtimeRenderCount(
  trace: RuntimeTrace,
  comp: ComponentDescriptor,
  scenario: RuntimeScenario,
  includeGlobalFallback: boolean,
): number {
  const selector = comp.selector ?? '';
  const value = trace.renderCounts[comp.className]
    ?? (selector ? trace.renderCounts[selector] : undefined)
    ?? (includeGlobalFallback ? trace.renderCounts['__dom__'] : undefined)
    ?? 0;
  return value / Math.max(1, scenario.iterations);
}

function subscriptionBelongsToComponent(
  sub: RuntimeTrace['subscriptions'][number],
  comp: ComponentDescriptor,
  includeGlobalFallback: boolean,
): boolean {
  if (sub.ownerComponent && sub.ownerComponent === comp.className) return true;
  const file = sub.sourceLocation?.file;
  if (file && normalizeRuntimePath(file).endsWith(normalizeRuntimePath(comp.tsFile))) return true;
  return includeGlobalFallback && !sub.ownerComponent && !sub.sourceLocation;
}

function scenarioExercisesComponent(scenario: RuntimeScenario, comp: ComponentDescriptor): boolean {
  return scenario.exercises.includes('*')
    || scenario.exercises.includes(comp.className)
    || (!!comp.selector && scenario.exercises.includes(comp.selector));
}

function normalizeRuntimePath(file: string): string {
  return file.replace(/\\/g, '/').replace(/^\/+/, '');
}

function sleep(ms: number): Promise<void> {
  return new Promise((resolve) => setTimeout(resolve, ms));
}

async function prepareWorkdir(job: ReviewJob, cfg: JobConfig, log: Logger): Promise<string> {
  const dir = await fs.mkdtemp(path.join(tmpdir(), 'abid-job-'));
  const git = simpleGit(dir);
  const cloneUrl = cfg.cloneUrlWithAuth;
  await git.clone(cloneUrl, dir, ['--no-checkout']);
  await git.fetch(['origin', job.pr.sourceSha, job.pr.baseSha]);
  await git.checkout(job.pr.sourceSha);
  log.info({ jobId: job.id, workdir: dir }, 'workdir ready');
  return dir;
}

async function readSnippet(workdir: string, file: string, line: number, radius: number): Promise<string> {
  try {
    const full = await fs.readFile(path.join(workdir, file), 'utf8');
    const lines = full.split('\n');
    const start = Math.max(0, line - radius - 1);
    const end = Math.min(lines.length, line + radius);
    return lines.slice(start, end).map((l, i) => `${start + i + 1}: ${l}`).join('\n');
  } catch {
    return '';
  }
}

interface JobConfig {
  organizationUrl: string;
  pat: string;
  cloneUrlWithAuth: string;
  mistralApiKey: string;
  mistralModel: string;
  mistralEmbedModel: string;
  promptsDir: string;
  useFakeEmbeddings: boolean;
  runtimeRedisUrl?: string;
  runtimeBaseUrl?: string;
  runtimeScenarios: RuntimeScenario[];
  runtimeTimeoutMs: number;
}

async function loadJobConfig(job: ReviewJob): Promise<JobConfig> {
  // Production: fetch PAT + secrets from Key Vault via Workload Identity.
  const cfg: JobConfig = {
    organizationUrl: `https://dev.azure.com/${job.pr.organization}`,
    pat: requiredEnv('ABID_ADO_PAT'),
    cloneUrlWithAuth: `https://abid:${requiredEnv('ABID_ADO_PAT')}@dev.azure.com/${job.pr.organization}/${job.pr.project}/_git/${job.pr.repositoryName}`,
    mistralApiKey: requiredEnv('MISTRAL_API_KEY'),
    mistralModel: process.env['MISTRAL_MODEL'] ?? 'devstral-2512',
    mistralEmbedModel: process.env['MISTRAL_EMBED_MODEL'] ?? 'codestral-embed',
    promptsDir: process.env['ABID_PROMPTS_DIR'] ?? path.join(process.cwd(), 'prompts'),
    useFakeEmbeddings: process.env['ABID_FAKE_EMBED'] === '1',
    runtimeScenarios: await loadRuntimeScenarios(),
    runtimeTimeoutMs: Number(process.env['ABID_RUNTIME_TIMEOUT_MS'] ?? 120_000),
  };
  if (process.env['ABID_RUNTIME_REDIS_URL']) cfg.runtimeRedisUrl = process.env['ABID_RUNTIME_REDIS_URL'];
  if (process.env['ABID_RUNTIME_BASE_URL']) cfg.runtimeBaseUrl = process.env['ABID_RUNTIME_BASE_URL'];
  return cfg;
}

async function loadRuntimeScenarios(): Promise<RuntimeScenario[]> {
  const rawJson = process.env['ABID_RUNTIME_SCENARIOS_JSON'];
  if (rawJson) return parseRuntimeScenarios(rawJson, 'ABID_RUNTIME_SCENARIOS_JSON');

  const file = process.env['ABID_RUNTIME_SCENARIOS_FILE'];
  if (!file) return [];
  const raw = await fs.readFile(path.resolve(file), 'utf8');
  return parseRuntimeScenarios(raw, file);
}

function parseRuntimeScenarios(raw: string, source: string): RuntimeScenario[] {
  const parsed = JSON.parse(raw) as unknown;
  if (!Array.isArray(parsed)) throw new Error(`runtime scenarios must be an array: ${source}`);
  return parsed as RuntimeScenario[];
}

function requiredEnv(name: string): string {
  const v = process.env[name];
  if (!v) throw new Error(`missing env: ${name}`);
  return v;
}

// Mistral embedding adapter for the dedup engine. Lives here so the
// llm-mistral and deduplication-engine packages don't have to know about
// each other directly.
import type { EmbedClient } from '@abid/deduplication-engine';
class MistralEmbedAdapter implements EmbedClient {
  constructor(
    private readonly client: MistralClient,
    private readonly model: string,
  ) {}

  async embedBatch(texts: string[]): Promise<Float32Array[]> {
    const vecs = await this.client.embed(texts, this.model);
    return vecs.map((v) => new Float32Array(v));
  }
}

const RULE_PRECISION_BY_ID: Map<string, number> = new Map(ALL_RULES.map((rule) => [rule.id, rule.basePrecision]));

function rulePrecisionOf(ruleId: string): number {
  return RULE_PRECISION_BY_ID.get(ruleId) ?? 0.65;
}

function isExactAddedLine(finding: Finding, diff: DiffIndex): boolean {
  return isPostable(finding.location, diff, { requireAddedLine: true }).postable;
}
