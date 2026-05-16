import * as path from 'node:path';
import * as fs from 'node:fs/promises';
import { tmpdir } from 'node:os';
import { simpleGit } from 'simple-git';
import type { Logger } from 'pino';
import type { Finding, ReviewJob } from '@abid/core';
import { DiffIndex, parseUnifiedDiff } from '@abid/git-diff-engine';
import { AstProject, scanComponents } from '@abid/ast-engine';
import { buildContext } from '@abid/repo-context-engine';
import { runAnalyzer } from '@abid/angular-analyzer';
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

    // 5) Run static analyzer.
    let findings = runAnalyzer(
      {
        jobId: job.id,
        tenantId: job.pr.tenantId,
        project,
        repo: context,
        diff,
        changedComponents,
      },
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
        rulePrecision: 0.85,
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
          rulePrecision: 0.85,
          evidence: f.evidence,
          guarantees: f.guarantees,
          llmAgreement: filter.agreement,
        });
      }),
    );

    // 8) Dedup.
    const embedder = cfg.useFakeEmbeddings
      ? new FakeEmbedClient()
      : new MistralEmbedAdapter(mistral);
    const dedup = await dedupFindings(findings, embedder, context.imports);
    findings = dedup.outFindings;

    // 9) Voice rewrite — only for findings that will be posted.
    const toPost = findings.filter((f) => f.stage === 'clustered' && classify(f.ruleId, f.confidence) === 'post');
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
    let posted = 0;
    for (const f of toPost) {
      if (f.stage !== 'rewritten') continue;
      const result = await postFinding(ado, job.pr, f, diff, { iterationId, includeSuggestionBlock: true });
      if (result.posted) {
        posted++;
        f.stage = 'posted';
      } else {
        f.stage = 'dropped';
      }
    }

    // 11) PR summary.
    const summary = await buildPrSummary(
      {
        prTitle: `PR #${job.pr.pullRequestId}`,
        filesChangedCount: [...diff.files()].length,
        posted: findings.filter((f) => f.stage === 'posted'),
        summarized: findings.filter((f) => classify(f.ruleId, f.confidence) === 'summarize'),
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
  promptsDir: string;
  useFakeEmbeddings: boolean;
}

async function loadJobConfig(job: ReviewJob): Promise<JobConfig> {
  // Production: fetch PAT + secrets from Key Vault via Workload Identity.
  return {
    organizationUrl: `https://dev.azure.com/${job.pr.organization}`,
    pat: requiredEnv('ABID_ADO_PAT'),
    cloneUrlWithAuth: `https://abid:${requiredEnv('ABID_ADO_PAT')}@dev.azure.com/${job.pr.organization}/${job.pr.project}/_git/${job.pr.repositoryName}`,
    mistralApiKey: requiredEnv('MISTRAL_API_KEY'),
    mistralModel: process.env['MISTRAL_MODEL'] ?? 'mistral-large-latest',
    promptsDir: process.env['ABID_PROMPTS_DIR'] ?? path.join(process.cwd(), 'prompts'),
    useFakeEmbeddings: process.env['ABID_FAKE_EMBED'] === '1',
  };
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
  constructor(private readonly client: MistralClient) {}

  async embedBatch(texts: string[]): Promise<Float32Array[]> {
    const vecs = await this.client.embed(texts);
    return vecs.map((v) => new Float32Array(v));
  }
}
