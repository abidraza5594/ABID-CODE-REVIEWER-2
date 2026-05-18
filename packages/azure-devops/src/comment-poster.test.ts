import { describe, expect, it } from 'vitest';
import type { Finding, PullRequestRef } from '@abid/core';
import { DiffIndex, parseUnifiedDiff } from '@abid/git-diff-engine';
import type { AdoClient, AdoThreadRequest } from './client.js';
import { postFinding } from './comment-poster.js';

const DIFF = `diff --git a/src/app/user.component.ts b/src/app/user.component.ts
--- a/src/app/user.component.ts
+++ b/src/app/user.component.ts
@@ -10,5 +10,7 @@ export class UserComponent {
   ngOnInit() {
-    this.userService.users$.subscribe(u => this.users = u);
+    this.userService.users$
+      .pipe(takeUntilDestroyed(this.destroyRef))
+      .subscribe(u => this.users = u);
   }
 }
`;

const PR: PullRequestRef = {
  tenantId: 'test',
  organization: 'org',
  project: 'proj',
  repositoryId: 'repo-id',
  repositoryName: 'repo',
  pullRequestId: 42,
  sourceRef: 'refs/heads/feature',
  targetRef: 'refs/heads/main',
  sourceSha: 'head',
  baseSha: 'base',
};

describe('postFinding', () => {
  it('posts an inline ADO thread with changeTrackingId and iteration context', async () => {
    const posted: AdoThreadRequest[] = [];
    const ado = {
      postThread: async (_pr: PullRequestRef, thread: AdoThreadRequest) => {
        posted.push(thread);
        return { id: 123, status: 'active' };
      },
    } as unknown as AdoClient;

    const result = await postFinding(ado, PR, findingAt(11), diff(), {
      iterationId: 4,
      changeTrackingIds: new Map([['src/app/user.component.ts', 9]]),
      includeSuggestionBlock: true,
    });

    expect(result).toEqual({ posted: true, threadId: 123 });
    expect(posted).toHaveLength(1);
    expect(posted[0]!.threadContext).toEqual({
      filePath: '/src/app/user.component.ts',
      rightFileStart: { line: 11, offset: 1 },
      rightFileEnd: { line: 11, offset: 1 },
    });
    expect(posted[0]!.pullRequestThreadContext).toEqual({
      changeTrackingId: 9,
      iterationContext: { firstComparingIteration: 4, secondComparingIteration: 4 },
    });
    expect(posted[0]!.comments[0]).toMatchObject({
      parentCommentId: 0,
      commentType: 'text',
      content: expect.stringContaining('This subscription is not cleaned up.'),
    });
  });

  it('skips when ADO change tracking is required but missing for the path', async () => {
    const ado = {
      postThread: async () => {
        throw new Error('should not post');
      },
    } as unknown as AdoClient;

    const result = await postFinding(ado, PR, findingAt(11), diff(), {
      iterationId: 4,
      changeTrackingIds: new Map(),
    });

    expect(result).toEqual({ posted: false, reason: 'change-tracking-id-missing' });
  });

  it('skips unchanged context lines so comments stay on exact new code', async () => {
    const ado = {
      postThread: async () => {
        throw new Error('should not post');
      },
    } as unknown as AdoClient;

    const result = await postFinding(ado, PR, findingAt(10), diff(), {
      iterationId: 4,
      changeTrackingIds: new Map([['src/app/user.component.ts', 9]]),
    });

    expect(result).toEqual({ posted: false, reason: 'line-not-in-changed-hunk', fallbackLine: 11 });
  });
});

function diff(): DiffIndex {
  return new DiffIndex(parseUnifiedDiff(DIFF));
}

function findingAt(line: number): Finding {
  const now = new Date(0).toISOString();
  return {
    id: 'finding-1',
    ruleId: 'angular/subscription-leak',
    severity: 'warn',
    confidence: 0.91,
    location: { file: 'src/app/user.component.ts', startLine: line },
    evidence: [{ kind: 'ast', nodeKind: 'CallExpression', description: 'subscribe without cleanup' }],
    guarantees: [],
    message: {
      title: 'Subscription is not cleaned up',
      body: 'This subscription is not cleaned up.',
      suggestion: 'source$.pipe(takeUntilDestroyed(this.destroyRef)).subscribe();',
      suggestionLanguage: 'ts',
    },
    stage: 'rewritten',
    createdAt: now,
    updatedAt: now,
    jobId: 'job-1',
    tenantId: 'test',
  };
}
