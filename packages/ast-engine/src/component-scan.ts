import * as fs from 'node:fs';
import * as path from 'node:path';
import {
  type CallExpression,
  ClassDeclaration,
  Decorator,
  Node,
  ObjectLiteralExpression,
  type PropertyAccessExpression,
  type PropertyAssignment,
  SourceFile,
  SyntaxKind,
} from 'ts-morph';
import type { SourceLocation } from '@abid/core';
import type { AstProject } from './project.js';
import type {
  ComponentDescriptor,
  DestroySupport,
  FieldDescriptor,
  InjectionRef,
  MethodDescriptor,
  SubscribeCall,
  TemplateRef,
} from './types.js';

/**
 * Walks the project, finds @Component classes, and produces a structured
 * descriptor per component. This is the AST engine's primary product — the
 * angular-analyzer rule pack reads ComponentDescriptors, not raw ts-morph nodes.
 *
 * Design choices:
 *   - We tolerate decorators that fail to fully evaluate. selector/standalone/CD
 *     all return null when not statically resolvable, and downstream rules treat
 *     null as "unknown" (i.e. they refuse to fire on missing information).
 *   - We surface both inline and external templates with a `startOffset` so the
 *     template-parser can map AST positions back to repo lines.
 */
export function scanComponents(project: AstProject): ComponentDescriptor[] {
  const out: ComponentDescriptor[] = [];
  for (const sf of project.sourceFiles()) {
    for (const cls of sf.getClasses()) {
      const decorator = cls.getDecorator('Component');
      if (!decorator) continue;
      const desc = describeComponent(project, sf, cls, decorator);
      if (desc) out.push(desc);
    }
  }
  return out;
}

function describeComponent(
  project: AstProject,
  sf: SourceFile,
  cls: ClassDeclaration,
  decorator: Decorator,
): ComponentDescriptor | null {
  const className = cls.getName();
  if (!className) return null;

  const arg = decorator.getArguments()[0];
  const metadata = arg && arg.getKind() === SyntaxKind.ObjectLiteralExpression
    ? (arg as ObjectLiteralExpression)
    : null;

  const selector = metadata ? readStringLiteralProp(metadata, 'selector') : null;
  const standalone = metadata ? readBooleanProp(metadata, 'standalone') ?? false : false;
  const cd = metadata ? readChangeDetection(metadata) : null;

  const tsFile = project.relativePath(sf);

  const templates = metadata
    ? extractTemplates(project, sf, metadata)
    : [];

  return {
    className,
    selector,
    standalone,
    changeDetection: cd,
    tsFile,
    templates,
    injections: extractInjections(cls),
    destroy: extractDestroySupport(cls),
    methods: extractMethods(cls, project, sf),
    fields: extractFields(cls, project),
    location: lineColOf(sf, cls, project),
  };
}

function readStringLiteralProp(obj: ObjectLiteralExpression, name: string): string | null {
  const prop = obj.getProperty(name);
  if (!prop) return null;
  if (prop.getKind() !== SyntaxKind.PropertyAssignment) return null;
  const init = (prop as PropertyAssignment).getInitializer();
  if (!init) return null;
  if (init.getKind() === SyntaxKind.StringLiteral || init.getKind() === SyntaxKind.NoSubstitutionTemplateLiteral) {
    return init.getText().slice(1, -1);
  }
  return null;
}

function readBooleanProp(obj: ObjectLiteralExpression, name: string): boolean | null {
  const prop = obj.getProperty(name);
  if (!prop || prop.getKind() !== SyntaxKind.PropertyAssignment) return null;
  const init = (prop as PropertyAssignment).getInitializer();
  if (!init) return null;
  const t = init.getText();
  if (t === 'true') return true;
  if (t === 'false') return false;
  return null;
}

function readChangeDetection(obj: ObjectLiteralExpression): 'Default' | 'OnPush' | null {
  const prop = obj.getProperty('changeDetection');
  if (!prop || prop.getKind() !== SyntaxKind.PropertyAssignment) return null;
  const init = (prop as PropertyAssignment).getInitializer();
  if (!init) return null;
  const text = init.getText();
  // We accept the canonical forms; anything else is "unknown".
  if (text === 'ChangeDetectionStrategy.OnPush') return 'OnPush';
  if (text === 'ChangeDetectionStrategy.Default') return 'Default';
  return null;
}

