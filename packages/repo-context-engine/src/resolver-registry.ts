import type { AstProject } from '@abid/ast-engine';
import { SyntaxKind } from 'ts-morph';

/**
 * Discovers Angular route resolvers and the typed shape they guarantee.
 *
 * Why this matters: a route resolver that fetches a User and waits for it
 * BEFORE the component is activated *guarantees* that `route.snapshot.data.user`
 * is non-null in the component. Without this registry, rules cannot tell that
 * `user.name` in the template is safe.
 *
 * We scan for:
 *   1. Class implementations of `Resolve<T>` (legacy form).
 *   2. Functional resolvers — exported functions matching the `ResolveFn<T>` shape.
 *   3. Route configuration objects with `resolve: { key: Resolver }` mappings.
 *
 * The registry is keyed by `(route-path, field-name)` and tagged with the
 * resolved type's text + the declaring file.
 */
export interface ResolverEntry {
  /** Route path string from the routing config, e.g. "users/:id". */
  routePath: string;
  /** Property name in `route.data`. */
  field: string;
  /** TypeChecker textual representation of the resolved value. */
  resolvedTypeText: string;
  /** Source file where the resolver is declared. */
  declaringFile: string;
  /** Whether the type permits null/undefined. Used by null-check rules. */
  allowsNullish: boolean;
}

export class ResolverRegistry {
  private byField = new Map<string, ResolverEntry[]>();

  add(entry: ResolverEntry): void {
    if (!this.byField.has(entry.field)) this.byField.set(entry.field, []);
    this.byField.get(entry.field)!.push(entry);
  }

  /**
   * Look up resolvers that guarantee a `route.data.<field>` value, optionally
   * filtered by route path. We can't always tie a component to a route in
   * isolation; rules pass the best route they can derive (often null), and
   * we return all candidates.
   */
  lookup(field: string, routePath?: string): ResolverEntry[] {
    const candidates = this.byField.get(field) ?? [];
    if (!routePath) return candidates;
    return candidates.filter((e) => e.routePath === routePath);
  }

  all(): ResolverEntry[] {
    return [...this.byField.values()].flat();
  }
}

export function buildResolverRegistry(project: AstProject): ResolverRegistry {
  const reg = new ResolverRegistry();

  // Pass 1: collect resolver class/function declarations with their resolved type.
  const resolverByName = new Map<string, { type: string; file: string; allowsNullish: boolean }>();

  for (const sf of project.sourceFiles()) {
    const file = project.relativePath(sf);

    // Functional resolvers: `export const userResolver: ResolveFn<User> = ...`
    for (const v of sf.getVariableDeclarations()) {
      const typeNode = v.getTypeNode();
      if (!typeNode) continue;
      const text = typeNode.getText();
      const m = /^ResolveFn<([\s\S]+)>$/.exec(text.trim());
      if (!m) continue;
      const resolved = m[1]!.trim();
      resolverByName.set(v.getName(), {
        type: resolved,
        file,
        allowsNullish: /\b(null|undefined)\b/.test(resolved),
      });
    }

    // Class resolvers: `class UserResolver implements Resolve<User>`
    for (const cls of sf.getClasses()) {
      for (const heritage of cls.getHeritageClauses()) {
        for (const typeNode of heritage.getTypeNodes()) {
          const m = /^Resolve<([\s\S]+)>$/.exec(typeNode.getText().trim());
          if (!m || !cls.getName()) continue;
          const resolved = m[1]!.trim();
          resolverByName.set(cls.getName()!, {
            type: resolved,
            file,
            allowsNullish: /\b(null|undefined)\b/.test(resolved),
          });
        }
      }
    }
  }

  // Pass 2: find route configs and associate path → resolve map → typed entry.
  for (const sf of project.sourceFiles()) {
    sf.forEachDescendant((node) => {
      if (node.getKind() !== SyntaxKind.ObjectLiteralExpression) return;
      const obj = node.asKindOrThrow(SyntaxKind.ObjectLiteralExpression);
      const pathProp = obj.getProperty('path');
      const resolveProp = obj.getProperty('resolve');
      if (!pathProp || !resolveProp) return;
      if (pathProp.getKind() !== SyntaxKind.PropertyAssignment) return;
      if (resolveProp.getKind() !== SyntaxKind.PropertyAssignment) return;
      const pathInit = pathProp.asKindOrThrow(SyntaxKind.PropertyAssignment).getInitializer();
      const resolveInit = resolveProp.asKindOrThrow(SyntaxKind.PropertyAssignment).getInitializer();
      if (!pathInit || !resolveInit) return;
      if (pathInit.getKind() !== SyntaxKind.StringLiteral) return;
      if (resolveInit.getKind() !== SyntaxKind.ObjectLiteralExpression) return;

      const routePath = pathInit.getText().slice(1, -1);
      const resolveObj = resolveInit.asKindOrThrow(SyntaxKind.ObjectLiteralExpression);
      for (const member of resolveObj.getProperties()) {
        if (member.getKind() !== SyntaxKind.PropertyAssignment) continue;
        const fieldName = member.asKindOrThrow(SyntaxKind.PropertyAssignment).getName();
        const valueInit = member.asKindOrThrow(SyntaxKind.PropertyAssignment).getInitializer();
        if (!valueInit) continue;
        const resolverName = valueInit.getText().trim();
        const entry = resolverByName.get(resolverName);
        if (!entry) continue;
        reg.add({
          routePath,
          field: fieldName,
          resolvedTypeText: entry.type,
          declaringFile: entry.file,
          allowsNullish: entry.allowsNullish,
        });
      }
    });
  }

  return reg;
}
