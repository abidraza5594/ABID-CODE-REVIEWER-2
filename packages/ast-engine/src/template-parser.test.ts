import { describe, expect, it } from 'vitest';
import { parseTemplateRef } from './template-parser.js';

describe('parseTemplateRef', () => {
  it('maps inline template bindings back to component source lines', () => {
    const sourceFileText = [
      '@Component({',
      '  template: `',
      '    <div>{{ user.name }}</div>',
      '  `',
      '})',
      'export class UserCmp {}',
    ].join('\n');
    const templateSource = [
      '',
      '    <div>{{ user.name }}</div>',
      '  ',
    ].join('\n');
    const startOffset = sourceFileText.indexOf(templateSource);

    const analysis = parseTemplateRef({
      kind: 'inline',
      file: 'src/app/user.component.ts',
      startOffset,
      source: templateSource,
      sourceFileText,
    });

    expect(analysis.bindings).toEqual(
      expect.arrayContaining([
        expect.objectContaining({
          expression: 'user.name',
          line: 3,
        }),
      ]),
    );
  });

  it('keeps external template line numbers template-local', () => {
    const analysis = parseTemplateRef({
      kind: 'external',
      file: 'src/app/user.component.html',
      startOffset: 0,
      source: '<section>\n  {{ total }}\n</section>',
    });

    expect(analysis.bindings[0]?.line).toBe(2);
  });

  it('extracts Angular rendering signals from templates', () => {
    const analysis = parseTemplateRef({
      kind: 'external',
      file: 'src/app/project.component.html',
      startOffset: 0,
      source: [
        '<section *ngIf="project$ | async as project">',
        '  <article *ngFor="let task of project.tasks">',
        '    <div *ngFor="let owner of task.owners">',
        '      <span [ngClass]="{ late: isLate(task), active: owner.active }">{{ project.name | titlecase }}</span>',
        '      {{ project$ | async }}',
        '    </div>',
        '  </article>',
        '</section>',
      ].join('\n'),
    });

    expect(analysis.guards).toEqual(expect.arrayContaining([
      expect.objectContaining({ expression: expect.stringContaining('project$'), kind: 'ngIf' }),
    ]));
    expect(analysis.forLoops).toEqual(expect.arrayContaining([
      expect.objectContaining({ depth: 1, hasTrackBy: false }),
      expect.objectContaining({ depth: 2, hasTrackBy: false }),
    ]));
    expect(analysis.asyncPipes.map((pipe) => pipe.expression)).toContain('project$');
    expect(analysis.pipes).toEqual(expect.arrayContaining([
      expect.objectContaining({ name: 'titlecase' }),
    ]));
    expect(analysis.dynamicBindings).toEqual(expect.arrayContaining([
      expect.objectContaining({ kind: 'class', name: 'ngClass' }),
    ]));
    expect(analysis.rendering.maxLoopDepth).toBe(2);
    expect(analysis.rendering.dynamicClassStyleCount).toBe(1);
  });
});
