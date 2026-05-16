/**
 * A Guarantee is evidence *against* a finding — reasons we might be wrong.
 * The confidence engine subtracts weight for each applicable guarantee.
 * The LLM false-positive filter checks every finding's guarantees before
 * letting the comment through.
 *
 * This is the single most important data structure for false-positive reduction.
 */
export type Guarantee =
  | ResolverGuarantee
  | RouteGuardGuarantee
  | TypeNarrowingGuarantee
  | TemplateGuard
  | DefaultInitGuarantee
  | DestroyHookGuarantee
  | TakeUntilDestroyedGuarantee
  | AsyncPipeGuarantee
  | OnPushGuarantee;

export interface ResolverGuarantee {
  kind: 'resolver';
  route: string;
  field: string;
  /** The TS file declaring the resolver. */
  declaringFile: string;
  /** The resolved type at runtime (post-resolve). */
  resolvedTypeText: string;
}

export interface RouteGuardGuarantee {
  kind: 'guard';
  /** e.g. CanActivate guard name. */
  guardName: string;
  /** What it guarantees: e.g. "authenticated user with non-null userId". */
  guarantees: string;
}

export interface TypeNarrowingGuarantee {
  kind: 'type-narrowing';
  /** The narrowing site, e.g. `if (user)` block. */
  narrowingExpression: string;
  description: string;
}

export interface TemplateGuard {
  kind: 'template-ngIf';
  /** The guard expression. */
  expression: string;
  /** The element/template that owns the guard. */
  ownerKind: 'ngIf' | '@if' | 'ngSwitch' | 'ngFor';
}

export interface DefaultInitGuarantee {
  kind: 'default-init';
  /** Field/property initialized at declaration site. */
  symbolName: string;
  /** Initializer source. */
  initializer: string;
}

export interface DestroyHookGuarantee {
  kind: 'destroy-hook';
  /** Implemented OnDestroy / DestroyRef pattern. */
  pattern: 'ngOnDestroy' | 'DestroyRef.onDestroy' | 'takeUntilDestroyed';
  declaringFile: string;
}

export interface TakeUntilDestroyedGuarantee {
  kind: 'take-until-destroyed';
  /** The pipe step that ties the subscription lifetime to the host destroy. */
  pipeStep: string;
}

export interface AsyncPipeGuarantee {
  kind: 'async-pipe';
  /** Subscription is managed by the async pipe in the template. */
  templatePath: string;
}

export interface OnPushGuarantee {
  kind: 'on-push';
  /** Component path. Reduces change-detection-related findings. */
  componentName: string;
}
