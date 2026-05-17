import { spawn, type ChildProcess } from 'node:child_process';
import { existsSync } from 'node:fs';
import path from 'node:path';
import { setTimeout as sleep } from 'node:timers/promises';
import kleur from 'kleur';
import { findRepoRoot } from './paths.js';

export type ReviewUiHandle = {
  url: string;
  apiBase: string;
  jobId: string;
  server?: ChildProcess;
};

export type ReviewUiEventInput =
  | { type: 'timeline'; title: string; detail: string; status: 'running' | 'done' | 'skipped'; rule?: string; confidence?: number }
  | { type: 'queue'; title: string; files: Array<{ file: string; reason?: string; rule?: string }> }
  | { type: 'file'; title: string; file: string; line?: number; rule?: string; code?: Array<[number, string, string?]>; related: Array<{ file: string; reason: string }> }
  | { type: 'reasoning'; title: string; detail: string; rule?: string; confidenceDelta?: number }
  | { type: 'runtime'; title: string; rule?: string; metrics: Record<string, number> }
  | { type: 'skip'; title: string; rule: string; reason: string; tag: string }
  | { type: 'comment'; title: string; file: string; line: number; confidence: number; rule?: string; severity?: 'warn' | 'info'; body?: string; duplicates?: string[]; reason: string }
  | { type: 'complete'; title: string };

export async function ensureReviewUi(): Promise<ReviewUiHandle | undefined> {
  if (process.env['ABID_REVIEW_UI'] === '0') return undefined;

  let port = Number(process.env['ABID_REVIEW_UI_PORT'] ?? process.env['PORT'] ?? 8081);
  port = await selectUiPort(port);
  const jobId = process.env['ABID_REVIEW_UI_JOB'] ?? 'cli-live';
  const apiBase = `http://localhost:${port}`;
  const url = `${apiBase}/review-ui?jobId=${encodeURIComponent(jobId)}`;

  if ((await probeApi(port)) === 'compatible') {
    openBrowser(url);
    console.log(kleur.dim(`  Review UI opened: ${url}`));
    return { url, apiBase, jobId };
  }

  const server = startApiServer(port);
  server.on('error', () => {
    // The readiness check below prints the useful user-facing message.
  });
  const ready = await waitForApi(port, 12_000);
  if (!ready) {
    console.log(kleur.yellow(`  Review UI server did not start on port ${port}. Run "pnpm dev:api" if you want the dashboard.`));
    return { url, apiBase, jobId, server };
  }

  openBrowser(url);
  console.log(kleur.dim(`  Review UI opened: ${url}`));
  return { url, apiBase, jobId, server };
}

export async function resetReviewUi(handle: ReviewUiHandle | undefined) {
  if (!handle) return;
  await postToReviewUi(handle, `/api/reviews/${encodeURIComponent(handle.jobId)}/reset`, {});
}

export async function publishReviewUiEvent(handle: ReviewUiHandle | undefined, event: ReviewUiEventInput) {
  if (!handle) return;
  await postToReviewUi(handle, `/api/reviews/${encodeURIComponent(handle.jobId)}/events`, event);
}

export function stopReviewUi(handle: ReviewUiHandle | undefined) {
  if (!handle?.server || handle.server.killed) return;
  try {
    handle.server.kill();
  } catch {
    // Best effort only. The CLI should never fail while closing the helper UI.
  }
}

function startApiServer(port: number): ChildProcess {
  const repoRoot = findRepoRoot();
  const tsxCli = resolveTsxCli(repoRoot);
  const command = process.execPath;
  const args = [tsxCli, 'apps/api/src/server.ts'];
  return spawn(command, args, {
    cwd: repoRoot,
    env: {
      ...process.env,
      PORT: String(port),
      OPEN_REVIEW_UI: '0',
    },
    stdio: 'ignore',
    windowsHide: true,
  });
}

function resolveTsxCli(repoRoot: string): string {
  const candidates = [
    path.join(repoRoot, 'node_modules/tsx/dist/cli.mjs'),
    path.join(repoRoot, 'apps/cli/node_modules/tsx/dist/cli.mjs'),
  ];

  const found = candidates.find((candidate) => existsSync(candidate));
  if (!found) throw new Error('tsx CLI not found. Run pnpm install before starting the review UI.');
  return found;
}

async function waitForApi(port: number, timeoutMs: number) {
  const deadline = Date.now() + timeoutMs;
  while (Date.now() < deadline) {
    if ((await probeApi(port)) === 'compatible') return true;
    await sleep(300);
  }
  return false;
}

async function selectUiPort(preferredPort: number) {
  for (let offset = 0; offset < 10; offset++) {
    const port = preferredPort + offset;
    const status = await probeApi(port);
    if (status === 'compatible' || status === 'empty') return port;
  }
  return preferredPort;
}

async function probeApi(port: number): Promise<'compatible' | 'occupied' | 'empty'> {
  try {
    const response = await fetch(`http://127.0.0.1:${port}/healthz`, { signal: AbortSignal.timeout(900) });
    if (!response.ok) return 'occupied';
    const body = (await response.json().catch(() => undefined)) as { reviewUi?: string } | undefined;
    return body?.reviewUi === 'live-bridge-v1' ? 'compatible' : 'occupied';
  } catch {
    return 'empty';
  }
}

function openBrowser(url: string) {
  const command =
    process.platform === 'win32'
      ? 'cmd'
      : process.platform === 'darwin'
        ? 'open'
        : 'xdg-open';
  const args = process.platform === 'win32' ? ['/c', 'start', '', url] : [url];

  try {
    const child = spawn(command, args, { detached: true, stdio: 'ignore', windowsHide: true });
    child.unref();
  } catch {
    console.log(kleur.yellow(`  Could not auto-open browser. Open this URL manually: ${url}`));
  }
}

async function postToReviewUi(handle: ReviewUiHandle, path: string, body: unknown) {
  try {
    await fetch(`${handle.apiBase}${path}`, {
      method: 'POST',
      headers: { 'content-type': 'application/json' },
      body: JSON.stringify(body),
      signal: AbortSignal.timeout(1_500),
    });
  } catch {
    // The dashboard is a helper. Review must continue even if the browser UI is closed.
  }
}
