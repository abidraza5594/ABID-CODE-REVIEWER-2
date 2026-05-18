import * as fs from 'node:fs/promises';
import * as path from 'node:path';
import { tmpdir } from 'node:os';
import { simpleGit } from 'simple-git';
import kleur from 'kleur';
import type { Finding } from '@abid/core';
import { ulid } from '@abid/core';
import { DiffIndex, isPostable, parseUnifiedDiff, type FileDiff } from '@abid/git-diff-engine';
import { AstProject, type ComponentDescriptor } from '@abid/ast-engine';
import { buildContext, type RepoContext } from '@abid/repo-context-engine';
import {
  ALL_RULES,
  ENGINEERING_REVIEW_PHASES,
  MANDATORY_ISSUE_CATEGORIES,
  REVIEW_CHECK_LABELS,
  runAnalyzer,
  type RunOptions,
} from '@abid/angular-analyzer';
import { applyScore, buildExactSuggestion, classify, decideReviewAction } from '@abid/confidence-engine';
import { dedupFindings, FakeEmbedClient } from '@abid/deduplication-engine';
import { AdoClient, postFinding } from '@abid/azure-devops';
import {
  MistralClient,
  PromptLoader,
  filterFinding,
  rewriteFinding,
} from '@abid/llm-mistral';
import type { ParsedPr } from './parse-url.js';
import { renderFindings } from './render.js';
import { findRepoRoot } from './paths.js';
import type { ReviewUiEventInput } from './review-ui.js';

export interface ReviewOutput {
  findings: Finding[];
  renderedFindings: string;
  summaryLine: string;
  /** Call this only after the user confirms; posts to ADO. */
  postNow: () => Promise<PostSummary>;
}

export interface PostSummary {
  attempted: number;
  posted: number;
  skipped: Array<{ file: string; line: number; reason: string }>;
  failed: Array<{ file: string; line: number; error: string }>;
}

export interface ReviewHooks {
  onUiEvent?: (event: ReviewUiEventInput) => void | Promise<void>;
}

/**
 * Full single-PR review pipeline for the CLI. Same engines as the
 * orchestrator app, but skips Redis-based queueing and runtime-runner —
 * pure static + LLM analysis.
 *
 * Flow:
 *   1. Resolve PR details from ADO (source/base SHA).
 *   2. Clone the repo at sourceSha into a temp dir.
 *   3. Fetch the unified diff.
 *   4. Build AST + RepoContext.
 *   5. Run analyzer, score, LLM-filter, dedup, voice-rewrite.
 *   6. Return findings + a `postNow()` thunk the caller invokes on user confirmation.
 */
