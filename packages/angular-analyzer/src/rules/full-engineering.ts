import type { Evidence, Guarantee, SourceLocation } from '@abid/core';
import { parseTemplateRef } from '@abid/ast-engine';
import {
  Node,
  SyntaxKind,
  type CallExpression,
  type ClassDeclaration,
  type MethodDeclaration,
  type Node as TsMorphNode,
  type SourceFile,
} from 'ts-morph';
import type { RawFinding, RuleContext } from '../rule-context.js';
import { looksLikeFiniteApiObservable, looksLongLivedObservable } from './typescript-engineering.js';

export const tsNullDereferenceRule = {
  id: 'angular/ts-null-dereference',
  category: 'runtime' as const,
  severity: 'warn' as const,
  basePrecision: 0.84,
  description: 'TypeScript property access can crash when the receiver type allows null or undefined.',

  run(ctx: RuleContext): RawFinding[] {
    const out: RawFinding[] = [];

    for (const { file, sourceFile } of changedTypeScriptFiles(ctx)) {
      sourceFile.forEachDescendant((node) => {
        if (!Node.isPropertyAccessExpression(node)) return;
        if (isPartOfOptionalChain(node) || isAssignmentTarget(node)) return;
        const expr = node.getExpression();
        if (Node.isThisExpression(expr) || Node.isNonNullExpression(expr)) return;
        const parent = node.getParent();
        if (parent && Node.isPropertyAccessExpression(parent) && parent.getExpression() === node) return;

        const location = locationOf(ctx, sourceFile, node);
        if (!isChangedLine(ctx, file, location.startLine)) return;

        const type = expr.getType();
        const typeText = type.getText();
        if (!allowsNullish(type, typeText)) return;

        const root = rootGuardExpression(expr);
        if (!root || hasLocalNullGuard(node, root)) return;

        out.push({
          ruleId: 'angular/ts-null-dereference',
          severity: 'warn',
          confidence: 0.84,
          location,
          evidence: [
            {
              kind: 'ast',
              nodeKind: 'PropertyAccessExpression',
              description: `${node.getName()} is read from a nullable receiver`,
              snippet: node.getText().slice(0, 180),
            },
            {
              kind: 'type',
              typeText,
              allowsNullish: true,
              description: `${root} can be null or undefined at this access`,
            },
          ],
          guarantees: [],
          message: {
            title: 'This access can crash when the value is missing',
            body: '',
            suggestion: node.getText().replace(`${expr.getText()}.`, `${expr.getText()}?.`),
            suggestionLanguage: 'ts',
          },
        });
      });
    }

    return out;
  },
} as const;

export const floatingPromiseRule = {
  id: 'angular/floating-promise',
  category: 'async-handling' as const,
  severity: 'warn' as const,
  basePrecision: 0.88,
  description: 'Promise-returning calls should be awaited, returned, or explicitly handled.',

  run(ctx: RuleContext): RawFinding[] {
    const out: RawFinding[] = [];

    for (const { file, sourceFile } of changedTypeScriptFiles(ctx)) {
      sourceFile.forEachDescendant((node) => {
        if (!Node.isCallExpression(node)) return;
        if (!isFloatingCall(node)) return;
        const typeText = node.getType().getText();
        if (!looksPromiseLike(typeText)) return;

        const location = locationOf(ctx, sourceFile, node);
        if (!isChangedLine(ctx, file, location.startLine)) return;

        out.push({
          ruleId: 'angular/floating-promise',
          severity: 'warn',
          confidence: 0.88,
          location,
          evidence: [
            {
              kind: 'ast',
              nodeKind: 'CallExpression',
              description: 'Promise result is ignored by a bare expression statement',
              snippet: node.getText().slice(0, 180),
            },
            {
              kind: 'type',
              typeText,
              allowsNullish: false,
              description: 'call result is Promise-like and has no await/return/catch path',
            },
          ],
          guarantees: [],
          message: {
            title: 'Promise result is not handled',
            body: '',
            suggestion: `await ${node.getText()};`,
            suggestionLanguage: 'ts',
          },
        });
      });
    }

    return out;
  },
} as const;