function extractTemplates(
  project: AstProject,
  sf: SourceFile,
  metadata: ObjectLiteralExpression,
): TemplateRef[] {
  const out: TemplateRef[] = [];
  const sourceFileText = sf.getFullText().replace(/\r\n/g, '\n');

  const inline = metadata.getProperty('template');
  if (inline && inline.getKind() === SyntaxKind.PropertyAssignment) {
    const init = (inline as PropertyAssignment).getInitializer();
    if (init) {
      const kind = init.getKind();
      if (
        kind === SyntaxKind.StringLiteral ||
        kind === SyntaxKind.NoSubstitutionTemplateLiteral ||
        kind === SyntaxKind.TemplateExpression
      ) {
        // Strip the leading/trailing quote/backtick. For TemplateExpression we
        // conservatively use the full text — Angular's parser handles it.
        const raw = init.getText();
        const startOffset = init.getStart() + 1;
        const source = stripQuotes(raw);
        out.push({
          kind: 'inline',
          file: project.relativePath(sf),
          startOffset,
          source: source.replace(/\r\n/g, '\n'),
          sourceFileText,
        });
      }
    }
  }

  const urlProp = metadata.getProperty('templateUrl');
  if (urlProp && urlProp.getKind() === SyntaxKind.PropertyAssignment) {
    const init = (urlProp as PropertyAssignment).getInitializer();
    if (init && (init.getKind() === SyntaxKind.StringLiteral || init.getKind() === SyntaxKind.NoSubstitutionTemplateLiteral)) {
      const rel = init.getText().slice(1, -1);
      const abs = path.resolve(path.dirname(sf.getFilePath()), rel);
      try {
        const source = fs.readFileSync(abs, 'utf8').replace(/\r\n/g, '\n');
        out.push({
          kind: 'external',
          file: path.relative(project.tsMorphProject.getDirectoryOrThrow('.').getPath(), abs).replace(/\\/g, '/'),
          startOffset: 0,
          source,
        });
      } catch {
        // Missing template file — orchestrator logs this, but we don't crash the scan.
      }
    }
  }

  return out;
}

function stripQuotes(raw: string): string {
  if (raw.length < 2) return raw;
  const first = raw.charAt(0);
  const last = raw.charAt(raw.length - 1);
  if ((first === '`' && last === '`') || (first === "'" && last === "'") || (first === '"' && last === '"')) {
    return raw.slice(1, -1);
  }
  return raw;
}

function extractInjections(cls: ClassDeclaration): InjectionRef[] {
  const out: InjectionRef[] = [];

  // Constructor-style injections.
  const ctor = cls.getConstructors()[0];
  if (ctor) {
    for (const p of ctor.getParameters()) {
      const name = p.getName();
      const typeNode = p.getTypeNode();
      const typeName = typeNode ? typeNode.getText() : p.getType().getText();
      out.push({ paramName: name, typeName });
    }
  }

  // Field-level `inject(Service)` form.
  for (const field of cls.getProperties()) {
    const init = field.getInitializer();
    if (!init) continue;
    if (init.getKind() !== SyntaxKind.CallExpression) continue;
    const callText = init.getText();
    const m = /^inject\(([^)]+)\)/.exec(callText);
    if (!m) continue;
    out.push({ paramName: field.getName(), typeName: m[1]!.trim() });
  }

  return out;
}

function extractDestroySupport(cls: ClassDeclaration): DestroySupport {
  const hasNgOnDestroy = !!cls.getMethod('ngOnDestroy');

  let destroyRefField: string | undefined;
  let hasDestroyRef = false;

  for (const field of cls.getProperties()) {
    const init = field.getInitializer();
    if (!init) continue;
    const text = init.getText();
    if (/^inject\(\s*DestroyRef\s*\)/.test(text)) {
      destroyRefField = field.getName();
      hasDestroyRef = true;
    }
  }

  // Look for `takeUntilDestroyed` import in this source file.
  const sf = cls.getSourceFile();
  let usesTakeUntilDestroyed = false;
  for (const imp of sf.getImportDeclarations()) {
    if (imp.getModuleSpecifierValue().startsWith('@angular/core/rxjs-interop')) {
      for (const named of imp.getNamedImports()) {
        if (named.getName() === 'takeUntilDestroyed') usesTakeUntilDestroyed = true;
      }
    }
  }

  const result: DestroySupport = {
    hasNgOnDestroy,
    hasDestroyRef,
    usesTakeUntilDestroyed,
  };
  if (destroyRefField !== undefined) result.destroyRefField = destroyRefField;
  return result;
}

function extractMethods(cls: ClassDeclaration, project: AstProject, sf: SourceFile): MethodDescriptor[] {
  const out: MethodDescriptor[] = [];
  for (const m of cls.getMethods()) {
    const name = m.getName();
    const lifecycle = isLifecycle(name) ? (name as MethodDescriptor['lifecycle']) : undefined;
    const subscribeCalls = findSubscribeCalls(m, project, sf);
    out.push({
      name,
      location: lineColOf(sf, m, project),
      text: m.getText(),
      ...(lifecycle ? { lifecycle } : {}),
      subscribeCalls,
    });
  }
  return out;
}

function isLifecycle(name: string): boolean {
  return [
    'ngOnInit',
    'ngOnDestroy',
    'ngOnChanges',
    'ngAfterViewInit',
    'ngAfterContentInit',
  ].includes(name);
}