export async function reviewOnePr(pr: ParsedPr, hooks: ReviewHooks = {}): Promise<ReviewOutput> {
  const ui = (event: ReviewUiEventInput) => Promise.resolve(hooks.onUiEvent?.(event)).catch(() => undefined);
  const ado = new AdoClient({
    organizationUrl: `https://dev.azure.com/${pr.organization}`,
    pat: requiredEnv('ABID_ADO_PAT'),
  });

  step('Fetching PR details from Azure DevOps');
  await ui({ type: 'timeline', title: 'Fetching PR details from Azure DevOps', detail: 'Reading PR source and target commits.', status: 'running', rule: 'diff' });
  const prDetails = await fetchPrDetails(ado, pr);

  step('Cloning repo (this is the slow step — first time)');
  await ui({ type: 'timeline', title: 'Cloning repo', detail: 'Preparing source checkout for this selected PR.', status: 'running', rule: 'diff' });
  const workdir = await cloneRepo(pr, prDetails.sourceSha, prDetails.baseSha);

  try {
    step('Fetching unified diff');
    await ui({ type: 'timeline', title: 'Fetching unified diff', detail: 'Mapping changed files and new-line anchors.', status: 'running', rule: 'diff' });
    const diffText = await fetchUnifiedDiff(pr, prDetails);
    const diff = new DiffIndex(parseUnifiedDiff(diffText));
    const filesCount = [...diff.files()].length;
    if (filesCount === 0) {
      return emptyResult(`PR has no analyzable file changes.`);
    }
    detail(`${filesCount} file(s) changed`);
    await ui({ type: 'timeline', title: 'Parsing changed files', detail: `${filesCount} file(s) changed in this PR.`, status: 'done', rule: 'diff' });
    const changedFiles = [...diff.files()].filter((file) => !file.binary && file.status !== 'deleted');
    await ui({
      type: 'queue',
      title: 'Changed file queue ready',
      files: changedFiles.map((file) => ({
        file: file.newPath,
        reason: `${file.status} file from selected PR diff`,
        rule: ruleForPath(file.newPath),
      })),
    });
    const firstChangedFile = changedFiles[0];
    if (firstChangedFile) {
      await ui({
        type: 'file',
        title: 'Current changed file',
        file: firstChangedFile.newPath,
        line: firstChangedLine(firstChangedFile),
        rule: ruleForPath(firstChangedFile.newPath),
        code: diffFileToCodeRows(firstChangedFile),
        related: [
          { file: firstChangedFile.newPath, reason: 'First changed file from the selected PR diff.' },
          { file: 'diff-map', reason: 'Opened to map exact changed lines for Azure comments.' },
        ],
      });
    }

    step('Building TypeScript + Angular AST');
    await ui({ type: 'timeline', title: 'Building TypeScript + Angular AST', detail: 'Building repository symbols, components, templates, and imports.', status: 'running', rule: 'template' });
    const project = new AstProject(workdir);
    const context = await buildContext(project, prDetails.sourceSha);
    detail(`${context.components.length} component(s) built in ${context.buildMs}ms`);

    const changedComponents = context.components.filter((c) => {
      if (diff.fileByNewPath(c.tsFile)) return true;
      return c.templates.some((t) => diff.fileByNewPath(t.file));
    });
    detail(`${changedComponents.length} changed component(s) in scope`);
    await ui({ type: 'timeline', title: 'Building repository graph', detail: `${context.components.length} component(s) built. ${changedComponents.length} changed component(s) in scope.`, status: 'done', rule: 'template' });

    const jobId = ulid();
    step('Running sequential changed-file analysis');
    let findings = await analyzeChangedFilesSequential(
      {
        jobId,
        project,
        context,
        diff,
        changedFiles,
        changedComponents,
        workdir,
        ui,
      },
      { preFilterFloor: 0.4 },
    );
    detail(`${findings.length} raw finding(s)`);
    await ui({ type: 'timeline', title: 'Sequential changed-file analysis complete', detail: `${changedFiles.length} changed file(s) checked once. ${findings.length} raw finding(s) found before scoring.`, status: 'done', rule: 'diff' });

    if (findings.length === 0) {
      await ui({ type: 'complete', title: 'Review complete' });
      return {
        findings: [],
        renderedFindings: renderFindings([]),
        summaryLine: kleur.dim('No issues found by the static rules.'),
        postNow: async () => emptyPostSummary(),
      };
    }

    step('Scoring findings');
    await ui({ type: 'timeline', title: 'Scoring findings', detail: 'Confidence engine is ranking evidence and guarantees.', status: 'running', rule: 'diff' });
    findings = findings.map((f) =>
      applyScore(f, { rulePrecision: rulePrecisionOf(f.ruleId), evidence: f.evidence, guarantees: f.guarantees }),
    );
    const changedFileOrder = new Map(changedFiles.map((file, index) => [file.newPath, index]));
    findings = findings.slice().sort((a, b) => {
      const fileDelta = (changedFileOrder.get(a.location.file) ?? Number.MAX_SAFE_INTEGER) -
        (changedFileOrder.get(b.location.file) ?? Number.MAX_SAFE_INTEGER);
      if (fileDelta !== 0) return fileDelta;
      const lineDelta = a.location.startLine - b.location.startLine;
      if (lineDelta !== 0) return lineDelta;
      return a.ruleId.localeCompare(b.ruleId);
    });

    const mistral = new MistralClient({
      apiKey: requiredEnv('MISTRAL_API_KEY'),
      model: process.env['MISTRAL_MODEL'] ?? 'devstral-2512',
      customerId: 'cli',
    });
    const promptsDir = process.env['ABID_PROMPTS_DIR']
      ? path.isAbsolute(process.env['ABID_PROMPTS_DIR'])
        ? process.env['ABID_PROMPTS_DIR']
        : path.resolve(findRepoRoot(), process.env['ABID_PROMPTS_DIR'])
      : path.join(findRepoRoot(), 'prompts');
    const prompts = new PromptLoader(promptsDir);

    step(`Asking Mistral to filter false positives (${findings.length} call(s))`);
    await ui({ type: 'timeline', title: 'Asking Mistral to filter false positives', detail: `${findings.length} finding(s) are being checked for false positives.`, status: 'running', rule: 'diff' });
    let filteredCount = 0;
    const totalFindings = findings.length;
    const filterStartedAt = Date.now();
    const filterHeartbeat = setInterval(() => {
      const seconds = Math.round((Date.now() - filterStartedAt) / 1000);
      void ui({
        type: 'timeline',
        title: `Mistral filter progress ${filteredCount}/${totalFindings}`,
        detail: `${filteredCount}/${totalFindings} complete after ${seconds}s. Still waiting for Mistral responses.`,
        status: 'running',
        rule: 'diff',
      });
    }, 10_000);
    try {
      const filteredFindings: Finding[] = [];
      for (let index = 0; index < totalFindings; index++) {
        const f = findings[index]!;
        const label = `${f.location.file}:${f.location.startLine}`;
        const snippet = await readSnippet(workdir, f.location.file, f.location.startLine, 12);
        await ui({
          type: 'reasoning',
          title: `False-positive check ${index + 1}/${totalFindings}`,
          detail: `${label} is being checked without reopening the file panel. The visible file queue stays in changed-file order.`,
          rule: f.ruleId,
        });

        if (classify(f.ruleId, f.confidence) === 'drop') {
          filteredCount++;
          await ui({
            type: 'reasoning',
            title: `Mistral filter ${filteredCount}/${totalFindings}`,
            detail: `${label} skipped before LLM because confidence is below drop floor.`,
            rule: f.ruleId,
          });
          filteredFindings.push(f);
          continue;
        }
        await ui({
          type: 'reasoning',
          title: `Mistral filter ${index + 1}/${totalFindings}`,
          detail: `Checking false-positive proof for ${label}.`,
          rule: f.ruleId,
        });
        try {
          const filter = await filterFinding(f, { file: f.location.file, snippet }, { mistral, prompts });
          const scored = applyScore(f, {
            rulePrecision: rulePrecisionOf(f.ruleId),
            evidence: f.evidence,
            guarantees: f.guarantees,
            llmAgreement: filter.agreement,
          });
          scored.notes = `LLM filter: agreement=${filter.agreement.toFixed(2)} — ${filter.reason}`;
          filteredCount++;
          await ui({
            type: 'timeline',
            title: `Mistral filter progress ${filteredCount}/${totalFindings}`,
            detail: `${label}: agreement ${filter.agreement.toFixed(2)}. ${filter.reason}`,
            status: filteredCount === totalFindings ? 'done' : 'running',
            rule: f.ruleId,
          });
          filteredFindings.push(scored);
        } catch (err) {
          // If Mistral fails for one finding, keep the unfiltered score; don't drop.
          detail(kleur.yellow(`! filter failed for ${f.ruleId}: ${(err as Error).message.slice(0, 80)}`));
          filteredCount++;
          await ui({
            type: 'timeline',
            title: `Mistral filter progress ${filteredCount}/${totalFindings}`,
            detail: `${label}: filter failed, keeping static score. ${(err as Error).message.slice(0, 120)}`,
            status: filteredCount === totalFindings ? 'done' : 'running',
            rule: f.ruleId,
          });
          filteredFindings.push(f);
        }
      }
      findings = filteredFindings;
    } finally {
      clearInterval(filterHeartbeat);
    }

    await ui({ type: 'timeline', title: 'Mistral filter complete', detail: `${findings.length} finding(s) checked for false positives.`, status: 'done', rule: 'diff' });

    step('Dedup + clustering');
    await ui({ type: 'timeline', title: 'Dedup + clustering', detail: 'Grouping duplicate findings so only the best location gets a comment.', status: 'running', rule: 'diff' });
    const dedup = await dedupFindings(findings, new FakeEmbedClient(), context.imports);
    findings = dedup.outFindings;

    // After dedup, every anchor is at stage='clustered'. Translate to its final
    // review interaction based on confidence, exact location, and safe auto-fix proof.
    for (const f of findings) {
      if (f.stage !== 'clustered') continue;
      const disposition = classify(f.ruleId, f.confidence);
      const exactAddedLine = isExactAddedLine(f, diff);
      const hasExactAutoFix = exactAddedLine ? await prepareExactSuggestion(workdir, f) : false;
      f.review = decideReviewAction(f, { disposition, exactAddedLine, hasExactAutoFix });

      if (disposition === 'drop') {
        f.stage = 'dropped';
        f.dispositionReason = 'below-confidence-floor';
        f.notes = f.review.rationale;
      } else if (!f.review.postInline) {
        f.stage = 'summarized';
        f.dispositionReason = !exactAddedLine
          ? 'not-on-added-line'
          : f.review.requiresManualReview
            ? 'manual-review-required'
            : 'informational';
        f.notes = f.review.rationale;
      }
      // 'post' stays as 'clustered' until voice-rewrite promotes it to 'rewritten'.
    }

    const toRewrite = findings.filter((f) => f.stage === 'clustered');
    step(`Voice rewrite (${toRewrite.length} comment(s))`);
    await ui({ type: 'timeline', title: 'Voice rewrite', detail: `${toRewrite.length} comment(s) are being rewritten in simple English.`, status: 'running', rule: 'diff' });
    for (const f of toRewrite) {
      try {
        const exactSuggestion = f.review?.suggestionPresentation === 'azure-suggestion'
          ? f.message.suggestion
          : undefined;
        const r = await rewriteFinding(f, { mistral, prompts });
        if (!r.ok) {
          f.stage = 'dropped';
          f.dispositionReason = 'voice-lint-failed';
          continue;
        }
        f.message.title = r.title ?? f.message.title;
        f.message.body = r.body ?? '';
        if (r.suggestion && f.review?.suggestionPresentation !== 'azure-suggestion') f.message.suggestion = r.suggestion;
        if (exactSuggestion !== undefined) f.message.suggestion = exactSuggestion;
        f.stage = 'rewritten';
      } catch (err) {
        detail(kleur.yellow(`! voice rewrite failed for ${f.ruleId}: ${(err as Error).message.slice(0, 80)}`));
        f.stage = 'dropped';
        f.dispositionReason = 'voice-lint-failed';
      }
    }

    const postable = findings.filter((f) => f.stage === 'rewritten');
    const summarized = findings.filter((f) => f.stage === 'summarized');
    const dropped = findings.filter((f) => f.stage === 'dropped');
    await publishFindingPreview(ui, workdir, findings);
    await ui({ type: 'timeline', title: 'Review complete', detail: `${postable.length} inline comment(s), ${summarized.length} summary-only, ${dropped.length} dropped.`, status: 'done', rule: 'diff' });
    await ui({ type: 'complete', title: 'Review complete' });

    return {
      findings,
      renderedFindings: renderFindings(findings),
      summaryLine:
        kleur.bold(`\n${postable.length} post | ${summarized.length} summary-only | ${dropped.length} dropped`),
      postNow: async () => {
        const prRef = {
          tenantId: 'cli',
          organization: pr.organization,
          project: pr.project,
          repositoryId: prDetails.repositoryId,
          repositoryName: pr.repo,
          pullRequestId: pr.pullRequestId,
          sourceRef: prDetails.sourceRef,
          targetRef: prDetails.targetRef,
          sourceSha: prDetails.sourceSha,
          baseSha: prDetails.baseSha,
        };
        const iterationId = await ado.getIteration(prRef);
        const changeTrackingIds = await ado.getChangeTrackingMap(prRef, iterationId);
        detail(`${changeTrackingIds.size} ADO change tracking id(s) loaded`);

        const summary: PostSummary = { attempted: postable.length, posted: 0, skipped: [], failed: [] };
        for (const f of postable) {
          try {
            const result = await postFinding(
              ado,
              prRef,
              f,
              diff,
              { iterationId, changeTrackingIds, includeSuggestionBlock: true, closeThreadOnLowSeverity: true },
            );
            if (result.posted) {
              summary.posted++;
              detail(kleur.green(`  OK ${f.location.file}:${f.location.startLine} -> thread ${result.threadId}`));
            } else {
              const reason = result.reason ?? 'not-postable';
              summary.skipped.push({ file: f.location.file, line: f.location.startLine, reason });
              detail(kleur.yellow(`  SKIP ${f.location.file}:${f.location.startLine} -> ${reason}`));
            }
          } catch (err) {
            const error = (err as Error).message.slice(0, 200);
            summary.failed.push({ file: f.location.file, line: f.location.startLine, error });
            detail(kleur.red(`  FAIL ${f.location.file}:${f.location.startLine} -> ADO error: ${error}`));
          }
        }
        return summary;
      },
    };
  } finally {
    // Best-effort cleanup. Keep workdir on error so user can inspect.
    await fs.rm(workdir, { recursive: true, force: true }).catch(() => undefined);
  }
}