export const asyncMissingErrorBoundaryRule = {
  id: 'angular/async-missing-error-boundary',
  category: 'error-handling' as const,
  severity: 'warn' as const,
  basePrecision: 0.82,
  description: 'Angular async API flows should handle rejection and reset UI state.',

  run(ctx: RuleContext): RawFinding[] {
    const out: RawFinding[] = [];

    for (const { file, sourceFile } of changedTypeScriptFiles(ctx)) {
      for (const cls of sourceFile.getClasses()) {
        for (const method of cls.getMethods()) {
          if (!methodHasAsyncKeyword(method)) continue;
          if (!methodNeedsLocalErrorBoundary(method)) continue;
          if (method.getDescendantsOfKind(SyntaxKind.TryStatement).length > 0) continue;
          if (/\.catch\s*\(/.test(method.getText()) || /\bfinally\s*\{/.test(method.getText())) continue;

          const awaitCalls = method.getDescendantsOfKind(SyntaxKind.AwaitExpression)
            .filter((awaitExpr) => looksLikeApiWork(awaitExpr.getExpression().getText()));
          for (const awaitExpr of awaitCalls) {
            if (awaitExpr.getFirstAncestorByKind(SyntaxKind.TryStatement)) continue;
            const location = locationOf(ctx, sourceFile, awaitExpr);
            if (!isChangedLine(ctx, file, location.startLine)) continue;

            out.push({
              ruleId: 'angular/async-missing-error-boundary',
              severity: 'warn',
              confidence: 0.82,
              location,
              evidence: [
                {
                  kind: 'ast',
                  nodeKind: 'AwaitExpression',
                  description: 'awaited API work is outside try/catch/finally',
                  snippet: awaitExpr.getText().slice(0, 180),
                },
                {
                  kind: 'network',
                  url: awaitExpr.getExpression().getText().slice(0, 140),
                  count: 1,
                  description: 'API failure can skip local loading/error-state handling',
                },
              ],
              guarantees: [],
              message: {
                title: 'Async API failure is not handled here',
                body: '',
                suggestion: `try {
  ${awaitExpr.getText()};
} catch (err) {
  this.error = err;
} finally {
  this.loading = false;
}`,
                suggestionLanguage: 'ts',
              },
            });
          }
        }
      }
    }

    return out;
  },
} as const;

export const asyncLifecycleRule = {
  id: 'angular/async-lifecycle-hook',
  category: 'lifecycle' as const,
  severity: 'warn' as const,
  basePrecision: 0.86,
  description: 'Angular does not await async lifecycle hook promises.',

  run(ctx: RuleContext): RawFinding[] {
    const out: RawFinding[] = [];

    for (const { file, sourceFile } of changedTypeScriptFiles(ctx)) {
      for (const cls of sourceFile.getClasses()) {
        for (const method of cls.getMethods()) {
          const name = method.getName();
          if (!['ngOnInit', 'ngOnChanges', 'ngAfterViewInit', 'ngAfterContentInit'].includes(name)) continue;
          if (!methodHasAsyncKeyword(method)) continue;
          const location = locationOf(ctx, sourceFile, method);
          if (!methodContainsChangedLine(ctx, file, method)) continue;

          out.push({
            ruleId: 'angular/async-lifecycle-hook',
            severity: 'warn',
            confidence: 0.86,
            location: changedLineLocation(ctx, file, method, sourceFile) ?? location,
            evidence: [{
              kind: 'ast',
              nodeKind: 'MethodDeclaration',
              description: `${name} is async, but Angular ignores the returned Promise`,
              snippet: firstLine(method.getText()),
            }],
            guarantees: [],
            message: {
              title: `${name} should not rely on an awaited lifecycle Promise`,
              body: '',
              suggestion: `${name}(): void {
  void this.loadData();
}`,
              suggestionLanguage: 'ts',
            },
          });
        }
      }
    }

    return out;
  },
} as const;

export const duplicateApiRequestRule = {
  id: 'angular/duplicate-api-request',
  category: 'performance' as const,
  severity: 'warn' as const,
  basePrecision: 0.83,
  description: 'Identical API calls in one execution path cause duplicate requests.',

  run(ctx: RuleContext): RawFinding[] {
    const out: RawFinding[] = [];

    for (const { file, sourceFile } of changedTypeScriptFiles(ctx)) {
      for (const method of methodsIn(sourceFile)) {
        const calls = method.getDescendantsOfKind(SyntaxKind.CallExpression)
          .filter((call) => looksLikeApiWork(call.getText()));
        const byNormalized = new Map<string, CallExpression[]>();
        for (const call of calls) {
          const key = normalizeCallText(call.getText());
          if (!byNormalized.has(key)) byNormalized.set(key, []);
          byNormalized.get(key)!.push(call);
        }

        for (const [key, repeated] of byNormalized) {
          if (repeated.length < 2) continue;
          const changed = repeated.find((call) => isChangedLine(ctx, file, locationOf(ctx, sourceFile, call).startLine));
          if (!changed) continue;
          const location = locationOf(ctx, sourceFile, changed);
          out.push({
            ruleId: 'angular/duplicate-api-request',
            severity: 'warn',
            confidence: 0.83,
            location,
            evidence: [
              {
                kind: 'network',
                url: key.slice(0, 140),
                count: repeated.length,
                description: 'same API call appears multiple times in one method',
              },
              {
                kind: 'ast',
                nodeKind: 'CallExpression',
                description: 'duplicated request call site',
                snippet: changed.getText().slice(0, 180),
              },
            ],
            guarantees: [],
            message: {
              title: 'This method can send the same API request more than once',
              body: '',
              suggestion: `const request$ = ${changed.getText()}.pipe(shareReplay({ bufferSize: 1, refCount: true }));`,
              suggestionLanguage: 'ts',
            },
          });
          break;
        }
      }
    }

    return out;
  },
} as const;

export const apiCallInLoopRule = {
  id: 'angular/api-call-in-loop',
  category: 'performance' as const,
  severity: 'warn' as const,
  basePrecision: 0.86,
  description: 'API calls inside loops scale poorly and often create request storms.',

  run(ctx: RuleContext): RawFinding[] {
    const out: RawFinding[] = [];

    for (const { file, sourceFile } of changedTypeScriptFiles(ctx)) {
      sourceFile.forEachDescendant((node) => {
        if (!Node.isCallExpression(node)) return;
        if (!looksLikeApiWork(node.getText())) return;
        const loop = nearestLoop(node);
        if (!loop) return;

        const location = locationOf(ctx, sourceFile, node);
        if (!isChangedLine(ctx, file, location.startLine)) return;

        out.push({
          ruleId: 'angular/api-call-in-loop',
          severity: 'warn',
          confidence: 0.86,
          location,
          evidence: [
            {
              kind: 'network',
              url: node.getText().slice(0, 140),
              count: 2,
              description: 'request count grows with loop size',
            },
            {
              kind: 'ast',
              nodeKind: SyntaxKind[loop.getKind()] ?? 'Loop',
              description: 'API call is inside a loop body',
              snippet: node.getText().slice(0, 180),
            },
          ],
          guarantees: [],
          message: {
            title: 'API request is made inside a loop',
            body: '',
            suggestion: `// Prefer a batch endpoint or compose the requests with bounded concurrency.
from(items).pipe(mergeMap((item) => request(item), 4));`,
            suggestionLanguage: 'ts',
          },
        });
      });
    }

    return out;
  },
} as const;

export const explicitAnyRule = {
  id: 'angular/explicit-any',
  category: 'typing' as const,
  severity: 'info' as const,
  basePrecision: 0.90,
  description: 'Explicit any removes the type guarantees the reviewer needs for runtime safety.',

  run(ctx: RuleContext): RawFinding[] {
    const out: RawFinding[] = [];

    for (const { file, sourceFile } of changedTypeScriptFiles(ctx)) {
      sourceFile.forEachDescendant((node) => {
        if (node.getKind() !== SyntaxKind.AnyKeyword) return;
        const parent = node.getParent();
        if (!parent) return;
        const location = locationOf(ctx, sourceFile, node);
        if (!isChangedLine(ctx, file, location.startLine)) return;

        out.push({
          ruleId: 'angular/explicit-any',
          severity: 'info',
          confidence: 0.90,
          location,
          evidence: [{
            kind: 'type',
            typeText: 'any',
            allowsNullish: true,
            description: 'explicit any bypasses compile-time shape and null checks',
          }],
          guarantees: [],
          message: {
            title: 'Explicit any weakens this code path',
            body: '',
            suggestion: parent.getText().replace(/\bany\b/, 'unknown'),
            suggestionLanguage: 'ts',
          },
        });
      });
    }

    return out;
  },
} as const;

export const unusedImportRule = {
  id: 'angular/unused-import',
  category: 'maintainability' as const,
  severity: 'info' as const,
  basePrecision: 0.92,
  description: 'Changed imports should not leave dead symbols behind.',

  run(ctx: RuleContext): RawFinding[] {
    const out: RawFinding[] = [];

    for (const { file, sourceFile } of changedTypeScriptFiles(ctx)) {
      const textWithoutImports = removeImports(sourceFile.getFullText());
      for (const imp of sourceFile.getImportDeclarations()) {
        const symbols: Array<{ local: string; label: string; node: TsMorphNode }> = [];
        const defaultImport = imp.getDefaultImport();
        if (defaultImport) symbols.push({ local: defaultImport.getText(), label: defaultImport.getText(), node: defaultImport });
        const namespaceImport = imp.getNamespaceImport();
        if (namespaceImport) symbols.push({ local: namespaceImport.getText(), label: namespaceImport.getText(), node: namespaceImport });
        for (const named of imp.getNamedImports()) {
          const local = named.getAliasNode()?.getText() ?? named.getName();
          symbols.push({ local, label: named.getText(), node: named });
        }

        for (const symbol of symbols) {
          if (wordAppears(textWithoutImports, symbol.local)) continue;
          const location = locationOf(ctx, sourceFile, symbol.node);
          if (!isChangedLine(ctx, file, location.startLine)) continue;
          out.push({
            ruleId: 'angular/unused-import',
            severity: 'info',
            confidence: 0.92,
            location,
            evidence: [{
              kind: 'ast',
              nodeKind: 'ImportSpecifier',
              description: `${symbol.label} is imported but not referenced in the file body`,
              snippet: imp.getText().slice(0, 180),
            }],
            guarantees: [],
            message: {
              title: 'Imported symbol is not used',
              body: '',
            },
          });
        }
      }
    }

    return out;
  },
} as const;

export const largeComponentComplexityRule = {
  id: 'angular/large-component-complexity',
  category: 'architecture' as const,
  severity: 'info' as const,
  basePrecision: 0.76,
  description: 'Very large Angular components are harder to test, reason about, and scale.',

  run(ctx: RuleContext): RawFinding[] {
    const out: RawFinding[] = [];

    for (const comp of ctx.changedComponents) {
      if (!ctx.diff.fileByNewPath(comp.tsFile)) continue;
      const sourceFile = ctx.project.getSourceFile(comp.tsFile);
      if (!sourceFile) continue;
      const cls = sourceFile.getClass(comp.className);
      const lineCount = cls ? cls.getText().split('\n').length : 0;
      const methodCount = comp.methods.length;
      const fieldCount = comp.fields.length;
      if (lineCount < 420 && methodCount < 18 && fieldCount < 24) continue;

      const location = firstChangedLocation(ctx, comp.tsFile, sourceFile) ?? comp.location;
      const centrality = ctx.repo.imports.centrality(comp.tsFile);
      out.push({
        ruleId: 'angular/large-component-complexity',
        severity: 'info',
        confidence: 0.76,
        location,
        evidence: [
          {
            kind: 'ast',
            nodeKind: 'ComponentClass',
            description: `${comp.className} has ${lineCount} lines, ${methodCount} methods, and ${fieldCount} fields`,
          },
          {
            kind: 'cross-file',
            matches: [...ctx.repo.imports.importers(comp.tsFile)].slice(0, 6).map((file) => ({ file, line: 1 })),
            description: `component has ${centrality} direct importer(s), increasing change blast radius`,
          },
        ],
        guarantees: onPushGuarantees(comp),
        message: {
          title: 'Component is carrying too much responsibility',
          body: '',
        },
      });
    }

    return out;
  },
} as const;

export const largeMethodComplexityRule = {
  id: 'angular/large-method-complexity',
  category: 'maintainability' as const,
  severity: 'info' as const,
  basePrecision: 0.82,
  description: 'Large or highly branched methods are difficult to verify safely.',

  run(ctx: RuleContext): RawFinding[] {
    const out: RawFinding[] = [];

    for (const { file, sourceFile } of changedTypeScriptFiles(ctx)) {
      for (const method of methodsIn(sourceFile)) {
        if (!methodContainsChangedLine(ctx, file, method)) continue;
        const bodyText = method.getBodyText() ?? '';
        const lines = bodyText.split('\n').length;
        const branches = branchCount(method);
        if (lines < 70 && branches < 14) continue;

        const location = changedLineLocation(ctx, file, method, sourceFile) ?? locationOf(ctx, sourceFile, method);
        out.push({
          ruleId: 'angular/large-method-complexity',
          severity: 'info',
          confidence: 0.82,
          location,
          evidence: [{
            kind: 'ast',
            nodeKind: 'MethodDeclaration',
            description: `${method.getName()} has ${lines} body lines and ${branches} branch points`,
            snippet: firstLine(method.getText()),
          }],
          guarantees: [],
          message: {
            title: 'Method complexity is high for review and testing',
            body: '',
          },
        });
      }
    }

    return out;
  },
} as const;

export const deadPrivateMemberRule = {
  id: 'angular/dead-private-member',
  category: 'maintainability' as const,
  severity: 'info' as const,
  basePrecision: 0.84,
  description: 'Private members changed in a PR should be referenced by production code.',

  run(ctx: RuleContext): RawFinding[] {
    const out: RawFinding[] = [];

    for (const { file, sourceFile } of changedTypeScriptFiles(ctx)) {
      for (const cls of sourceFile.getClasses()) {
        const classText = cls.getText();
        for (const member of [...cls.getMethods(), ...cls.getProperties()]) {
          if (!hasPrivateModifier(member)) continue;
          const name = member.getName();
          if (name.startsWith('_')) continue;
          const location = locationOf(ctx, sourceFile, member);
          if (!isChangedLine(ctx, file, location.startLine)) continue;
          const withoutDecl = classText.replace(member.getText(), '');
          if (memberReferenceCount(withoutDecl, name) > 0) continue;

          out.push({
            ruleId: 'angular/dead-private-member',
            severity: 'info',
            confidence: 0.84,
            location,
            evidence: [{
              kind: 'ast',
              nodeKind: SyntaxKind[member.getKind()] ?? 'ClassMember',
              description: `private member ${name} is declared but not referenced in the class`,
              snippet: firstLine(member.getText()),
            }],
            guarantees: [],
            message: {
              title: 'Private member appears to be dead code',
              body: '',
            },
          });
        }
      }
    }

    return out;
  },
} as const;

export const directDomMutationRule = {
  id: 'angular/direct-dom-mutation',
  category: 'performance' as const,
  severity: 'warn' as const,
  basePrecision: 0.82,
  description: 'Direct DOM mutation bypasses Angular rendering and can break hydration or cleanup.',

  run(ctx: RuleContext): RawFinding[] {
    const out: RawFinding[] = [];

    for (const { file, sourceFile } of changedTypeScriptFiles(ctx)) {
      sourceFile.forEachDescendant((node) => {
        if (!Node.isPropertyAccessExpression(node) && !Node.isCallExpression(node)) return;
        const text = node.getText();
        if (!looksLikeDirectDomMutation(text)) return;
        const location = locationOf(ctx, sourceFile, node);
        if (!isChangedLine(ctx, file, location.startLine)) return;

        out.push({
          ruleId: 'angular/direct-dom-mutation',
          severity: 'warn',
          confidence: 0.82,
          location,
          evidence: [{
            kind: 'runtime',
            traceId: 'static-dom-mutation-scan',
            metric: 'change-detection-cycles',
            value: 1,
            description: 'code mutates DOM outside Angular template/rendering APIs',
          }],
          guarantees: [],
          message: {
            title: 'Direct DOM mutation bypasses Angular rendering',
            body: '',
            suggestion: '// Prefer template bindings, Renderer2, or a directive that owns this DOM update.',
            suggestionLanguage: 'ts',
          },
        });
      });
    }

    return out;
  },
} as const;

export const sanitizerBypassRule = {
  id: 'angular/xss-sanitizer-bypass',
  category: 'security' as const,
  severity: 'warn' as const,
  basePrecision: 0.94,
  description: 'DomSanitizer bypass calls and innerHTML writes must be treated as XSS-sensitive.',

  run(ctx: RuleContext): RawFinding[] {
    const out: RawFinding[] = [];

    for (const { file, sourceFile } of changedTypeScriptFiles(ctx)) {
      sourceFile.forEachDescendant((node) => {
        if (!Node.isCallExpression(node) && !Node.isBinaryExpression(node)) return;
        const text = node.getText();
        if (!/\bbypassSecurityTrust(Html|Script|Style|Url|ResourceUrl)\s*\(/.test(text) && !/\.innerHTML\s*=/.test(text)) {
          return;
        }
        const location = locationOf(ctx, sourceFile, node);
        if (!isChangedLine(ctx, file, location.startLine)) return;

        out.push({
          ruleId: 'angular/xss-sanitizer-bypass',
          severity: 'warn',
          confidence: 0.94,
          location,
          evidence: [{
            kind: 'ast',
            nodeKind: SyntaxKind[node.getKind()] ?? 'Expression',
            description: 'explicit sanitizer bypass or raw innerHTML write',
            snippet: text.slice(0, 180),
          }],
          guarantees: [],
          message: {
            title: 'This code bypasses Angular XSS protection',
            body: '',
          },
        });
      });
    }

    return out;
  },
} as const;

export const ssrBrowserGlobalRule = {
  id: 'angular/browser-global-ssr',
  category: 'ssr-hydration' as const,
  severity: 'warn' as const,
  basePrecision: 0.84,
  description: 'Browser-only globals need a platform guard in SSR or hydration-capable Angular apps.',

  run(ctx: RuleContext): RawFinding[] {
    const out: RawFinding[] = [];

    for (const { file, sourceFile } of changedTypeScriptFiles(ctx)) {
      sourceFile.forEachDescendant((node) => {
        if (!Node.isIdentifier(node)) return;
        const name = node.getText();
        if (!['window', 'document', 'localStorage', 'sessionStorage', 'navigator'].includes(name)) return;
        if (isDeclarationName(node) || hasPlatformGuard(node) || fileHasPlatformGuard(sourceFile)) return;
        const location = locationOf(ctx, sourceFile, node);
        if (!isChangedLine(ctx, file, location.startLine)) return;

        out.push({
          ruleId: 'angular/browser-global-ssr',
          severity: 'warn',
          confidence: 0.84,
          location,
          evidence: [{
            kind: 'ast',
            nodeKind: 'Identifier',
            description: `${name} is used without an isPlatformBrowser or DOCUMENT guard`,
            snippet: node.getParent()?.getText().slice(0, 180),
          }],
          guarantees: [],
          message: {
            title: `${name} needs an SSR-safe access path`,
            body: '',
            suggestion: `if (isPlatformBrowser(this.platformId)) {
  // use ${name} here
}`,
            suggestionLanguage: 'ts',
          },
        });
      });
    }

    return out;
  },
} as const;

export const manualServiceInstantiationRule = {
  id: 'angular/manual-service-instantiation',
  category: 'di' as const,
  severity: 'warn' as const,
  basePrecision: 0.88,
  description: 'Angular services should come from dependency injection, not direct new expressions.',

  run(ctx: RuleContext): RawFinding[] {
    const out: RawFinding[] = [];

    for (const { file, sourceFile } of changedTypeScriptFiles(ctx)) {
      sourceFile.forEachDescendant((node) => {
        if (!Node.isNewExpression(node)) return;
        const className = node.getExpression().getText();
        if (!/(Service|Facade|Client|Repository|Store)$/.test(className)) return;
        const location = locationOf(ctx, sourceFile, node);
        if (!isChangedLine(ctx, file, location.startLine)) return;

        out.push({
          ruleId: 'angular/manual-service-instantiation',
          severity: 'warn',
          confidence: 0.88,
          location,
          evidence: [{
            kind: 'ast',
            nodeKind: 'NewExpression',
            description: `${className} is manually instantiated instead of injected`,
            snippet: node.getText().slice(0, 180),
          }],
          guarantees: [],
          message: {
            title: 'Service is created outside Angular dependency injection',
            body: '',
            suggestion: `private readonly service = inject(${className});`,
            suggestionLanguage: 'ts',
          },
        });
      });
    }

    return out;
  },
} as const;

export const circularImportRule = {
  id: 'angular/circular-import',
  category: 'architecture' as const,
  severity: 'warn' as const,
  basePrecision: 0.90,
  description: 'Direct circular imports make Angular module boundaries brittle.',

  run(ctx: RuleContext): RawFinding[] {
    const out: RawFinding[] = [];

    for (const file of ctx.diff.postableFiles()) {
      if (!file.endsWith('.ts')) continue;
      const sourceFile = ctx.project.getSourceFile(file);
      if (!sourceFile) continue;
      for (const imported of ctx.repo.imports.imports(file)) {
        if (!ctx.repo.imports.imports(imported).has(file)) continue;
        const location = importLocationFor(sourceFile, ctx, file, imported) ?? firstChangedLocation(ctx, file, sourceFile);
        if (!location) continue;
        out.push({
          ruleId: 'angular/circular-import',
          severity: 'warn',
          confidence: 0.90,
          location,
          evidence: [{
            kind: 'callgraph',
            path: [file, imported, file],
            description: 'direct two-file import cycle detected',
          }],
          guarantees: [],
          message: {
            title: 'This change creates a circular dependency',
            body: '',
          },
        });
      }
    }

    return out;
  },
} as const;

export const signalWriteInComputationRule = {
  id: 'angular/signal-write-in-computation',
  category: 'change-detection' as const,
  severity: 'warn' as const,
  basePrecision: 0.86,
  description: 'Writing to a signal inside computed/effect can cause render loops or unstable state flow.',

  run(ctx: RuleContext): RawFinding[] {
    const out: RawFinding[] = [];

    for (const { file, sourceFile } of changedTypeScriptFiles(ctx)) {
      sourceFile.forEachDescendant((node) => {
        if (!Node.isCallExpression(node)) return;
        const access = propertyAccessOfCall(node);
        if (!access || !['set', 'update', 'mutate'].includes(access.getName())) return;
        const owner = nearestCallNamed(node, ['computed', 'effect']);
        if (!owner) return;
        const location = locationOf(ctx, sourceFile, node);
        if (!isChangedLine(ctx, file, location.startLine)) return;

        out.push({
          ruleId: 'angular/signal-write-in-computation',
          severity: 'warn',
          confidence: 0.86,
          location,
          evidence: [{
            kind: 'ast',
            nodeKind: 'CallExpression',
            description: `signal ${access.getName()}() is called inside ${owner}`,
            snippet: node.getText().slice(0, 180),
          }],
          guarantees: [],
          message: {
            title: 'Signal write happens inside reactive computation',
            body: '',
          },
        });
      });
    }

    return out;
  },
} as const;

export const formSubmitWithoutValidationRule = {
  id: 'angular/form-submit-without-validation',
  category: 'forms' as const,
  severity: 'warn' as const,
  basePrecision: 0.78,
  description: 'Submit/save handlers should validate reactive forms before sending values to APIs.',

  run(ctx: RuleContext): RawFinding[] {
    const out: RawFinding[] = [];

    for (const { file, sourceFile } of changedTypeScriptFiles(ctx)) {
      for (const method of methodsIn(sourceFile)) {
        if (!/^(on)?(submit|save|create|update|delete|apply)/i.test(method.getName())) continue;
        const text = method.getText();
        const formMatch = /this\.([A-Za-z_$][\w$]*Form)\.value\b/.exec(text);
        if (!formMatch) continue;
        if (new RegExp(`this\\.${escapeRegex(formMatch[1]!)}\\.(invalid|valid|errors)\\b`).test(text)) continue;
        if (!looksLikeApiWork(text)) continue;
        if (!methodContainsChangedLine(ctx, file, method)) continue;

        const location = changedLineLocation(ctx, file, method, sourceFile) ?? locationOf(ctx, sourceFile, method);
        out.push({
          ruleId: 'angular/form-submit-without-validation',
          severity: 'warn',
          confidence: 0.78,
          location,
          evidence: [
            {
              kind: 'ast',
              nodeKind: 'MethodDeclaration',
              description: `${method.getName()} sends ${formMatch[1]}.value without checking valid/invalid`,
              snippet: firstLine(method.getText()),
            },
            {
              kind: 'network',
              url: 'reactive-form-submit',
              count: 1,
              description: 'invalid form values can reach an API call',
            },
          ],
          guarantees: [],
          message: {
            title: 'Form value is submitted without a validity guard',
            body: '',
            suggestion: `if (this.${formMatch[1]}.invalid) {
  this.${formMatch[1]}.markAllAsTouched();
  return;
}`,
            suggestionLanguage: 'ts',
          },
        });
      }
    }

    return out;
  },
} as const;

export const storeLocalMirrorRule = {
  id: 'angular/store-local-mirror',
  category: 'state-sync' as const,
  severity: 'info' as const,
  basePrecision: 0.66,
  description: 'Mirroring store selector values into mutable component fields can create stale local state.',

  run(ctx: RuleContext): RawFinding[] {
    const out: RawFinding[] = [];

    for (const comp of ctx.changedComponents) {
      for (const method of comp.methods) {
        for (const sub of method.subscribeCalls) {
          if (!looksLongLivedObservable(sub.receiverText)) continue;
          if (!/\b(store|_store)\.select\s*\(/i.test(sub.receiverText) && !/\.select\s*\(/.test(sub.receiverText)) continue;
          if (!/=>\s*this\.[A-Za-z_$][\w$]*\s*=/.test(method.text)) continue;
          if (!isChangedLine(ctx, comp.tsFile, sub.location.startLine)) continue;
          out.push({
            ruleId: 'angular/store-local-mirror',
            severity: 'info',
            confidence: 0.66,
            location: sub.location,
            evidence: [
              {
                kind: 'ast',
                nodeKind: 'SubscribeCall',
                description: 'store selector subscription assigns into a mutable component field',
                snippet: sub.receiverText.slice(0, 180),
              },
            ],
            guarantees: destroyGuarantees(comp),
            message: {
              title: 'Store selector is mirrored into mutable local state',
              body: '',
              suggestion: 'readonly value$ = this.store.select(selectValue);',
              suggestionLanguage: 'ts',
            },
          });
        }
      }
    }

    return out;
  },
} as const;

export const blockingSyncOperationRule = {
  id: 'angular/blocking-sync-operation',
  category: 'performance' as const,
  severity: 'warn' as const,
  basePrecision: 0.86,
  description: 'Synchronous browser storage and sync XHR in hot paths block rendering.',

  run(ctx: RuleContext): RawFinding[] {
    const out: RawFinding[] = [];

    for (const { file, sourceFile } of changedTypeScriptFiles(ctx)) {
      sourceFile.forEachDescendant((node) => {
        if (!Node.isCallExpression(node)) return;
        const text = node.getText();
        const inLoopOrLifecycle = Boolean(nearestLoop(node) || nearestLifecycleMethod(node));
        const syncStorage = /\b(localStorage|sessionStorage)\.(getItem|setItem|removeItem|clear)\s*\(/.test(text);
        const syncXhr = /\.open\s*\([^,]+,[^,]+,\s*false\s*\)/.test(text);
        if (!syncXhr && !(syncStorage && inLoopOrLifecycle)) return;
        const location = locationOf(ctx, sourceFile, node);
        if (!isChangedLine(ctx, file, location.startLine)) return;

        out.push({
          ruleId: 'angular/blocking-sync-operation',
          severity: 'warn',
          confidence: 0.86,
          location,
          evidence: [{
            kind: 'runtime',
            traceId: 'static-blocking-operation-scan',
            metric: 'long-task-duration-ms',
            value: 50,
            threshold: 50,
            description: 'synchronous operation is executed from a loop or Angular lifecycle path',
          }],
          guarantees: [],
          message: {
            title: 'Synchronous work can block rendering',
            body: '',
          },
        });
      });
    }

    return out;
  },
} as const;

export const templateComplexExpressionRule = {
  id: 'angular/template-complex-expression',
  category: 'change-detection' as const,
  severity: 'info' as const,
  basePrecision: 0.74,
  needsRuntime: true,
  description: 'Complex template expressions are recalculated during Angular rendering.',

  run(ctx: RuleContext): RawFinding[] {
    const out: RawFinding[] = [];

    for (const comp of ctx.changedComponents) {
      const guarantees = onPushGuarantees(comp);
      for (const tplRef of comp.templates) {
        if (!ctx.diff.fileByNewPath(tplRef.file) && !ctx.diff.fileByNewPath(comp.tsFile)) continue;
        const analysis = parseTemplateRef(tplRef);
        for (const binding of analysis.bindings) {
          if (binding.kind === 'event') continue;
          const score = templateComplexityScore(binding.expression);
          if (score < 5) continue;
          if (!isChangedLine(ctx, tplRef.file, binding.line) && !isChangedLine(ctx, comp.tsFile, binding.line)) continue;

          const evidence: Evidence[] = [{
            kind: 'template-binding',
            expression: binding.expression,
            guardedByUpstream: analysis.guards.some((guard) => guard.range.startLine <= binding.line && binding.line <= guard.range.endLine),
            asyncPipeWrapped: /\|\s*async\b/.test(binding.expression),
            description: `template expression has complexity score ${score}`,
          }];
          const slice = ctx.runtime?.byComponent.get(comp.className);
          if (slice && slice.avgRenderCount > 50) {
            evidence.push({
              kind: 'runtime',
              traceId: slice.traceIds[0] ?? 'unknown',
              metric: 'render-count',
              value: slice.avgRenderCount,
              threshold: 50,
              description: `${slice.avgRenderCount} renders observed while this binding can recalculate`,
            });
          }

          out.push({
            ruleId: 'angular/template-complex-expression',
            severity: 'info',
            confidence: 0.74,
            location: { file: tplRef.file, startLine: binding.line },
            evidence,
            guarantees,
            ...(slice ? { runtimeRefs: slice.traceIds } : {}),
            message: {
              title: 'Template expression does repeated work during rendering',
              body: '',
              suggestion: '// Move this expression into a computed value or pure pipe, then bind the cached result.',
              suggestionLanguage: 'ts',
            },
          });
        }
      }
    }

    return out;
  },
} as const;

export const defaultChangeDetectionHotTemplateRule = {
  id: 'angular/default-cd-hot-template',
  category: 'change-detection' as const,
  severity: 'info' as const,
  basePrecision: 0.68,
  needsRuntime: true,
  description: 'Default change detection on template-heavy components can cause unnecessary rerenders.',

  run(ctx: RuleContext): RawFinding[] {
    const out: RawFinding[] = [];

    for (const comp of ctx.changedComponents) {
      if (comp.changeDetection === 'OnPush') continue;
      const loops = comp.templates.flatMap((tpl) => parseTemplateRef(tpl).forLoops);
      const methodCalls = comp.templates.flatMap((tpl) => parseTemplateRef(tpl).methodCalls).filter((call) => call.inHotPath);
      if (loops.length + methodCalls.length < 4) continue;
      const sourceFile = ctx.project.getSourceFile(comp.tsFile);
      if (!sourceFile) continue;
      const location = firstChangedLocation(ctx, comp.tsFile, sourceFile) ?? comp.location;
      const slice = ctx.runtime?.byComponent.get(comp.className);

      out.push({
        ruleId: 'angular/default-cd-hot-template',
        severity: 'info',
        confidence: slice && slice.avgRenderCount > 50 ? 0.78 : 0.68,
        location,
        evidence: [
          {
            kind: 'ast',
            nodeKind: 'ComponentDecorator',
            description: `${comp.className} uses default change detection with ${loops.length} loop(s) and ${methodCalls.length} hot-path template method call(s)`,
          },
          ...(slice && slice.avgRenderCount > 50 ? [{
            kind: 'runtime' as const,
            traceId: slice.traceIds[0] ?? 'unknown',
            metric: 'render-count' as const,
            value: slice.avgRenderCount,
            threshold: 50,
            description: 'runtime render count crossed the review threshold',
          }] : []),
        ],
        guarantees: [],
        ...(slice ? { runtimeRefs: slice.traceIds } : {}),
        message: {
          title: 'Template-heavy component is still using default change detection',
          body: '',
          suggestion: 'changeDetection: ChangeDetectionStrategy.OnPush',
          suggestionLanguage: 'ts',
        },
      });
    }

    return out;
  },
} as const;

export const architectureServiceSeparationRule = {
  id: 'angular/service-responsibility-sprawl',
  category: 'architecture' as const,
  severity: 'info' as const,
  basePrecision: 0.76,
  description: 'Large shared services with high import centrality are scalability risks.',

  run(ctx: RuleContext): RawFinding[] {
    const out: RawFinding[] = [];

    for (const { file, sourceFile } of changedTypeScriptFiles(ctx)) {
      if (!/(service|facade|store)\.ts$/i.test(file)) continue;
      const cls = sourceFile.getClasses().find((candidate) => /(Service|Facade|Store)$/.test(candidate.getName() ?? ''));
      if (!cls) continue;
      const methods = cls.getMethods().length;
      const centrality = ctx.repo.imports.centrality(file);
      if (methods < 18 && centrality < 10) continue;
      const location = firstChangedLocation(ctx, file, sourceFile) ?? locationOf(ctx, sourceFile, cls);
      out.push({
        ruleId: 'angular/service-responsibility-sprawl',
        severity: 'info',
        confidence: 0.76,
        location,
        evidence: [
          {
            kind: 'ast',
            nodeKind: 'ClassDeclaration',
            description: `${cls.getName()} has ${methods} methods`,
            snippet: firstLine(cls.getText()),
          },
          {
            kind: 'cross-file',
            matches: [...ctx.repo.imports.importers(file)].slice(0, 8).map((importer) => ({ file: importer, line: 1 })),
            description: `${centrality} direct importer(s) depend on this service`,
          },
        ],
        guarantees: [],
        message: {
          title: 'Shared service is taking on too many responsibilities',
          body: '',
        },
      });
    }

    return out;
  },
} as const;

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

function methodsIn(sourceFile: SourceFile): MethodDeclaration[] {
  return sourceFile.getClasses().flatMap((cls) => cls.getMethods());
}

function locationOf(ctx: RuleContext, sourceFile: SourceFile, node: TsMorphNode): SourceLocation {
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
  return map.changedNewLines.has(line) || map.addedNewLines.has(line);
}

function firstChangedLocation(ctx: RuleContext, file: string, sourceFile: SourceFile): SourceLocation | undefined {
  const map = ctx.diff.lineMap(file);
  const line = map ? [...map.changedNewLines].sort((a, b) => a - b)[0] : undefined;
  if (line === undefined) return undefined;
  return {
    file,
    startLine: line,
    endLine: line,
    startColumn: 0,
    endColumn: 0,
  };
}

function changedLineLocation(
  ctx: RuleContext,
  file: string,
  method: MethodDeclaration,
  sourceFile: SourceFile,
): SourceLocation | undefined {
  const methodLocation = locationOf(ctx, sourceFile, method);
  const line = [...(ctx.diff.lineMap(file)?.changedNewLines ?? [])]
    .sort((a, b) => a - b)
    .find((candidate) => methodLocation.startLine <= candidate && candidate <= (methodLocation.endLine ?? methodLocation.startLine));
  if (line === undefined) return undefined;
  return { file, startLine: line, endLine: line, startColumn: 0, endColumn: 0 };
}

function methodContainsChangedLine(ctx: RuleContext, file: string, method: MethodDeclaration): boolean {
  const sourceFile = method.getSourceFile();
  const location = locationOf(ctx, sourceFile, method);
  const changed = ctx.diff.lineMap(file)?.changedNewLines ?? new Set<number>();
  for (const line of changed) {
    if (location.startLine <= line && line <= (location.endLine ?? location.startLine)) return true;
  }
  return false;
}

function allowsNullish(type: import('ts-morph').Type, typeText: string): boolean {
  return type.isNullable() || /\b(null|undefined)\b/.test(typeText);
}

function isPartOfOptionalChain(node: TsMorphNode): boolean {
  return /\?\./.test(node.getText());
}

function isAssignmentTarget(node: TsMorphNode): boolean {
  const parent = node.getParent();
  return Boolean(parent && Node.isBinaryExpression(parent) && parent.getLeft() === node);
}

function rootGuardExpression(node: TsMorphNode): string | undefined {
  const text = node.getText();
  const thisMatch = /^this\.[A-Za-z_$][\w$]*/.exec(text);
  if (thisMatch) return thisMatch[0];
  const match = /^[A-Za-z_$][\w$]*/.exec(text);
  return match?.[0];
}

function hasLocalNullGuard(node: TsMorphNode, root: string): boolean {
  const escaped = escapeRegex(root);
  let current = node.getParent();
  while (current) {
    if (Node.isIfStatement(current)) {
      const cond = current.getExpression().getText();
      const thenText = current.getThenStatement().getText();
      if (thenText.includes(node.getText()) && guardExpressionCovers(cond, escaped)) return true;
    }
    current = current.getParent();
  }

  const statement = node.getFirstAncestor((ancestor) => Node.isStatement(ancestor));
  const method = node.getFirstAncestorByKind(SyntaxKind.MethodDeclaration);
  if (!statement || !method) return false;
  const body = method.getBody();
  const block = body && Node.isBlock(body) ? body : undefined;
  const statements = block?.getStatements() ?? [];
  const index = statements.findIndex((candidate) => candidate === statement || candidate.getText() === statement.getText());
  if (index <= 0) return false;
  const previous = statements.slice(0, index).map((candidate) => candidate.getText()).join('\n');
  return new RegExp(`if\\s*\\(\\s*!${escaped}\\s*\\)\\s*return\\b`).test(previous)
    || new RegExp(`if\\s*\\(\\s*${escaped}\\s*(===|==)\\s*(null|undefined)\\s*\\)\\s*return\\b`).test(previous)
    || new RegExp(`if\\s*\\(\\s*${escaped}\\s*(==|===)\\s*null\\s*\\)\\s*\\{?\\s*return\\b`).test(previous);
}

function guardExpressionCovers(condition: string, escapedRoot: string): boolean {
  return new RegExp(`(^|[^A-Za-z0-9_$])${escapedRoot}([^A-Za-z0-9_$]|$)`).test(condition)
    || new RegExp(`${escapedRoot}\\s*!=\\s*null`).test(condition)
    || new RegExp(`${escapedRoot}\\s*!==\\s*(null|undefined)`).test(condition);
}

function isFloatingCall(call: CallExpression): boolean {
  const parent = call.getParent();
  if (!parent) return false;
  if (!Node.isExpressionStatement(parent)) return false;
  const text = parent.getText().trim();
  return !/^void\b/.test(text) && !/\.then\s*\(/.test(text) && !/\.catch\s*\(/.test(text) && !/\.finally\s*\(/.test(text);
}

function looksPromiseLike(typeText: string): boolean {
  return /\bPromise(Like)?\s*</.test(typeText) || /\bPromise\b/.test(typeText);
}

function looksLikeApiWork(text: string): boolean {
  const compact = text.replace(/\s+/g, ' ');
  if (looksLikeFiniteApiObservable(compact)) return true;
  return /\b(http|httpClient)\.(get|post|put|patch|delete|request|head|options)\s*(<|\()/i.test(compact)
    || /this\.\w*(Service|Api|Client|Facade)\.(get|load|fetch|find|search|create|add|update|delete|remove|save|post|put|patch|request|submit|send)\w*\s*\(/i.test(compact);
}

function methodHasAsyncKeyword(method: MethodDeclaration): boolean {
  return method.getModifiers().some((modifier) => modifier.getKind() === SyntaxKind.AsyncKeyword);
}

function methodNeedsLocalErrorBoundary(method: MethodDeclaration): boolean {
  const name = method.getName();
  if (/^(ngOnInit|ngOnChanges|ngAfterViewInit|on|save|submit|load|refresh|delete|update|create)/i.test(name)) return true;
  return /\bthis\.[A-Za-z_$][\w$]*(loading|Loading|isSaving|saving)\s*=\s*true\b/.test(method.getText());
}

function normalizeCallText(text: string): string {
  return text.replace(/\s+/g, ' ').replace(/;$/, '').trim();
}

function nearestLoop(node: TsMorphNode): TsMorphNode | undefined {
  return node.getFirstAncestor((ancestor) =>
    Node.isForStatement(ancestor)
    || Node.isForInStatement(ancestor)
    || Node.isForOfStatement(ancestor)
    || Node.isWhileStatement(ancestor)
    || Node.isDoStatement(ancestor),
  );
}

function nearestLifecycleMethod(node: TsMorphNode): MethodDeclaration | undefined {
  const method = node.getFirstAncestorByKind(SyntaxKind.MethodDeclaration);
  if (!method) return undefined;
  return /^(ngOnInit|ngOnChanges|ngAfterViewInit|ngDoCheck)$/.test(method.getName()) ? method : undefined;
}

function removeImports(text: string): string {
  return text.replace(/^\s*import[\s\S]*?;\s*$/gm, '');
}

function wordAppears(text: string, word: string): boolean {
  return new RegExp(`\\b${escapeRegex(word)}\\b`).test(text);
}

function branchCount(method: MethodDeclaration): number {
  let count = 0;
  method.forEachDescendant((node) => {
    if (
      Node.isIfStatement(node)
      || Node.isForStatement(node)
      || Node.isForInStatement(node)
      || Node.isForOfStatement(node)
      || Node.isWhileStatement(node)
      || Node.isDoStatement(node)
      || Node.isCaseClause(node)
      || Node.isCatchClause(node)
      || Node.isConditionalExpression(node)
    ) {
      count++;
    }
    if (Node.isBinaryExpression(node) && ['&&', '||', '??'].includes(node.getOperatorToken().getText())) count++;
  });
  return count;
}

function hasPrivateModifier(node: { getModifiers: () => TsMorphNode[] }): boolean {
  return node.getModifiers().some((modifier) => modifier.getKind() === SyntaxKind.PrivateKeyword);
}

function memberReferenceCount(text: string, name: string): number {
  const escaped = escapeRegex(name);
  const matches = text.match(new RegExp(`(this\\.${escaped}\\b|#${escaped}\\b|\\b${escaped}\\s*\\()`, 'g'));
  return matches?.length ?? 0;
}

function looksLikeDirectDomMutation(text: string): boolean {
  return /\.nativeElement\.(innerHTML|outerHTML|textContent|classList|style|appendChild|removeChild|insertBefore|replaceChild)\b/.test(text)
    || /\bdocument\.(querySelector|getElementById|getElementsByClassName|getElementsByTagName)\s*\(/.test(text)
    || /\.(innerHTML|outerHTML)\s*=/.test(text);
}

function isDeclarationName(node: TsMorphNode): boolean {
  const parent = node.getParent();
  return Boolean(
    parent
      && (Node.isVariableDeclaration(parent)
        || Node.isParameterDeclaration(parent)
        || Node.isImportSpecifier(parent)
        || Node.isPropertyDeclaration(parent))
      && 'getNameNode' in parent
      && (parent as { getNameNode: () => TsMorphNode }).getNameNode() === node,
  );
}

function hasPlatformGuard(node: TsMorphNode): boolean {
  let current = node.getParent();
  while (current) {
    if (Node.isIfStatement(current) && /isPlatformBrowser|typeof\s+window\s*!==\s*['"]undefined['"]/.test(current.getExpression().getText())) {
      return true;
    }
    current = current.getParent();
  }
  return false;
}

function fileHasPlatformGuard(sourceFile: SourceFile): boolean {
  const text = sourceFile.getFullText();
  return /\bisPlatformBrowser\s*\(/.test(text) || /\bDOCUMENT\b/.test(text);
}

function importLocationFor(
  sourceFile: SourceFile,
  ctx: RuleContext,
  file: string,
  importedFile: string,
): SourceLocation | undefined {
  for (const imp of sourceFile.getImportDeclarations()) {
    const target = imp.getModuleSpecifierSourceFile();
    if (!target) continue;
    if (ctx.project.relativePath(target) !== importedFile) continue;
    const location = locationOf(ctx, sourceFile, imp);
    if (isChangedLine(ctx, file, location.startLine)) return location;
  }
  return undefined;
}

function propertyAccessOfCall(call: CallExpression) {
  const expr = call.getExpression();
  return Node.isPropertyAccessExpression(expr) ? expr : undefined;
}

function nearestCallNamed(node: TsMorphNode, names: string[]): string | undefined {
  let current = node.getParent();
  while (current) {
    if (Node.isCallExpression(current)) {
      const expression = current.getExpression().getText();
      if (names.includes(expression)) return expression;
    }
    current = current.getParent();
  }
  return undefined;
}

function templateComplexityScore(expression: string): number {
  let score = expression.length > 120 ? 2 : 0;
  score += (expression.match(/\b(map|filter|reduce|sort|find|some|every)\s*\(/g) ?? []).length * 2;
  score += (expression.match(/&&|\|\||\?|:/g) ?? []).length;
  score += (expression.match(/\|\s*[A-Za-z_$][\w$]*/g) ?? []).length;
  score += (expression.match(/\.[A-Za-z_$][\w$]*\s*\(/g) ?? []).length * 2;
  return score;
}

function onPushGuarantees(comp: import('@abid/ast-engine').ComponentDescriptor): Guarantee[] {
  return comp.changeDetection === 'OnPush'
    ? [{ kind: 'on-push', componentName: comp.className }]
    : [];
}

function destroyGuarantees(comp: import('@abid/ast-engine').ComponentDescriptor): Guarantee[] {
  const guarantees: Guarantee[] = [];
  if (comp.destroy.hasNgOnDestroy) guarantees.push({ kind: 'destroy-hook', pattern: 'ngOnDestroy', declaringFile: comp.tsFile });
  if (comp.destroy.usesTakeUntilDestroyed) guarantees.push({ kind: 'destroy-hook', pattern: 'takeUntilDestroyed', declaringFile: comp.tsFile });
  return guarantees;
}

function firstLine(text: string): string {
  return text.split('\n')[0]?.slice(0, 180) ?? '';
}

function escapeRegex(s: string): string {
  return s.replace(/[.*+?^${}()|[\]\\]/g, '\\$&');
}
