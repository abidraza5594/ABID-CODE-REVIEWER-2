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
});
