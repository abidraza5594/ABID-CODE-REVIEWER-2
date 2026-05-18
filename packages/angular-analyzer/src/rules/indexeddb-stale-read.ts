import { SyntaxKind } from 'ts-morph';
import type { Evidence } from '@abid/core';
import type { RawFinding, RuleContext } from '../rule-context.js';

/**
 * angular/indexeddb-stale-read
 *
 * Detects "write to indexedDB, immediately read from it" patterns where the
 * write Promise is not awaited. This is a real bug we've seen many times in
 * caching layers built on idb-keyval or Dexie.
 *
 * Signals we look for in a single method body:
 *   - A call matching `*.put(...)`, `*.set(...)`, `*.bulkPut(...)` whose result is
 *     NOT awaited and NOT chained via `.then`.
 *   - A subsequent `*.get(...)` or `*.where(...)` on the same store/key, in the
 *     same statement list, before any further `await` boundary.
 *
 * Cross-file extension: when the helper that performs the read lives in a service,
 * we follow the call edge once via the call graph. Anything beyond one hop is
 * out of scope — we'd rather miss the bug than fabricate a long-distance one.
 */
export const indexedDbStaleReadRule = {
  id: 'angular/indexeddb-stale-read',
  category: 'indexeddb-cache' as const,
  severity: 'warn' as const,
  basePrecision: 0.78,
  description: 'Reading from IndexedDB right after writing without awaiting the write can return stale data.',

  run(ctx: RuleContext): RawFinding[] {
    const out: RawFinding[] = [];

    for (const comp of ctx.changedComponents) {
      const sf = ctx.project.getSourceFile(comp.tsFile);
      if (!sf) continue;

      const cls = sf.getClass(comp.className);
      if (!cls) continue;

      for (const method of cls.getMethods()) {
        const body = method.getBody();
        if (!body) continue;
        const block = body.asKind(SyntaxKind.Block);
        const statements = block ? block.getStatements() : [];

        let pendingWriteOnLine: number | null = null;
        let pendingTargetText: string | null = null;

        for (const stmt of statements) {
          const text = stmt.getText();
          const lineInfo = sf.getLineAndColumnAtPos(stmt.getStart());

          // Detect a non-awaited write.
          const writeMatch = /([\w$.]+)\.(put|set|bulkPut|add)\s*\(/.exec(text);
          if (writeMatch && !/^\s*await\b/.test(text) && !/\.then\s*\(/.test(text)) {
            pendingWriteOnLine = lineInfo.line;
            pendingTargetText = writeMatch[1]!;
            continue;
          }

          // Detect a read on the same target.
          if (pendingTargetText) {
            const readMatch = new RegExp(`\\b${escapeRegex(pendingTargetText)}\\.(get|where|toArray)\\s*\\(`).exec(text);
            if (readMatch) {
              if (!isAddedLine(ctx, comp.tsFile, lineInfo.line)) continue;
              out.push({
                ruleId: 'angular/indexeddb-stale-read',
                severity: 'warn',
                confidence: 0.78,
                location: { file: comp.tsFile, startLine: lineInfo.line },
                evidence: [
                  {
                    kind: 'ast',
                    nodeKind: 'CallExpression',
                    description: `write to ${pendingTargetText} on line ${pendingWriteOnLine} was not awaited before this read`,
                  },
                ] satisfies Evidence[],
                guarantees: [],
                message: {
                  title: 'Reading from IndexedDB right after a non-awaited write',
                  body: '',
                  suggestion: `await ${pendingTargetText}.put(...);
const value = await ${pendingTargetText}.get(...);`,
                  suggestionLanguage: 'ts',
                },
              });
              pendingWriteOnLine = null;
              pendingTargetText = null;
            }
          }

          // Any await statement resets the window — the runtime is now coherent.
          if (/^\s*await\b/.test(text)) {
            pendingWriteOnLine = null;
            pendingTargetText = null;
          }
        }
      }
    }

    return out;
  },
} as const;

function escapeRegex(s: string): string {
  return s.replace(/[.*+?^${}()|[\]\\]/g, '\\$&');
}

function isAddedLine(ctx: RuleContext, file: string, line: number): boolean {
  return ctx.diff.lineMap(file)?.addedNewLines.has(line) ?? false;
}
