import {
  parseTemplate,
  type ParsedTemplate,
  type TmplAstBoundAttribute,
  type TmplAstBoundEvent,
  type TmplAstBoundText,
  type TmplAstElement,
  type TmplAstForLoopBlock,
  type TmplAstIfBlock,
  type TmplAstNode,
  type TmplAstTemplate,
  TmplAstRecursiveVisitor,
} from '@angular/compiler';
import type { TemplateRef } from './types.js';

/**
 * Wrap Angular's template parser and expose a denormalized rendering view.
 * Rules consume this together with the component descriptor so findings are
 * about Angular behavior, not isolated HTML or TypeScript snippets.
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
  /** Async pipe usages, grouped later to catch repeated template subscriptions. */
  asyncPipes: TemplateAsyncPipe[];
  /** Non-async pipe usages that run during rendering. */
  pipes: TemplatePipeBinding[];
  /** Dynamic class/style bindings that can trigger DOM updates. */
  dynamicBindings: TemplateDynamicBinding[];
  /** Template form bindings and submit handlers. */
  formBindings: TemplateFormBinding[];
  /** Coarse rendering shape used by Angular-aware performance rules. */
  rendering: TemplateRenderingSummary;
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
  /** Owner element tag or binding name, if applicable. */
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
  /** Receiver if accessible, e.g. `cart.total()` -> 'cart'. Empty for bare calls. */
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
  /** Nesting depth. 1 = top-level loop, 2+ = nested render fan-out. */
  depth: number;
  /** Loop item variable when statically visible. */
  itemName?: string;
  line: number;
}

export interface TemplateAsyncPipe {
  expression: string;
  line: number;
  kind: TemplateBinding['kind'];
}

export interface TemplatePipeBinding {
  name: string;
  expression: string;
  line: number;
  inHotPath: boolean;
}

export interface TemplateDynamicBinding {
  kind: 'class' | 'style';
  name: string;
  expression: string;
  line: number;
}

export interface TemplateFormBinding {
  kind: 'ngModel' | 'formControlName' | 'formGroup' | 'ngSubmit';
  expression: string;
  line: number;
}

export interface TemplateRenderingSummary {
  elementCount: number;
  maxElementDepth: number;
  loopCount: number;
  maxLoopDepth: number;
  hotBindingCount: number;
  asyncPipeCount: number;
  pipeCount: number;
  dynamicClassStyleCount: number;
  formBindingCount: number;
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
  const asyncPipes: TemplateAsyncPipe[] = [];
  const pipes: TemplatePipeBinding[] = [];
  const dynamicBindings: TemplateDynamicBinding[] = [];
  const formBindings: TemplateFormBinding[] = [];

  let elementDepth = 0;
  let loopDepth = 0;
  let elementCount = 0;
  let maxElementDepth = 0;
  let hotBindingCount = 0;

  const lineOf = (offset: number) => baseLine + offsetToLine(ref.source, offset);

  class Visitor extends TmplAstRecursiveVisitor {
    override visitBoundAttribute(b: TmplAstBoundAttribute): void {
      const expression = expressionText(b.value);
      const line = lineOf(b.sourceSpan.start.offset);
      bindings.push({
        expression,
        line,
        kind: 'attribute',
        ownerTag: b.name,
      });
      hotBindingCount++;
      collectMethodCalls(expression, line, true, methodCalls);
      collectPipes(expression, line, true, pipes, asyncPipes, 'attribute');
      collectDynamicBinding(b.name, expression, line, dynamicBindings);
      collectFormBinding(b.name, expression, line, formBindings);
      super.visitBoundAttribute(b);
    }

    override visitBoundEvent(b: TmplAstBoundEvent): void {
      const expression = expressionText(b.handler);
      const line = lineOf(b.sourceSpan.start.offset);
      bindings.push({
        expression,
        line,
        kind: 'event',
        ownerTag: b.name,
      });
      // Event handlers run on user input, not every change-detection cycle.
      collectMethodCalls(expression, line, false, methodCalls);
      collectFormBinding(b.name, expression, line, formBindings);
      super.visitBoundEvent(b);
    }