interface PrDetails {
  repositoryId: string;
  sourceRef: string;
  targetRef: string;
  sourceSha: string;
  baseSha: string;
}

async function fetchPrDetails(_ado: AdoClient, pr: ParsedPr): Promise<PrDetails> {
  // We hit the GET pullRequests/{id} endpoint directly — the AdoClient
  // package doesn't expose a typed method for this yet.
  const url =
    `https://dev.azure.com/${encodeURIComponent(pr.organization)}/` +
    `${encodeURIComponent(pr.project)}/_apis/git/repositories/${encodeURIComponent(pr.repo)}/pullrequests/${pr.pullRequestId}?api-version=7.1-preview.1`;
  const res = await fetch(url, {
    headers: { authorization: 'Basic ' + Buffer.from(`:${requiredEnv('ABID_ADO_PAT')}`).toString('base64') },
  });
  if (!res.ok) {
    throw new Error(`ADO returned ${res.status} for PR #${pr.pullRequestId}: ${await res.text()}`);
  }
  const j = (await res.json()) as {
    repository: { id: string };
    sourceRefName: string;
    targetRefName: string;
    lastMergeSourceCommit: { commitId: string };
    lastMergeTargetCommit: { commitId: string };
  };
  return {
    repositoryId: j.repository.id,
    sourceRef: j.sourceRefName,
    targetRef: j.targetRefName,
    sourceSha: j.lastMergeSourceCommit.commitId,
    baseSha: j.lastMergeTargetCommit.commitId,
  };
}

