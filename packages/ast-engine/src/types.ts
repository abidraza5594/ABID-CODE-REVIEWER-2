/**
 * Stable, serializable shapes the rule pack reads. The AST engine wraps ts-morph
 * and Angular's template parser; rules should never touch those libs directly
 * (it would couple the rules to library version changes).
 */

import type { SourceLocation } from '@abid/core';

export interface ComponentDescriptor {
  /** Fully qualified class name. */
  className: string;
  /** Component decorator selector, when statically resolvable. */
  selector: string | null;
  /** True if the decorator declares `standalone: true`. */
  standalone: boolean;
  /** Change detection strategy literal, or null when not set. */
  changeDetection: 'Default' | 'OnPush' | null;
  /** Path to the component's .ts source file. */
  tsFile: string;
  /** Path(s) to inline or external templates. */
  templates: TemplateRef[];
  /** Discovered injected dependencies — names + (when resolvable) declaring symbol. */
  injections: InjectionRef[];
  /** Detected destroy patterns. Used as guarantees by lifecycle rules. */
  destroy: DestroySupport;
  /** Methods declared on the class. */
  methods: MethodDescriptor[];
  /** Class fields whose initializer is a `signal()` / `computed()` / `inject()` etc. */
  fields: FieldDescriptor[];
  /** Class declaration location (head-revision). */
  location: SourceLocation;
}

export interface TemplateRef {
  /** 'inline' means the template lived in the component file. */
  kind: 'inline' | 'external';
  /** Source path of the template (.html) or component file (for inline). */
  file: string;
  /** Char-offset of the template *string* into the source file — needed to map
   *  template AST positions back to repo line numbers. */
  startOffset: number;
  /** The raw template source, normalized to \n line endings. */
  source: string;
}

export interface InjectionRef {
  /** Constructor parameter name, or field name for inject() form. */
  paramName: string;
  /** Class/interface symbol name (post-resolution). */
  typeName: string;
  /** When the injection is a known service we have intel on, the file declaring it. */
  declaringFile?: string;
}

export interface DestroySupport {
  hasNgOnDestroy: boolean;
  hasDestroyRef: boolean;
  /** `inject(DestroyRef)` field name, if found. */
  destroyRefField?: string;
  /** True if the component imports and uses `takeUntilDestroyed`. */
  usesTakeUntilDestroyed: boolean;
}

export interface MethodDescriptor {
  name: string;
  /** Source location (head-revision). */
  location: SourceLocation;
  /** Body text (used for prompting and pattern matching). */
  text: string;
  /** Whether the method is a known lifecycle hook. */
  lifecycle?: 'ngOnInit' | 'ngOnDestroy' | 'ngOnChanges' | 'ngAfterViewInit' | 'ngAfterContentInit';
  /** Subscribe() call sites discovered in this method. */
  subscribeCalls: SubscribeCall[];
}

export interface SubscribeCall {
  /** Location of the `.subscribe(` call. */
  location: SourceLocation;
  /** The chain of `.pipe(...)` operators preceding the subscribe, by name. */
  pipeOperators: string[];
  /** Whether one of the pipe operators is takeUntilDestroyed / takeUntil. */
  hasTakeUntil: boolean;
  /** Whether the result is assigned to a class field (potential manual unsubscribe). */
  assignedToField: string | null;
  /** The raw expression that subscribe was called on, normalized. */
  receiverText: string;
}

export interface FieldDescriptor {
  name: string;
  location: SourceLocation;
  /** Static initializer kind, narrowed to the patterns we care about. */
  initializerKind: 'signal' | 'computed' | 'inject' | 'literal' | 'other';
  /** The TS source of the initializer expression. */
  initializerText: string;
  /** TS type as string, e.g. 'WritableSignal<User | null>'. */
  typeText: string;
  /** Whether the type allows null/undefined. */
  allowsNullish: boolean;
}