function findSubscribeCalls(node: Node, project: AstProject, sf: SourceFile): SubscribeCall[] {
  const out: SubscribeCall[] = [];
  node.forEachDescendant((n) => {
    if (n.getKind() !== SyntaxKind.CallExpression) return;
    const call = n.asKindOrThrow(SyntaxKind.CallExpression);
    const expr = call.getExpression();
    if (expr.getKind() !== SyntaxKind.PropertyAccessExpression) return;
    const propAccess = expr.asKindOrThrow(SyntaxKind.PropertyAccessExpression);
    if (propAccess.getName() !== 'subscribe') return;

    // Walk the receiver to collect .pipe(...) operator names.
    const { receiverText, pipeOperators, hasTakeUntil } = inspectPipe(propAccess.getExpression());

    // Detect assignment of subscribe result.
    let assignedToField: string | null = null;
    const parent = call.getParent();
    if (parent && parent.getKind() === SyntaxKind.BinaryExpression) {
      const bin = parent.asKindOrThrow(SyntaxKind.BinaryExpression);
      if (bin.getOperatorToken().getText() === '=') {
        const left = bin.getLeft();
        if (left.getKind() === SyntaxKind.PropertyAccessExpression) {
          const lpa = left.asKindOrThrow(SyntaxKind.PropertyAccessExpression);
          if (lpa.getExpression().getText() === 'this') {
            assignedToField = lpa.getName();
          }
        }
      }
    }

    out.push({
      location: lineColOf(sf, call, project),
      pipeOperators,
      hasTakeUntil,
      assignedToField,
      receiverText,
    });
  });
  return out;
}

function inspectPipe(receiver: Node): {
  receiverText: string;
  pipeOperators: string[];
  hasTakeUntil: boolean;
} {
  // Receiver of `.subscribe()` may be `something.pipe(opA(), opB())`.
  const pipeOperators: string[] = [];
  let hasTakeUntil = false;

  let current: Node | undefined = receiver;
  let baseText = receiver.getText();

  while (current) {
    if (current.getKind() !== SyntaxKind.CallExpression) break;
    const call: CallExpression = current.asKindOrThrow(SyntaxKind.CallExpression);
    const callee: Node = call.getExpression();
    if (callee.getKind() !== SyntaxKind.PropertyAccessExpression) break;
    const pa: PropertyAccessExpression = callee.asKindOrThrow(SyntaxKind.PropertyAccessExpression);
    if (pa.getName() !== 'pipe') break;

    for (const op of call.getArguments()) {
      if (op.getKind() === SyntaxKind.CallExpression) {
        const opCall = op.asKindOrThrow(SyntaxKind.CallExpression);
        const opExpr = opCall.getExpression().getText();
        pipeOperators.push(opExpr);
        if (opExpr === 'takeUntilDestroyed' || opExpr === 'takeUntil' || opExpr === 'take' || opExpr === 'first') {
          hasTakeUntil = true;
        }
      }
    }

    baseText = pa.getExpression().getText();
    current = pa.getExpression();
  }

  return { receiverText: baseText, pipeOperators, hasTakeUntil };
}

function extractFields(cls: ClassDeclaration, _project: AstProject): FieldDescriptor[] {
  const out: FieldDescriptor[] = [];
  for (const field of cls.getProperties()) {
    const name = field.getName();
    const sf = field.getSourceFile();
    const init = field.getInitializer();
    const initText = init ? init.getText() : '';
    let kind: FieldDescriptor['initializerKind'] = 'other';
    if (init) {
      if (init.getKind() === SyntaxKind.CallExpression) {
        const head = initText.replace(/\(.*$/s, '');
        if (head === 'signal' || head === 'signal') kind = 'signal';
        else if (head === 'computed') kind = 'computed';
        else if (head === 'inject') kind = 'inject';
      } else if (
        init.getKind() === SyntaxKind.StringLiteral ||
        init.getKind() === SyntaxKind.ArrayLiteralExpression ||
        init.getKind() === SyntaxKind.ObjectLiteralExpression ||
        init.getKind() === SyntaxKind.NumericLiteral ||
        init.getKind() === SyntaxKind.TrueKeyword ||
        init.getKind() === SyntaxKind.FalseKeyword
      ) {
        kind = 'literal';
      }
    }

    const type = field.getType();
    const typeText = type.getText();
    const allowsNullish = typeAllowsNullish(type);

    out.push({
      name,
      location: lineColOf(sf, field, _project),
      initializerKind: kind,
      initializerText: initText,
      typeText,
      allowsNullish,
    });
  }
  return out;
}

function typeAllowsNullish(type: import('ts-morph').Type): boolean {
  if (type.isNullable()) return true;
  if (!type.isUnion()) return false;
  return type.getUnionTypes().some((part) =>
    part.isNull() ||
    part.isUndefined() ||
    part.getText() === 'void',
  );
}

function lineColOf(sf: SourceFile, node: Node, project: AstProject): SourceLocation {
  const start = node.getStart();
  const end = node.getEnd();
  const startInfo = sf.getLineAndColumnAtPos(start);
  const endInfo = sf.getLineAndColumnAtPos(end);
  return {
    file: project.relativePath(sf),
    startLine: startInfo.line,
    endLine: endInfo.line,
    startColumn: startInfo.column - 1,
    endColumn: endInfo.column - 1,
  };
}
