import {
  parseTemplate,
  type ParsedTemplate,
  type TmplAstBoundAttribute,
  type TmplAstBoundEvent,
  type TmplAstBoundText,
  type TmplAstElement,
  type TmplAstIfBlock,
  type TmplAstForLoopBlock,
  type TmplAstNode,
  type TmplAstTemplate,
  TmplAstRecursiveVisitor,
} from '@angular/compiler';
import type { TemplateRef } from './types.js';

/**
 * Wrap Angular's template parser and expose a flat list of *interesting* nodes
 * with their head-revision line numbers.
 *
 * We deliberately do not surface every AST node — rules want a denormalized
 * view: interpolations, bindings, structural blocks, *ngIf/@if guards,
 * *ngFor expressions, and method-call expressions inside template scope.
 */
export interface TemplateAnalysis {
  /** Original ref. */
  ref: TemplateRef;
  /** Top-level parsed AST. Errors here usually mean the template won't compile in Angular either. */
  ast: ParsedTemplate;
  bindings: TemplateBinding[];
  /** Structural guards that narrow expressions in their subtree. */
  guards: TemplateGuard[];
  /** Method-call expressions inside text/interpolation/binding values. */
  methodCalls: TemplateMethodCall[];
  /** Discovered `trackBy` declarations per *ngFor / @for block. */
  forLoops: TemplateForLoop[];
  /** Diagnostics from the Angular template parser. */
  diagnostics: Array<{ message: string; line: number }>;
}

export interface TemplateBinding {
  /** The text of the bound expression (e.g. `user.name`). */
  expression: string;
  /** Where in the template (head-revision file lines, after offset translation). */
  line: number;
  /** 'attribute' | 'interpolation' | 'event'. */
  kind: 'attribute' | 'interpolation' | 'event' | 'two-way';
  /** Owner element tag, if applicable. */
  ownerTag?: string;
}

export interface TemplateGuard {
  /** *ngIf / @if expression. */
  expression: string;
  line: number;
  kind: 'ngIf' | '@if' | 'ngFor' | '@for';
  /** Range of lines covered by the guarded subtree. */
  range: { startLine: number; endLine: number };
}

export interface TemplateMethodCall {
  /** Method name (e.g. `getTotal`). */
  name: string;
  /** Receiver if accessible, e.g. `this.cart` → 'cart'. Empty for bare calls. */
  receiver: string;
  line: number;
  /** Context: was the call inside an interpolation that runs every change-detection cycle? */
  inHotPath: boolean;
}

export interface TemplateForLoop {
  /** `*ngFor` expression or `@for (item of items; track item.id)`. */
  iterableExpression: string;
  /** True if a `trackBy` (template form) or `track` (control-flow form) is declared. */
  hasTrackBy: boolean;
  line: number;
}

/**
 * Parse a single template ref into our denormalized analysis.
 *
 * Template AST positions are byte offsets into the original `source`. To map
 * back to repo-relative line numbers we:
 *   1. Convert offsets to template-local line numbers via the `source` string.
 *   2. If the template was inline, add the .ts file's line count up to `startOffset`.
 */
