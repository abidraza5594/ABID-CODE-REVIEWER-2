import * as fs from 'node:fs/promises';
import * as path from 'node:path';
import { describe, expect, it } from 'vitest';
import { AstProject } from '@abid/ast-engine';
import { DiffIndex, parseUnifiedDiff } from '@abid/git-diff-engine';
import type { RuleContext } from '../rule-context.js';
import { tsNullDereferenceRule } from './full-engineering.js';

describe('repository-aware nullability proof', () => {
  it('does not warn on imported initialized array constants', async () => {
    const root = await createFixture({
      'src/constants.ts': `
        export const PROJECT_AVAILABILITY_OPTIONS: Array<{ label: string; value: string } | undefined> = [
          { label: 'Open', value: 'open' },
        ];
      `,
      'src/feature.ts': `
        import { PROJECT_AVAILABILITY_OPTIONS } from './constants';

        export const visibleOptions = PROJECT_AVAILABILITY_OPTIONS.slice(1);
      `,
    });

    try {
      const findings = tsNullDereferenceRule.run(context(root, 'src/feature.ts'));
      expect(findings).toHaveLength(0);
    } finally {
      await fs.rm(root, { recursive: true, force: true });
    }
  });

  it('still warns when the traced imported value is truly nullable', async () => {
    const root = await createFixture({
      'src/constants.ts': `
        export const PROJECT_AVAILABILITY_OPTIONS: string[] | undefined = undefined;
      `,
      'src/feature.ts': `
        import { PROJECT_AVAILABILITY_OPTIONS } from './constants';

        export const visibleOptions = PROJECT_AVAILABILITY_OPTIONS.slice(1);
      `,
    });

    try {
      const findings = tsNullDereferenceRule.run(context(root, 'src/feature.ts'));
      expect(findings).toHaveLength(1);
      expect(findings[0]?.notes).toContain('Import trace');
    } finally {
      await fs.rm(root, { recursive: true, force: true });
    }
  });
});

async function createFixture(files: Record<string, string>): Promise<string> {
  const root = await fs.mkdtemp(path.join(process.cwd(), '.tmp-nullability-'));
  await fs.writeFile(path.join(root, 'tsconfig.json'), JSON.stringify({
    compilerOptions: {
      strict: true,
      noUncheckedIndexedAccess: true,
      target: 'ES2022',
      module: 'ESNext',
      moduleResolution: 'Node',
    },
    include: ['src/**/*.ts'],
  }, null, 2));

  for (const [file, text] of Object.entries(files)) {
    const full = path.join(root, file);
    await fs.mkdir(path.dirname(full), { recursive: true });
    await fs.writeFile(full, unindent(text));
  }

  return root;
}

function context(root: string, file: string): RuleContext {
  return {
    jobId: 'job-1',
    tenantId: 'test',
    project: new AstProject(root),
    repo: {} as RuleContext['repo'],
    diff: new DiffIndex(parseUnifiedDiff(diffFor(file))),
    changedComponents: [],
  };
}

function diffFor(file: string): string {
  return `diff --git a/${file} b/${file}
--- a/${file}
+++ b/${file}
@@ -1,0 +1,3 @@
+import { PROJECT_AVAILABILITY_OPTIONS } from './constants';
+
+export const visibleOptions = PROJECT_AVAILABILITY_OPTIONS.slice(1);
`;
}

function unindent(text: string): string {
  const lines = text.replace(/^\n/, '').replace(/\n\s*$/, '\n').split('\n');
  const indent = Math.min(...lines.filter((line) => line.trim()).map((line) => line.match(/^\s*/)?.[0].length ?? 0));
  return lines.map((line) => line.slice(indent)).join('\n');
}
