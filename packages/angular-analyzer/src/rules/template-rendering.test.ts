import { describe, expect, it } from 'vitest';
import type { ComponentDescriptor } from '@abid/ast-engine';
import { DiffIndex, parseUnifiedDiff } from '@abid/git-diff-engine';
import type { RuleContext } from '../rule-context.js';
import {
  dynamicClassStyleBindingRule,
  nestedTemplateLoopRule,
  repeatedAsyncPipeRule,
} from './template-rendering.js';

describe('template rendering rules', () => {
  it('finds repeated async pipe usage in the changed template', () => {
    const ctx = context([
      '<section>',
      '  {{ project$ | async }}',
      '  <span>{{ (project$ | async)?.name }}</span>',
      '</section>',
    ]);

    const findings = repeatedAsyncPipeRule.run(ctx);

    expect(findings).toHaveLength(1);
    expect(findings[0]?.ruleId).toBe('angular/repeated-async-pipe');
  });

  it('finds nested template loops', () => {
    const ctx = context([
      '<section>',
      '  <article *ngFor="let group of groups">',
      '    <span *ngFor="let user of group.users">{{ user.name }}</span>',
      '  </article>',
      '</section>',
    ]);

    const findings = nestedTemplateLoopRule.run(ctx);

    expect(findings).toHaveLength(1);
    expect(findings[0]?.location.startLine).toBe(3);
  });

  it('finds complex dynamic class bindings', () => {
    const ctx = context([
      '<section>',
      '  <span [ngClass]="{ late: isLate(task), urgent: task.priority > 3 && task.open }">{{ task.name }}</span>',
      '</section>',
    ]);

    const findings = dynamicClassStyleBindingRule.run(ctx);

    expect(findings).toHaveLength(1);
    expect(findings[0]?.ruleId).toBe('angular/dynamic-class-style-hot-binding');
  });
});

function context(templateLines: string[]): RuleContext {
  const template = templateLines.join('\n');
  const file = 'src/app/project.component.html';
  const comp: ComponentDescriptor = {
    className: 'ProjectComponent',
    selector: 'app-project',
    standalone: true,
    changeDetection: 'Default',
    tsFile: 'src/app/project.component.ts',
    templates: [{ kind: 'external', file, startOffset: 0, source: template }],
    injections: [],
    destroy: { hasNgOnDestroy: false, hasDestroyRef: false, usesTakeUntilDestroyed: false },
    methods: [],
    fields: [],
    location: { file: 'src/app/project.component.ts', startLine: 1 },
  };

  return {
    jobId: 'job-1',
    tenantId: 'test',
    project: {} as RuleContext['project'],
    repo: {} as RuleContext['repo'],
    diff: new DiffIndex(parseUnifiedDiff(diffFor(file, templateLines))),
    changedComponents: [comp],
  };
}

function diffFor(file: string, lines: string[]): string {
  return `diff --git a/${file} b/${file}
--- a/${file}
+++ b/${file}
@@ -1,0 +1,${lines.length} @@
${lines.map((line) => `+${line}`).join('\n')}
`;
}