export function parseTemplateRef(ref: TemplateRef): TemplateAnalysis {
  const result = parseTemplate(ref.source, ref.file, {
    preserveWhitespaces: false,
    leadingTriviaChars: [' ', '\n', '\r', '\t'],
  });

  const baseLine = ref.kind === 'external'
    ? 0
    : linesBefore(ref.startOffset, ref.sourceFileText);

  const bindings: TemplateBinding[] = [];
  const guards: TemplateGuard[] = [];
  const methodCalls: TemplateMethodCall[] = [];
  const forLoops: TemplateForLoop[] = [];

  const lineOf = (offset: number) => baseLine + offsetToLine(ref.source, offset);

  class Visitor extends TmplAstRecursiveVisitor {
    override visitBoundAttribute(b: TmplAstBoundAttribute): void {
      const expression = expressionText(b.value);
      bindings.push({
        expression,
        line: lineOf(b.sourceSpan.start.offset),
        kind: 'attribute',
      });
      collectMethodCalls(expression, lineOf(b.sourceSpan.start.offset), true, methodCalls);
      super.visitBoundAttribute(b);
    }
    override visitBoundEvent(b: TmplAstBoundEvent): void {
      const expression = expressionText(b.handler);
      bindings.push({
        expression,
        line: lineOf(b.sourceSpan.start.offset),
        kind: 'event',
      });
      // Event handlers run on user input, not every CD cycle — not hot path.
      collectMethodCalls(expression, lineOf(b.sourceSpan.start.offset), false, methodCalls);
      super.visitBoundEvent(b);
    }
    override visitBoundText(b: TmplAstBoundText): void {
      const expression = expressionText(b.value);
      bindings.push({
        expression,
        line: lineOf(b.sourceSpan.start.offset),
        kind: 'interpolation',
      });
      collectMethodCalls(expression, lineOf(b.sourceSpan.start.offset), true, methodCalls);
      super.visitBoundText(b);
    }
    override visitIfBlock(blk: TmplAstIfBlock): void {
      for (const branch of blk.branches) {
        if (branch.expression) {
          const line = lineOf(branch.sourceSpan.start.offset);
          const endLine = lineOf(branch.sourceSpan.end.offset);
          guards.push({
            expression: branch.expression.toString(),
            line,
            kind: '@if',
            range: { startLine: line, endLine },
          });
        }
      }
      super.visitIfBlock(blk);
    }
    override visitForLoopBlock(blk: TmplAstForLoopBlock): void {
      const line = lineOf(blk.sourceSpan.start.offset);
      forLoops.push({
        iterableExpression: blk.expression.toString(),
        // Control-flow @for *requires* a track expression, so it's always tracked.
        hasTrackBy: true,
        line,
      });
      super.visitForLoopBlock(blk);
    }
    override visitTemplate(tpl: TmplAstTemplate): void {
      // *ngIf / *ngFor are surfaced here.
      for (const inp of tpl.templateAttrs) {
        const name = inp.name;
        if (name === 'ngIf') {
          const line = lineOf(inp.sourceSpan.start.offset);
          const endLine = lineOf(tpl.sourceSpan.end.offset);
          guards.push({
            expression: String(inp.value),
            line,
            kind: 'ngIf',
            range: { startLine: line, endLine },
          });
        } else if (name === 'ngFor') {
          const line = lineOf(inp.sourceSpan.start.offset);
          const hasTrackBy = tpl.templateAttrs.some((a) => a.name === 'ngForTrackBy');
          forLoops.push({
            iterableExpression: String(inp.value),
            hasTrackBy,
            line,
          });
        }
      }
      super.visitTemplate(tpl);
    }
    override visitElement(_el: TmplAstElement): void {
      super.visitElement(_el);
    }
  }

  const visitor = new Visitor();
  (result.nodes as TmplAstNode[]).forEach((n) => n.visit(visitor));

  const diagnostics = result.errors?.map((e) => ({
    message: e.msg,
    line: lineOf(e.span.start.offset),
  })) ?? [];

  return {
    ref,
    ast: result,
    bindings,
    guards,
    methodCalls,
    forLoops,
    diagnostics,
  };
}

function expressionText(value: unknown): string {
  const maybe = value as { source?: string; ast?: { source?: string }; toString?: () => string };
  const source = maybe.source ?? maybe.ast?.source;
  if (source) return normalizeExpressionText(source);

  let text = maybe.toString ? maybe.toString() : String(value);
  return normalizeExpressionText(text.replace(/\s+in\s+.+@\d+:\d+$/s, ''));
}

function normalizeExpressionText(text: string): string {
  const interpolation = /\{\{\s*([\s\S]*?)\s*\}\}/.exec(text);
  return (interpolation ? interpolation[1]! : text).trim();
}

function offsetToLine(source: string, offset: number): number {
  let line = 1;
  for (let i = 0; i < offset && i < source.length; i++) {
    if (source.charCodeAt(i) === 10) line++;
  }
  return line;
}

function linesBefore(startOffset: number, sourceFileText?: string): number {
  // For inline templates: count newlines in the *.ts file from char 0 up to startOffset.
  // We pass the full source slice because the orchestrator hands us the raw template
  // string; the .ts file content is not available to template-parser. The component-scan
  // step is responsible for passing a correct `startOffset` and the parser uses it
  // by counting newlines in `fullSource.slice(0, startOffset)` — but since `fullSource`
  // here is the *template*, this currently returns 0 for inline templates.
  // The orchestrator translates inline template lines back to .ts file lines using
  // the component descriptor's location + the template-local line returned here.
  if (!sourceFileText || startOffset <= 0) return 0;
  let lines = 0;
  const capped = Math.min(startOffset, sourceFileText.length);
  for (let i = 0; i < capped; i++) {
    if (sourceFileText.charCodeAt(i) === 10) lines++;
  }
  return lines;
}

function collectMethodCalls(expr: string, line: number, inHotPath: boolean, out: TemplateMethodCall[]): void {
  // Light, regex-based pass over the AST string. Angular's expression AST is
  // available via the result; this implementation prefers the textual form
  // because the rule pack only needs name + receiver, and the expr AST is
  // expensive to walk for every binding.
  // Matches identifiers immediately followed by `(`, optionally with a `.receiver` chain.
  const re = /(?:([A-Za-z_$][\w$]*)\.)?([A-Za-z_$][\w$]*)\s*\(/g;
  let m: RegExpExecArray | null;
  while ((m = re.exec(expr)) !== null) {
    const receiver = m[1] ?? '';
    const name = m[2]!;
    // Filter out language builtins and pipe-like things by name.
    if (name === 'async' || name === 'json' || name === 'date') continue;
    out.push({ name, receiver, line, inHotPath });
  }
}