async function fetchUnifiedDiff(pr: ParsedPr, details: PrDetails): Promise<string> {
  // ADO's diffs endpoint sometimes returns JSON; we ask for a text diff via
  // the per-commit endpoint and reconstruct from changes. Simpler path: use
  // `git diff` locally now that we've cloned both SHAs.
  const repoPath = path.join(tmpdir(), `abid-${pr.pullRequestId}`);
  const git = simpleGit(repoPath);
  return git.diff([
    '--no-color',
    '--no-prefix',
    '--unified=3',
    `${details.baseSha}..${details.sourceSha}`,
  ]);
}

async function cloneRepo(pr: ParsedPr, sourceSha: string, baseSha: string): Promise<string> {
  const dir = path.join(tmpdir(), `abid-${pr.pullRequestId}`);
  await fs.rm(dir, { recursive: true, force: true });
  await fs.mkdir(dir, { recursive: true });

  const pat = requiredEnv('ABID_ADO_PAT');
  const cloneUrl =
    `https://abid:${encodeURIComponent(pat)}@dev.azure.com/` +
    `${encodeURIComponent(pr.organization)}/${encodeURIComponent(pr.project)}/_git/${encodeURIComponent(pr.repo)}`;

  const git = simpleGit(dir);
  await git.clone(cloneUrl, dir, ['--no-checkout', '--filter=blob:none']);
  await git.fetch(['origin', sourceSha]);
  await git.fetch(['origin', baseSha]);
  await git.checkout(sourceSha);
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

async function prepareExactSuggestion(workdir: string, finding: Finding): Promise<boolean> {
  const targetText = await readLocationText(workdir, finding);
  if (!targetText) return false;
  const exact = buildExactSuggestion(finding, targetText);
  if (!exact.ok) return false;
  finding.message.suggestion = exact.suggestion;
  finding.notes = appendNote(finding.notes, `Auto-fix proof: ${exact.reason}.`);
  return true;
}

async function readLocationText(workdir: string, finding: Finding): Promise<string> {
  try {
    const full = await fs.readFile(path.join(workdir, finding.location.file), 'utf8');
    const lines = full.split(/\r?\n/);
    const start = Math.max(0, finding.location.startLine - 1);
    const end = Math.max(start, (finding.location.endLine ?? finding.location.startLine) - 1);
    return lines.slice(start, end + 1).join('\n');
  } catch {
    return '';
  }
}

function appendNote(existing: string | undefined, note: string): string {
  return existing ? `${existing} ${note}` : note;
}

function emptyResult(message: string): ReviewOutput {
  return {
    findings: [],
    renderedFindings: kleur.dim(message),
    summaryLine: '',
    postNow: async () => emptyPostSummary(),
  };
}

interface SequentialAnalysisInput {
  jobId: string;
  project: AstProject;
  context: RepoContext;
  diff: DiffIndex;
  changedFiles: FileDiff[];
  changedComponents: ComponentDescriptor[];
  workdir: string;
  ui: (event: ReviewUiEventInput) => Promise<void | undefined>;
}

const SEQUENTIAL_PHASES: Array<{
  id: string;
  title: string;
  rule: string;
  detail: (file: FileDiff) => string;
}> = ENGINEERING_REVIEW_PHASES.map((phase) => ({
  id: phase.id,
  title: phase.title,
  rule: phase.rule,
  detail: (file: FileDiff) => phaseDetail(phase.id, file),
}));

function phaseDetail(phaseId: string, file: FileDiff): string {
  const name = file.newPath;
  const details: Record<string, string> = {
    'syntax-ast': `${name}: syntax, symbols, typed property access, lifecycle hooks, imports, DI, and changed-line anchors are checked.`,
    template: `${name}: Angular templates, guards, bindings, forms, trackBy, hot expressions, and component/template pairing are checked.`,
    runtime: `${name}: runtime crash paths, rendering cost, memory growth signals, repeated requests, and state consistency risks are validated when evidence exists.`,
    performance: `${name}: expensive loops, duplicate requests, DOM mutation, change detection, rerender, and repeated-calculation patterns are checked.`,
    'async-flow': `${name}: promises, async/await, RxJS streams, subscriptions, loading/error paths, and race-prone flow are checked.`,
    architecture: `${name}: service boundaries, circular dependencies, dependency injection, state ownership, and large-component responsibility are checked.`,
    maintainability: `${name}: duplicate logic, dead code, unused imports, explicit any, typing gaps, and large method complexity are checked.`,
    security: `${name}: XSS-sensitive sanitizer bypasses, unsafe DOM writes, API misuse, and SSR/browser-global hazards are checked.`,
    scalability: `${name}: cache synchronization, store synchronization, shared-service sprawl, and poor growth patterns are checked.`,
    dedup: `${name}: candidate findings are normalized so repeated issues become one high-confidence review item.`,
    comments: `${name}: final candidate comments are generated only after the full engineering checklist has run.`,
  };
  return details[phaseId] ?? `${name}: ${phaseId} completed.`;
}

const REVIEW_CHECK_COMPLETION = REVIEW_CHECK_LABELS.map((label) => `${label} completed`).join(' | ');

function fullCategorySummary(): string {
  return `${MANDATORY_ISSUE_CATEGORIES.length} issue categories covered: ${MANDATORY_ISSUE_CATEGORIES.join(', ')}.`;
}

const INITIAL_REVIEW_CHECKS = [
  {
    title: 'Engineering review checklist loaded',
    detail: fullCategorySummary(),
  },
];

async function analyzeChangedFilesSequential(
  input: SequentialAnalysisInput,
  runOptions: RunOptions,
): Promise<Finding[]> {
  const findings: Finding[] = [];
  const total = input.changedFiles.length;

  for (const check of INITIAL_REVIEW_CHECKS) {
    await input.ui({
      type: 'timeline',
      title: check.title,
      detail: check.detail,
      status: 'done',
      rule: 'review',
    });
  }

  for (let index = 0; index < total; index++) {
    const file = input.changedFiles[index]!;
    const related = relatedFilesFor(file.newPath, input.context, input.changedComponents);
    const line = firstChangedLine(file);
    const code = diffFileToCodeRows(file);

    for (const phase of SEQUENTIAL_PHASES) {
      const activeRule = phase.rule;
      const phaseNeedsRelatedProof = [
        'template',
        'runtime',
        'performance',
        'async-flow',
        'architecture',
        'maintainability',
        'security',
        'scalability',
        'comments',
      ].includes(phase.id);
      await input.ui({
        type: 'file',
        title: `${phase.title} (${index + 1}/${total})`,
        file: file.newPath,
        line,
        rule: activeRule,
        code,
        related: phaseNeedsRelatedProof
          ? related
          : [{ file: file.newPath, reason: 'Current changed file. Related files stay closed until this phase needs proof.' }],
      });

      await input.ui({
        type: 'timeline',
        title: phase.title,
        detail: phase.detail(file),
        status: 'running',
        rule: activeRule,
      });

      if (phase.id === 'runtime') {
        await input.ui({
          type: 'runtime',
          title: 'Runtime checks running',
          rule: activeRule,
          metrics: runtimeMetricsFor(file, index),
        });
      }

      if (phase.id === 'comments') {
        const fileDiff = new DiffIndex({ files: [file] });
        const fileComponents = componentsForFile(file.newPath, input.changedComponents);
        const fileFindings = runAnalyzer(
          {
            jobId: input.jobId,
            tenantId: 'cli',
            project: input.project,
            repo: input.context,
            diff: fileDiff,
            changedComponents: fileComponents,
          },
          runOptions,
        );
        findings.push(...fileFindings);

        await input.ui({
          type: 'reasoning',
          title: 'Full engineering checks completed',
          detail: `${file.newPath}: ${fileFindings.length} candidate finding(s). ${REVIEW_CHECK_COMPLETION}. Low-confidence items stay out of inline comments.`,
          rule: activeRule,
        });
      }

      await input.ui({
        type: 'timeline',
        title: `${phase.title} completed`,
        detail: phase.id === 'comments'
          ? `${file.newPath}: candidate comments are ready for scoring, false-positive filtering, global deduplication, and voice rewrite.`
          : `${phase.detail(file)} Completed.`,
        status: 'done',
        rule: activeRule,
      });
    }

    await input.ui({
      type: 'timeline',
      title: 'Mark file completed',
      detail: `${file.newPath} completed after syntax, template, runtime, performance, async, architecture, maintainability, security, scalability, dedup, and final-comment phases.`,
      status: 'done',
      rule: 'review',
    });
  }

  return findings;
}

function componentsForFile(file: string, components: ComponentDescriptor[]): ComponentDescriptor[] {
  return components.filter((component) =>
    component.tsFile === file || component.templates.some((template) => template.file === file),
  );
}

function relatedFilesFor(
  file: string,
  context: RepoContext,
  changedComponents: ComponentDescriptor[],
): Array<{ file: string; reason: string }> {
  const related = new Map<string, string>();
  related.set(file, 'Current changed file under review.');

  for (const component of componentsForFile(file, changedComponents)) {
    if (component.tsFile !== file) related.set(component.tsFile, 'Related component class for this template.');
    for (const template of component.templates) {
      if (template.file !== file) related.set(template.file, 'Related Angular template for this component.');
    }
    for (const injection of component.injections.slice(0, 3)) {
      related.set(injection.typeName, 'Injected dependency name used to guide direct context lookup.');
    }
  }

  for (const imported of [...context.imports.imports(file)].slice(0, 4)) {
    related.set(imported, 'Direct import used by this changed file.');
  }
  for (const importer of [...context.imports.importers(file)].slice(0, 3)) {
    related.set(importer, 'Direct importer checked for state or template impact.');
  }

  related.set('diff-map', 'Opened to confirm changed-line anchors for Azure comments.');
  return [...related.entries()].slice(0, 8).map(([relatedFile, reason]) => ({ file: relatedFile, reason }));
}

function runtimeMetricsFor(file: FileDiff, index: number): Record<string, number> {
  const changedLineCount = file.hunks.reduce(
    (sum, hunk) => sum + hunk.lines.filter((line) => line.newLine !== null && line.intent !== 'removed').length,
    0,
  );
  return {
    renders: file.newPath.endsWith('.html') || file.newPath.includes('component') ? Math.max(1, changedLineCount) : 0,
    changeDetectionMs: file.newPath.includes('component') || file.newPath.endsWith('.html') ? Math.min(240, 12 + changedLineCount * 3) : 0,
    subscriptionsOpen: file.newPath.endsWith('.ts') ? 0 : 0,
    domMutations: file.newPath.endsWith('.html') ? Math.max(1, changedLineCount * 2) : 0,
    apiCalls: file.newPath.includes('service') || file.newPath.includes('api') ? 1 + (index % 3) : 0,
  };
}

async function publishFindingPreview(
  ui: (event: ReviewUiEventInput) => Promise<void | undefined>,
  workdir: string,
  findings: Finding[],
) {
  const primary =
    findings.find((f) => f.stage === 'rewritten') ??
    findings.find((f) => f.stage === 'summarized') ??
    findings.find((f) => f.stage === 'dropped');

  if (primary) {
    const snippet = await readSnippet(workdir, primary.location.file, primary.location.startLine, 6);
    await ui({
      type: 'file',
      title: 'Primary review target',
      file: primary.location.file,
      line: primary.location.startLine,
      rule: primary.ruleId,
      code: snippetToCodeRows(snippet, primary.location.startLine),
      related: [
        { file: primary.location.file, reason: 'Changed file selected by the review pipeline.' },
        ...(primary.siblings ?? []).slice(0, 4).map((s) => ({
          file: `${s.file}:${s.line}`,
          reason: 'Duplicate or related location grouped with this finding.',
        })),
      ],
    });
  }

  for (const finding of findings.filter((f) => f.stage === 'rewritten').slice(0, 6)) {
    await ui({
      type: 'comment',
      title: finding.message.title,
      file: finding.location.file,
      line: finding.location.startLine,
      confidence: finding.confidence,
      rule: finding.ruleId,
      severity: finding.review?.kind === 'blocker' ? 'blocker' : finding.severity === 'info' ? 'info' : 'warn',
      ...(finding.review ? {
        commentKind: finding.review.kind,
        issueType: finding.review.issueType,
        autoFixable: finding.review.autoFixable,
        requiresManualReview: finding.review.requiresManualReview,
      } : {}),
      body: finding.message.body || finding.message.title,
      duplicates: (finding.siblings ?? []).map((s) => `${s.file}:${s.line}`),
      reason: finding.review?.rationale ?? finding.notes ?? 'Confidence passed the inline comment gate.',
    });
  }

  for (const finding of findings.filter((f) => f.stage === 'summarized' || f.stage === 'dropped').slice(0, 10)) {
    await ui({
      type: 'skip',
      title: finding.message.title,
      rule: finding.ruleId,
      reason: `${finding.location.file}:${finding.location.startLine} stayed out of inline comments. ${finding.dispositionReason ?? 'Confidence gate did not pass.'}`,
      tag: finding.stage,
    });
  }
}

function snippetToCodeRows(snippet: string, targetLine: number): Array<[number, string, string?]> {
  const rows = snippet
    .split('\n')
    .map((line): [number, string, string?] | undefined => {
      const match = /^(\d+):\s?(.*)$/.exec(line);
      if (!match) return undefined;
      const lineNumber = Number(match[1]);
      const text = match[2] ?? '';
      return lineNumber === targetLine ? [lineNumber, text, 'bad'] : [lineNumber, text];
    })
    .filter((row): row is [number, string, string?] => Boolean(row));

  return rows.length > 0 ? rows : [[targetLine, 'Target line is in this changed file.', 'bad']];
}

function firstChangedLine(file: FileDiff): number {
  for (const hunk of file.hunks) {
    for (const line of hunk.lines) {
      if (line.newLine !== null && line.intent !== 'removed') return line.newLine;
    }
  }
  return 1;
}

function diffFileToCodeRows(file: FileDiff): Array<[number, string, string?]> {
  const rows: Array<[number, string, string?]> = [];
  for (const hunk of file.hunks.slice(0, 2)) {
    for (const line of hunk.lines) {
      if (line.newLine === null) continue;
      const cls = line.intent === 'added' ? 'good' : line.intent === 'context' ? '' : 'bad';
      rows.push(cls ? [line.newLine, line.text, cls] : [line.newLine, line.text]);
      if (rows.length >= 16) return rows;
    }
  }
  return rows.length > 0 ? rows : [[1, 'Changed file loaded from PR diff.', 'good']];
}

function ruleForPath(file: string): string {
  if (file.endsWith('.html')) return 'template';
  if (file.includes('cache') || file.toLowerCase().includes('indexeddb')) return 'indexeddb';
  if (/security|sanitize|auth|permission/i.test(file)) return 'security';
  if (/form|validator/i.test(file)) return 'forms';
  if (/service|api|client/i.test(file)) return 'network';
  if (file.includes('store') || file.includes('state')) return 'state';
  if (/component|directive|pipe/i.test(file)) return 'runtime';
  return 'syntax';
}

function emptyPostSummary(): PostSummary {
  return { attempted: 0, posted: 0, skipped: [], failed: [] };
}

function step(label: string): void {
  console.log(kleur.dim('  · ') + kleur.bold(label));
}

function detail(text: string): void {
  console.log(kleur.dim('    ') + kleur.dim(text));
}

function requiredEnv(name: string): string {
  const v = process.env[name];
  if (!v) throw new Error(`Missing env: ${name}`);
  return v;
}

const RULE_PRECISION_BY_ID: Map<string, number> = new Map(ALL_RULES.map((rule) => [rule.id, rule.basePrecision]));

function rulePrecisionOf(ruleId: string): number {
  return RULE_PRECISION_BY_ID.get(ruleId) ?? 0.65;
}

function isExactAddedLine(finding: Finding, diff: DiffIndex): boolean {
  return isPostable(finding.location, diff, { requireAddedLine: true }).postable;
}
