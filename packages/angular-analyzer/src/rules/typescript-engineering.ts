import type { Evidence, Guarantee, SourceLocation } from '@abid/core';
import { Node, SyntaxKind, type CallExpression, type SourceFile } from 'ts-morph';
import type { RawFinding, RuleContext } from '../rule-context.js';

export const deprecatedToPromiseRule = {
  id: 'angular/deprecated-topromise',
  category: 'async-handling' as const,
  severity: 'warn' as const,
  basePrecision: 0.90,
  description: 'RxJS toPromise() is deprecated and hides empty-stream behavior.',

  run(ctx: RuleContext): RawFinding[] {
    const out: RawFinding[] = [];

    for (const { file, sourceFile } of changedTypeScriptFiles(ctx)) {
      sourceFile.forEachDescendant((node) => {
        if (!Node.isCallExpression(node)) return;
        const access = propertyAccessOfCall(node);
        if (!access || access.getName() !== 'toPromise') return;

        const location = locationOf(ctx, sourceFile, node);
        if (!isChangedLine(ctx, file, location.startLine)) return;

        const receiver = access.getExpression().getText();
        out.push({
          ruleId: 'angular/deprecated-topromise',
          severity: 'warn',
          confidence: 0.90,
          location,
          evidence: [{
            kind: 'ast',
            nodeKind: 'CallExpression',
            description: 'toPromise() is used on an Observable',
            snippet: node.getText().slice(0, 160),
          }],
          guarantees: [],
          message: {
            title: 'toPromise() should not be used',
            body: '',
            suggestion: `const value = await firstValueFrom(${receiver});`,
            suggestionLanguage: 'ts',
          },
        });
      });
    }

    return out;
  },
} as const;

export const subscribeMissingErrorHandlerRule = {
  id: 'angular/subscribe-missing-error-handler',
  category: 'error-handling' as const,
  severity: 'warn' as const,
  basePrecision: 0.86,
  description: 'API subscribe() calls should handle failures and reset UI state.',

  run(ctx: RuleContext): RawFinding[] {
    const out: RawFinding[] = [];

    for (const { file, sourceFile } of changedTypeScriptFiles(ctx)) {
      sourceFile.forEachDescendant((node) => {
        if (!Node.isCallExpression(node)) return;
        const access = propertyAccessOfCall(node);
        if (!access || access.getName() !== 'subscribe') return;

        const receiverText = access.getExpression().getText();
        if (!looksLikeFiniteApiObservable(receiverText)) return;
        if (subscribeHasErrorHandler(node)) return;

        const location = locationOf(ctx, sourceFile, node);
        if (!isChangedLine(ctx, file, location.startLine)) return;

        out.push({
          ruleId: 'angular/subscribe-missing-error-handler',
          severity: 'warn',
          confidence: 0.86,
          location,
          evidence: [
            {
              kind: 'ast',
              nodeKind: 'CallExpression',
              description: 'API Observable is subscribed without an error handler',
              snippet: node.getText().slice(0, 180),
            },
            {
              kind: 'network',
              url: receiverText.slice(0, 140),
              count: 1,
              description: 'API flow has no failure path at this call site',
            },
          ],
          guarantees: [],
          message: {
            title: 'API error is not handled',
            body: '',
            suggestion: `${receiverText}.subscribe({
  next: (value) => {
    // keep the success logic here
  },
  error: () => {
    this.loading = false;
  },
});`,
            suggestionLanguage: 'ts',
          },
        });
      });
    }

    return out;
  },
} as const;

export const nestedSubscribeRule = {
  id: 'angular/nested-subscribe',
  category: 'rxjs' as const,
  severity: 'warn' as const,
  basePrecision: 0.82,
  description: 'Nested subscribe() calls make repeated work and race conditions easy.',

  run(ctx: RuleContext): RawFinding[] {
    const out: RawFinding[] = [];

    for (const { file, sourceFile } of changedTypeScriptFiles(ctx)) {
      sourceFile.forEachDescendant((node) => {
        if (!Node.isCallExpression(node)) return;
        const access = propertyAccessOfCall(node);
        if (!access || access.getName() !== 'subscribe') return;

        const outer = enclosingSubscribeCall(node);
        if (!outer) return;

        const location = locationOf(ctx, sourceFile, node);
        if (!isChangedLine(ctx, file, location.startLine)) return;

        out.push({
          ruleId: 'angular/nested-subscribe',
          severity: 'warn',
          confidence: 0.82,
          location,
          evidence: [
            {
              kind: 'ast',
              nodeKind: 'CallExpression',
              description: 'subscribe() is called inside another subscribe() callback',
              snippet: node.getText().slice(0, 180),
            },
            {
              kind: 'callgraph',
              path: [outer.getText().slice(0, 80), node.getText().slice(0, 80)],
              description: 'inner subscription runs every time the outer stream emits',
            },
          ],
          guarantees: [],
          message: {
            title: 'Nested subscribe can repeat work',
            body: '',
            suggestion: `outer$
  .pipe(
    switchMap((value) => inner$(value))
  )
  .subscribe(...);`,
            suggestionLanguage: 'ts',
          },
        });
      });
    }

    return out;
  },
} as const;

