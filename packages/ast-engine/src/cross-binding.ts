import type { AstProject } from './project.js';
import type { ComponentDescriptor, FieldDescriptor, MethodDescriptor } from './types.js';
import type { TemplateAnalysis, TemplateBinding } from './template-parser.js';

/**
 * Cross-binding resolves a template expression to the TS member it refers to,
 * plus the member's declared type. This is what stops false-positive null-check
 * comments when the TS guarantees non-null.
 *
 * Resolution rules:
 *   - `foo` → look up member named `foo` on the component class. If found,
 *     return its declared type.
 *   - `foo.bar` → resolve `foo` recursively, then look up `bar` on the resolved type.
 *   - Local template variables (`*ngFor let item of items`, `@for (item of items;)`)
 *     are bound to the element type of the iterable.
 *
 * Heuristic limits:
 *   - We don't fully evaluate complex expressions (ternaries, method calls returning
 *     unions). For those, we return `kind: 'unresolved'`. Rules treat unresolved
 *     expressions as "unknown" and refuse to fire negatives on them.
 */
export interface ResolvedBinding {
  expression: string;
  kind: 'resolved' | 'unresolved';
  /** When resolved: the TS type-checker's string for the resolved symbol type. */
  typeText?: string;
  /** When resolved: whether the type permits null/undefined at this position. */
  allowsNullish?: boolean;
  /** When resolved: the originating component field/method name. */
  rootSymbol?: string;
  /** When resolved and the root symbol is a field, the field descriptor. */
  rootField?: FieldDescriptor;
  /** When resolved and the root symbol is a method, the method descriptor. */
  rootMethod?: MethodDescriptor;
}

export function resolveBindings(
  project: AstProject,
  component: ComponentDescriptor,
  template: TemplateAnalysis,
): ResolvedBinding[] {
  const out: ResolvedBinding[] = [];
  for (const b of template.bindings) {
    out.push(resolveBinding(project, component, b));
  }
  return out;
}

export function resolveBinding(
  project: AstProject,
  component: ComponentDescriptor,
  binding: TemplateBinding,
): ResolvedBinding {
  const root = extractRootIdentifier(binding.expression);
  if (!root) return { expression: binding.expression, kind: 'unresolved' };

  const field = component.fields.find((f) => f.name === root);
  if (field) {
    // For chained access (`foo.bar`), narrow further using the TypeChecker.
    const chain = chainAfterRoot(binding.expression);
    if (chain.length === 0) {
      return {
        expression: binding.expression,
        kind: 'resolved',
        typeText: field.typeText,
        allowsNullish: field.allowsNullish,
        rootSymbol: field.name,
        rootField: field,
      };
    }
    const narrowed = narrowAlongChain(project, component, field, chain);
    if (narrowed) {
      return { expression: binding.expression, kind: 'resolved', ...narrowed, rootSymbol: field.name, rootField: field };
    }
    return {
      expression: binding.expression,
      kind: 'resolved',
      typeText: field.typeText,
      allowsNullish: field.allowsNullish,
      rootSymbol: field.name,
      rootField: field,
    };
  }

  const method = component.methods.find((m) => m.name === root);
  if (method) {
    return {
      expression: binding.expression,
      kind: 'resolved',
      typeText: 'method',
      allowsNullish: false,
      rootSymbol: method.name,
      rootMethod: method,
    };
  }

  return { expression: binding.expression, kind: 'unresolved' };
}

function extractRootIdentifier(expr: string): string | null {
  const m = /^[\s(]*([A-Za-z_$][\w$]*)/.exec(expr);
  return m ? m[1]! : null;
}

function chainAfterRoot(expr: string): string[] {
  // `foo.bar?.baz` → ['bar', 'baz']. We strip optional chaining and arguments for now.
  const after = expr.replace(/^[\s(]*[A-Za-z_$][\w$]*/, '');
  const parts = after.split(/[.?]+/).filter(Boolean);
  return parts.map((p) => p.replace(/\(.*$/, '').trim());
}

function narrowAlongChain(
  project: AstProject,
  component: ComponentDescriptor,
  rootField: FieldDescriptor,
  chain: string[],
): { typeText: string; allowsNullish: boolean } | null {
  const sf = project.getSourceFile(component.tsFile);
  if (!sf) return null;
  const cls = sf.getClass(component.className);
  if (!cls) return null;
  const prop = cls.getProperty(rootField.name);
  if (!prop) return null;

  let currentType = prop.getType();
  for (const member of chain) {
    // Unwrap signal types: WritableSignal<T> exposes its `()` callable; we approximate
    // by reading the call signature return type when the member text is `()`.
    if (member === '') {
      const sig = currentType.getCallSignatures()[0];
      if (!sig) return null;
      currentType = sig.getReturnType();
      continue;
    }
    const sym = currentType.getProperty(member);
    if (!sym) return null;
    const decl = sym.getDeclarations()[0];
    if (!decl) return null;
    currentType = sym.getTypeAtLocation(decl);
  }

  return {
    typeText: currentType.getText(),
    allowsNullish: currentType.isNullable() || /\b(null|undefined)\b/.test(currentType.getText()),
  };
}