    override visitBoundText(b: TmplAstBoundText): void {
      const expression = expressionText(b.value);
      const line = lineOf(b.sourceSpan.start.offset);
      bindings.push({
        expression,
        line,
        kind: 'interpolation',
      });
      hotBindingCount++;
      collectMethodCalls(expression, line, true, methodCalls);
      collectPipes(expression, line, true, pipes, asyncPipes, 'interpolation');
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
      const itemName = readForBlockItem(blk);
      loopDepth++;
      forLoops.push({
        iterableExpression: blk.expression.toString(),
        // Control-flow @for requires a track expression.
        hasTrackBy: true,
        depth: loopDepth,
        ...(itemName ? { itemName } : {}),
        line,
      });
      super.visitForLoopBlock(blk);
      loopDepth--;
    }

    override visitTemplate(tpl: TmplAstTemplate): void {
      const ngFor = readNgFor(tpl);
      if (ngFor) loopDepth++;

      for (const inp of tpl.templateAttrs) {
        const name = inp.name;
        const line = lineOf(inp.sourceSpan.start.offset);
        const expression = expressionText((inp as { value?: unknown }).value);
        if (name === 'ngIf') {
          guards.push({
            expression,
            line,
            kind: 'ngIf',
            range: { startLine: line, endLine: lineOf(tpl.sourceSpan.end.offset) },
          });
        }
        collectFormBinding(name, expression, line, formBindings);
      }

      if (ngFor) {
        forLoops.push({
          iterableExpression: ngFor.expression,
          hasTrackBy: ngFor.hasTrackBy,
          depth: loopDepth,
          ...(ngFor.itemName ? { itemName: ngFor.itemName } : {}),
          line: lineOf(ngFor.sourceSpanStart),
        });
      }

      super.visitTemplate(tpl);
      if (ngFor) loopDepth--;
    }