export const formControlGetNullRule = {
  id: 'angular/form-control-get-null',
  category: 'forms' as const,
  severity: 'warn' as const,
  basePrecision: 0.78,
  description: 'FormGroup.get() can return null when a control name changes.',

  run(ctx: RuleContext): RawFinding[] {
    const out: RawFinding[] = [];

    for (const { file, sourceFile } of changedTypeScriptFiles(ctx)) {
      sourceFile.forEachDescendant((node) => {
        if (!Node.isCallExpression(node)) return;
        const access = propertyAccessOfCall(node);
        if (!access || access.getName() !== 'get') return;
        const formText = access.getExpression().getText();
        if (!/^this\.\w+Form\b/.test(formText)) return;

        const parent = node.getParent();
        if (!parent || !Node.isPropertyAccessExpression(parent)) return;
        if (!['valueChanges', 'statusChanges', 'value'].includes(parent.getName())) return;
        if (parent.getText().includes('?.')) return;

        const location = locationOf(ctx, sourceFile, parent);
        if (!isChangedLine(ctx, file, location.startLine)) return;

        const controlName = node.getArguments()[0]?.getText().replace(/^['"`]|['"`]$/g, '') ?? 'control';
        out.push({
          ruleId: 'angular/form-control-get-null',
          severity: 'warn',
          confidence: 0.78,
          location,
          evidence: [
            {
              kind: 'ast',
              nodeKind: 'PropertyAccessExpression',
              description: 'FormGroup.get() result is used without a null check',
              snippet: parent.getText().slice(0, 180),
            },
            {
              kind: 'type',
              typeText: 'AbstractControl | null',
              allowsNullish: true,
              description: 'Angular FormGroup.get() returns null when the control is missing',
            },
          ],
          guarantees: [],
          message: {
            title: 'Form control can be missing',
            body: '',
            suggestion: `const control = ${formText}.get('${controlName}');
if (!control) return;

control.valueChanges.subscribe(...);`,
            suggestionLanguage: 'ts',
          },
        });
      });
    }

    return out;
  },
} as const;

export const eventListenerLeakRule = {
  id: 'angular/event-listener-leak',
  category: 'lifecycle' as const,
  severity: 'warn' as const,
  basePrecision: 0.80,
  description: 'DOM event listeners added by a component must be removed on destroy.',

  run(ctx: RuleContext): RawFinding[] {
    const out: RawFinding[] = [];

    for (const comp of ctx.changedComponents) {
      const allMethodText = comp.methods.map((method) => method.text).join('\n');
      for (const method of comp.methods) {
        for (const match of method.text.matchAll(/\.addEventListener\s*\(\s*['"`]([^'"`]+)['"`]/g)) {
          const eventName = match[1]!;
          if (hasMatchingRemove(allMethodText, eventName)) continue;

          const line = method.location.startLine + lineOffset(method.text, match.index ?? 0);
          const location: SourceLocation = { ...method.location, startLine: line, endLine: line };
          if (!isChangedLine(ctx, comp.tsFile, line)) continue;

          out.push({
            ruleId: 'angular/event-listener-leak',
            severity: 'warn',
            confidence: 0.80,
            location,
            evidence: [{
              kind: 'runtime',
              traceId: 'static-dom-listener-scan',
              metric: 'event-listener-count',
              value: 1,
              threshold: 1,
              description: `${eventName} listener is added without a matching removeEventListener`,
            }],
            guarantees: destroyGuarantees(comp),
            message: {
              title: 'Event listener is not removed',
              body: '',
              suggestion: `fromEvent(target, '${eventName}')
  .pipe(takeUntilDestroyed(this.destroyRef))
  .subscribe(...);`,
              suggestionLanguage: 'ts',
            },
          });
        }
      }
    }

    return out;
  },
} as const;

export function looksLikeFiniteApiObservable(receiverText: string): boolean {
  const text = receiverText.replace(/\s+/g, ' ');
  if (looksLongLivedObservable(text)) return false;
  if (/\b(http|httpClient)\.(get|post|put|patch|delete|request|head|options)\s*(<|\()/i.test(text)) return true;
  return /this\.\w*(Service|Api|Client|Facade)\.(get|load|fetch|find|search|create|add|update|delete|remove|save|post|put|patch|request|submit|send)\w*\s*\(/i.test(text);
}

export function looksLongLivedObservable(receiverText: string): boolean {
  return /\b(valueChanges|statusChanges|router\.events|onHidden|onShown|onHide|onClose|events|select)\b/i.test(receiverText) ||
    /\b(store|_store)\.select\s*\(/i.test(receiverText);
}

function changedTypeScriptFiles(ctx: RuleContext): Array<{ file: string; sourceFile: SourceFile }> {
  const out: Array<{ file: string; sourceFile: SourceFile }> = [];
  for (const file of ctx.diff.files()) {
    if (file.binary || file.status === 'deleted') continue;
    if (!file.newPath.endsWith('.ts') || file.newPath.endsWith('.spec.ts')) continue;
    const sourceFile = ctx.project.getSourceFile(file.newPath);
    if (sourceFile) out.push({ file: file.newPath, sourceFile });
  }
  return out;
}

function propertyAccessOfCall(call: CallExpression) {
  const expr = call.getExpression();
  return Node.isPropertyAccessExpression(expr) ? expr : undefined;
}

function subscribeHasErrorHandler(call: CallExpression): boolean {
  const args = call.getArguments();
  if (args.length >= 2 && args[1]?.getText() !== 'undefined') return true;
  const first = args[0];
  if (!first || !Node.isObjectLiteralExpression(first)) return false;
  return first.getProperties().some((prop) => {
    if (Node.isPropertyAssignment(prop) || Node.isShorthandPropertyAssignment(prop) || Node.isMethodDeclaration(prop)) {
      return prop.getName() === 'error';
    }
    return false;
  });
}

function enclosingSubscribeCall(call: CallExpression): CallExpression | undefined {
  let current = call.getParent();
  while (current) {
    if ((Node.isArrowFunction(current) || Node.isFunctionExpression(current)) && isSubscribeCallback(current)) {
      return current.getFirstAncestorByKind(SyntaxKind.CallExpression);
    }
    current = current.getParent();
  }
  return undefined;
}

function isSubscribeCallback(fn: Node): boolean {
  const parent = fn.getParent();
  if (!parent) return false;
  const call = parent.getFirstAncestorByKind(SyntaxKind.CallExpression);
  if (!call || call === fn) return false;
  const access = propertyAccessOfCall(call);
  return access?.getName() === 'subscribe';
}

function locationOf(ctx: RuleContext, sourceFile: SourceFile, node: Node): SourceLocation {
  const start = node.getStart();
  const end = node.getEnd();
  const startInfo = sourceFile.getLineAndColumnAtPos(start);
  const endInfo = sourceFile.getLineAndColumnAtPos(end);
  return {
    file: ctx.project.relativePath(sourceFile),
    startLine: startInfo.line,
    endLine: endInfo.line,
    startColumn: startInfo.column - 1,
    endColumn: endInfo.column - 1,
  };
}

function isChangedLine(ctx: RuleContext, file: string, line: number): boolean {
  const map = ctx.diff.lineMap(file);
  if (!map) return false;
  return map.addedNewLines.has(line);
}

function hasMatchingRemove(text: string, eventName: string): boolean {
  const escaped = eventName.replace(/[.*+?^${}()|[\]\\]/g, '\\$&');
  return new RegExp(`\\.removeEventListener\\s*\\(\\s*['"\`]${escaped}['"\`]`).test(text);
}

function lineOffset(text: string, index: number): number {
  return text.slice(0, index).split('\n').length - 1;
}

function destroyGuarantees(comp: import('@abid/ast-engine').ComponentDescriptor): Guarantee[] {
  const guarantees: Guarantee[] = [];
  if (comp.destroy.hasNgOnDestroy) {
    guarantees.push({ kind: 'destroy-hook', pattern: 'ngOnDestroy', declaringFile: comp.tsFile });
  }
  if (comp.destroy.usesTakeUntilDestroyed) {
    guarantees.push({ kind: 'destroy-hook', pattern: 'takeUntilDestroyed', declaringFile: comp.tsFile });
  }
  return guarantees;
}
