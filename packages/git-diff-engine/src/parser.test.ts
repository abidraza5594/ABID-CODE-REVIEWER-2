import { describe, expect, it } from 'vitest';
import { parseUnifiedDiff } from './parser.js';
import { DiffIndex } from './line-map.js';
import { isPostable } from './postable.js';

const SAMPLE = `diff --git a/src/app/user.component.ts b/src/app/user.component.ts
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

describe('parseUnifiedDiff', () => {
  it('parses a single-hunk modify', () => {
    const parsed = parseUnifiedDiff(SAMPLE);
    expect(parsed.files).toHaveLength(1);
    const file = parsed.files[0]!;
    expect(file.newPath).toBe('src/app/user.component.ts');
    expect(file.status).toBe('modified');
    expect(file.binary).toBe(false);
    expect(file.hunks).toHaveLength(1);
    const hunk = file.hunks[0]!;
    expect(hunk.oldStart).toBe(10);
    expect(hunk.newStart).toBe(10);
    const intents = hunk.lines.map((l) => l.intent);
    expect(intents).toContain('added');
    expect(intents).toContain('removed');
  });

  it('builds a line map and identifies postable lines', () => {
    const parsed = parseUnifiedDiff(SAMPLE);
    const index = new DiffIndex(parsed);
    const addedLine = [...index.lineMap('src/app/user.component.ts')!.addedNewLines][0]!;
    const result = isPostable(
      { file: 'src/app/user.component.ts', startLine: addedLine },
      index,
      { requireAddedLine: true },
    );
    expect(result.postable).toBe(true);
  });

  it('rejects posting on a file not in the diff', () => {
    const parsed = parseUnifiedDiff(SAMPLE);
    const index = new DiffIndex(parsed);
    const result = isPostable(
      { file: 'src/app/other.ts', startLine: 1 },
      index,
    );
    expect(result.postable).toBe(false);
    expect(result.reason).toBe('file-not-in-diff');
  });
});