    override visitElement(el: TmplAstElement): void {
      elementDepth++;
      elementCount++;
      maxElementDepth = Math.max(maxElementDepth, elementDepth);
      collectStaticFormBindings(el, lineOf(el.sourceSpan.start.offset), formBindings);
      super.visitElement(el);
      elementDepth--;
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
    asyncPipes,
    pipes,
    dynamicBindings,
    formBindings,
    rendering: {
      elementCount,
      maxElementDepth,
      loopCount: forLoops.length,
      maxLoopDepth: forLoops.reduce((max, loop) => Math.max(max, loop.depth), 0),
      hotBindingCount,
      asyncPipeCount: asyncPipes.length,
      pipeCount: pipes.length,
      dynamicClassStyleCount: dynamicBindings.length,
      formBindingCount: formBindings.length,
    },
    diagnostics,
  };
}

function expressionText(value: unknown): string {
  if (value === undefined || value === null) return '';
  const maybe = value as { source?: string; ast?: { source?: string }; toString?: () => string };
  const source = maybe.source ?? maybe.ast?.source;
  if (source) return normalizeExpressionText(source);

  const text = maybe.toString ? maybe.toString() : String(value);
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
  if (!sourceFileText || startOffset <= 0) return 0;
  let lines = 0;
  const capped = Math.min(startOffset, sourceFileText.length);
  for (let i = 0; i < capped; i++) {
    if (sourceFileText.charCodeAt(i) === 10) lines++;
  }
  return lines;
}

function collectMethodCalls(expr: string, line: number, inHotPath: boolean, out: TemplateMethodCall[]): void {
  const re = /(?:([A-Za-z_$][\w$]*)\.)?([A-Za-z_$][\w$]*)\s*\(/g;
  let m: RegExpExecArray | null;
  while ((m = re.exec(expr)) !== null) {
    const receiver = m[1] ?? '';
    const name = m[2]!;
    if (name === 'async' || name === 'json' || name === 'date') continue;
    out.push({ name, receiver, line, inHotPath });
  }
}

function collectPipes(
  expr: string,
  line: number,
  inHotPath: boolean,
  pipes: TemplatePipeBinding[],
  asyncPipes: TemplateAsyncPipe[],
  kind: TemplateBinding['kind'],
): void {
  const re = /(^|[^|])\|\s*([A-Za-z_$][\w$]*)\b/g;
  let match: RegExpExecArray | null;
  while ((match = re.exec(expr)) !== null) {
    const name = match[2]!;
    const pipedExpression = expr.slice(0, match.index + match[1]!.length).trim();
    if (name === 'async') {
      asyncPipes.push({ expression: normalizeAsyncPipeExpression(pipedExpression), line, kind });
    } else {
      pipes.push({ name, expression: expr, line, inHotPath });
    }
  }
}

function collectDynamicBinding(
  name: string,
  expression: string,
  line: number,
  out: TemplateDynamicBinding[],
): void {
  if (name === 'ngClass' || name.startsWith('class')) {
    out.push({ kind: 'class', name, expression, line });
  }
  if (name === 'ngStyle' || name.startsWith('style')) {
    out.push({ kind: 'style', name, expression, line });
  }
}

function collectFormBinding(
  name: string,
  expression: string,
  line: number,
  out: TemplateFormBinding[],
): void {
  if (name === 'ngModel' || name === 'formControlName' || name === 'formGroup' || name === 'ngSubmit') {
    out.push({ kind: name, expression, line });
  }
}

function collectStaticFormBindings(el: TmplAstElement, line: number, out: TemplateFormBinding[]): void {
  const attrs = (el as { attributes?: Array<{ name: string; value?: string }> }).attributes ?? [];
  for (const attr of attrs) {
    if (attr.name === 'ngModel' || attr.name === 'formControlName' || attr.name === 'formGroup') {
      out.push({ kind: attr.name, expression: attr.value ?? '', line });
    }
  }
}

function readNgFor(tpl: TmplAstTemplate): {
  expression: string;
  hasTrackBy: boolean;
  itemName?: string;
  sourceSpanStart: number;
} | undefined {
  const attrs = tpl.templateAttrs;
  const ngForAttr = attrs.find((a) => a.name === 'ngFor' || a.name === 'ngForOf');
  if (!ngForAttr) return undefined;
  const expression = expressionText((ngForAttr as { value?: unknown }).value);
  const itemAttr = attrs.find((a) => a.name === 'ngFor');
  const itemText = itemAttr ? expressionText((itemAttr as { value?: unknown }).value) : '';
  const parsed = parseNgForExpression(itemText || expression);
  return {
    expression: parsed.iterableExpression || expression,
    hasTrackBy: attrs.some((a) => a.name === 'ngForTrackBy'),
    ...(parsed.itemName ? { itemName: parsed.itemName } : {}),
    sourceSpanStart: ngForAttr.sourceSpan.start.offset,
  };
}

function parseNgForExpression(text: string): { itemName?: string; iterableExpression: string } {
  const match = /let\s+([A-Za-z_$][\w$]*)\s+of\s+(.+?)(?:;|$)/.exec(text);
  if (!match) return { iterableExpression: text.trim() };
  return {
    itemName: match[1]!,
    iterableExpression: match[2]!.trim(),
  };
}

function readForBlockItem(blk: TmplAstForLoopBlock): string | undefined {
  const item = (blk as { item?: { name?: string } }).item?.name;
  return item && item.trim().length > 0 ? item.trim() : undefined;
}

function normalizeAsyncPipeExpression(expression: string): string {
  return expression.replace(/[()]/g, '').replace(/\s+/g, ' ').trim();
}
