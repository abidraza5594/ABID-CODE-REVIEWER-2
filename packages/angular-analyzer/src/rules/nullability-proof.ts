import {
  Node,
  SyntaxKind,
  VariableDeclarationKind,
  type Expression,
  type Node as TsMorphNode,
  type SourceFile,
  type Type,
} from 'ts-morph';
import type { AstProject } from '@abid/ast-engine';

export type RepositoryValueProof =
  | { verdict: 'not-import'; imported: false; reason: string }
  | { verdict: 'not-null'; imported: boolean; reason: string; declaringFile?: string; symbolName?: string }
  | { verdict: 'nullable'; imported: boolean; reason: string; declaringFile?: string; symbolName?: string }
  | { verdict: 'unresolved'; imported: boolean; reason: string; declaringFile?: string; symbolName?: string };

/**
 * Only returns true when the receiver value itself can be nullish.
 * A type like `(Option | undefined)[]` is an initialized array whose elements
 * may be undefined; the array value is still safe for `.slice(...)`.
 */
export function typeAllowsNullish(type: Type): boolean {
  if (type.isNullable()) return true;
  if (!type.isUnion()) return false;
  return type.getUnionTypes().some((part) =>
    part.isNull() ||
    part.isUndefined() ||
    part.getText() === 'void',
  );
}

export function repositoryValueProof(
  project: AstProject,
  sourceFile: SourceFile,
  expression: TsMorphNode,
): RepositoryValueProof {
  if (Node.isIdentifier(expression)) {
    return identifierProof(project, sourceFile, expression.getText(), 0);
  }

  if (Node.isPropertyAccessExpression(expression)) {
    const owner = expression.getExpression();
    if (Node.isIdentifier(owner)) {
      const namespace = namespaceImportSource(sourceFile, owner.getText());
      if (namespace) {
        return exportedDeclarationProof(project, namespace.sourceFile, expression.getName(), 0, true);
      }
    }
  }

  return { verdict: 'not-import', imported: false, reason: 'receiver is not an imported repository value' };
}

export function componentFieldInitializationProof(
  project: AstProject,
  componentFile: string,
  className: string,
  fieldName: string,
): RepositoryValueProof {
  const sourceFile = project.getSourceFile(componentFile);
  const cls = sourceFile?.getClass(className);
  const field = cls?.getProperty(fieldName);
  if (!sourceFile || !field) {
    return { verdict: 'unresolved', imported: false, reason: 'component field declaration was not found' };
  }

  const type = field.getType();
  if (!typeAllowsNullish(type)) {
    return {
      verdict: 'not-null',
      imported: false,
      reason: 'component field type does not allow null or undefined',
      declaringFile: project.relativePath(sourceFile),
      symbolName: fieldName,
    };
  }

  const initializer = field.getInitializer();
  if (!initializer) {
    return { verdict: 'unresolved', imported: false, reason: 'component field has no initializer' };
  }

  return expressionInitializationProof(project, sourceFile, initializer, 0);
}

function identifierProof(
  project: AstProject,
  sourceFile: SourceFile,
  localName: string,
  depth: number,
): RepositoryValueProof {
  if (depth > 4) {
    return { verdict: 'unresolved', imported: false, reason: 'definition trace exceeded the recursion limit' };
  }

  const imported = importedBinding(sourceFile, localName);
  if (imported) {
    if (!imported.sourceFile) {
      return {
        verdict: 'unresolved',
        imported: true,
        reason: `import source for ${localName} could not be resolved`,
        symbolName: imported.exportName,
      };
    }
    if (imported.namespaceOnly) {
      return {
        verdict: 'not-null',
        imported: true,
        reason: `${localName} is a resolved namespace import object`,
        declaringFile: project.relativePath(imported.sourceFile),
        symbolName: imported.exportName,
      };
    }
    return exportedDeclarationProof(project, imported.sourceFile, imported.exportName, depth + 1, true);
  }

  const local = localVariableDeclaration(sourceFile, localName);
  if (local) {
    return variableDeclarationProof(project, local, depth + 1, false);
  }

  return { verdict: 'not-import', imported: false, reason: `${localName} is not imported from this source file` };
}

function exportedDeclarationProof(
  project: AstProject,
  sourceFile: SourceFile,
  exportName: string,
  depth: number,
  imported: boolean,
): RepositoryValueProof {
  const declarations = sourceFile.getExportedDeclarations().get(exportName) ?? [];
  const proofs = declarations.map((declaration) => declarationProof(project, declaration, depth + 1, imported));
  const resolved = proofs.filter((proof) => proof.verdict !== 'unresolved' && proof.verdict !== 'not-import');

  if (resolved.some((proof) => proof.verdict === 'nullable')) {
    return resolved.find((proof) => proof.verdict === 'nullable')!;
  }
  if (resolved.length > 0 && resolved.every((proof) => proof.verdict === 'not-null')) {
    return {
      verdict: 'not-null',
      imported,
      reason: `${exportName} resolves to an initialized non-null export`,
      declaringFile: project.relativePath(sourceFile),
      symbolName: exportName,
    };
  }

  const local = localVariableDeclaration(sourceFile, exportName);
  if (local) return variableDeclarationProof(project, local, depth + 1, imported);

  return {
    verdict: 'unresolved',
    imported,
    reason: `exported definition for ${exportName} was not found`,
    declaringFile: project.relativePath(sourceFile),
    symbolName: exportName,
  };
}

function declarationProof(
  project: AstProject,
  declaration: TsMorphNode,
  depth: number,
  imported: boolean,
): RepositoryValueProof {
  if (Node.isVariableDeclaration(declaration)) {
    return variableDeclarationProof(project, declaration, depth + 1, imported);
  }
  if (Node.isEnumDeclaration(declaration) || Node.isClassDeclaration(declaration) || Node.isFunctionDeclaration(declaration)) {
    const symbolName = declaration.getSymbol()?.getName();
    return {
      verdict: 'not-null',
      imported,
      reason: `${declaration.getKindName()} is a guaranteed repository declaration`,
      declaringFile: project.relativePath(declaration.getSourceFile()),
      ...(symbolName ? { symbolName } : {}),
    };
  }
  if (Node.isPropertyDeclaration(declaration)) {
    return propertyDeclarationProof(project, declaration, depth + 1, imported);
  }
  const symbolName = declaration.getSymbol()?.getName();
  return {
    verdict: 'unresolved',
    imported,
    reason: `${declaration.getKindName()} is not a supported nullability proof source`,
    declaringFile: project.relativePath(declaration.getSourceFile()),
    ...(symbolName ? { symbolName } : {}),
  };
}

function variableDeclarationProof(
  project: AstProject,
  declaration: import('ts-morph').VariableDeclaration,
  depth: number,
  imported: boolean,
): RepositoryValueProof {
  const name = declaration.getName();
  const sourceFile = declaration.getSourceFile();
  const declarationKind = declaration.getVariableStatement()?.getDeclarationKind();
  if (declarationKind !== VariableDeclarationKind.Const) {
    return {
      verdict: 'unresolved',
      imported,
      reason: `${name} is not declared with const`,
      declaringFile: project.relativePath(sourceFile),
      symbolName: name,
    };
  }

  const initializer = declaration.getInitializer();
  if (!initializer) {
    return {
      verdict: 'unresolved',
      imported,
      reason: `${name} has no initializer`,
      declaringFile: project.relativePath(sourceFile),
      symbolName: name,
    };
  }

  const type = declaration.getType();
  if (isExplicitNullish(initializer) || typeAllowsNullish(type)) {
    return {
      verdict: 'nullable',
      imported,
      reason: `${name} has a nullable exported type or initializer`,
      declaringFile: project.relativePath(sourceFile),
      symbolName: name,
    };
  }

  if (isStaticNonNullExpression(initializer) || !type.isAny() && !type.isUnknown()) {
    return {
      verdict: 'not-null',
      imported,
      reason: `${name} is a const initialized to a non-null value`,
      declaringFile: project.relativePath(sourceFile),
      symbolName: name,
    };
  }

  return expressionInitializationProof(project, sourceFile, initializer, depth + 1);
}

function propertyDeclarationProof(
  project: AstProject,
  declaration: import('ts-morph').PropertyDeclaration,
  depth: number,
  imported: boolean,
): RepositoryValueProof {
  const name = declaration.getName();
  const initializer = declaration.getInitializer();
  if (!declaration.isReadonly() && !declaration.isStatic()) {
    return {
      verdict: 'unresolved',
      imported,
      reason: `${name} is not readonly or static`,
      declaringFile: project.relativePath(declaration.getSourceFile()),
      symbolName: name,
    };
  }
  if (!initializer) {
    return {
      verdict: 'unresolved',
      imported,
      reason: `${name} has no initializer`,
      declaringFile: project.relativePath(declaration.getSourceFile()),
      symbolName: name,
    };
  }
  if (typeAllowsNullish(declaration.getType()) || isExplicitNullish(initializer)) {
    return {
      verdict: 'nullable',
      imported,
      reason: `${name} has a nullable type or initializer`,
      declaringFile: project.relativePath(declaration.getSourceFile()),
      symbolName: name,
    };
  }
  if (isStaticNonNullExpression(initializer)) {
    return {
      verdict: 'not-null',
      imported,
      reason: `${name} is readonly/static and initialized`,
      declaringFile: project.relativePath(declaration.getSourceFile()),
      symbolName: name,
    };
  }
  return expressionInitializationProof(project, declaration.getSourceFile(), initializer, depth + 1);
}

function expressionInitializationProof(
  project: AstProject,
  sourceFile: SourceFile,
  expression: Expression,
  depth: number,
): RepositoryValueProof {
  if (isExplicitNullish(expression)) {
    return { verdict: 'nullable', imported: false, reason: 'initializer is null or undefined' };
  }
  if (isStaticNonNullExpression(expression) || !typeAllowsNullish(expression.getType())) {
    return {
      verdict: 'not-null',
      imported: false,
      reason: 'initializer is statically non-null',
      declaringFile: project.relativePath(sourceFile),
    };
  }
  if (Node.isIdentifier(expression) || Node.isPropertyAccessExpression(expression)) {
    return repositoryValueProof(project, sourceFile, expression);
  }
  if (depth > 4) {
    return { verdict: 'unresolved', imported: false, reason: 'initializer trace exceeded recursion limit' };
  }
  return { verdict: 'unresolved', imported: false, reason: 'initializer can still evaluate to nullish' };
}

function importedBinding(sourceFile: SourceFile, localName: string): {
  sourceFile: SourceFile | undefined;
  exportName: string;
  namespaceOnly: boolean;
} | undefined {
  for (const imp of sourceFile.getImportDeclarations()) {
    const importedSource = imp.getModuleSpecifierSourceFile();
    const defaultImport = imp.getDefaultImport();
    if (defaultImport?.getText() === localName) {
      return { sourceFile: importedSource, exportName: 'default', namespaceOnly: false };
    }

    const namespaceImport = imp.getNamespaceImport();
    if (namespaceImport?.getText() === localName) {
      return { sourceFile: importedSource, exportName: localName, namespaceOnly: true };
    }

    for (const named of imp.getNamedImports()) {
      const local = named.getAliasNode()?.getText() ?? named.getName();
      if (local === localName) {
        return { sourceFile: importedSource, exportName: named.getName(), namespaceOnly: false };
      }
    }
  }
  return undefined;
}

function namespaceImportSource(sourceFile: SourceFile, localName: string): { sourceFile: SourceFile } | undefined {
  for (const imp of sourceFile.getImportDeclarations()) {
    const namespaceImport = imp.getNamespaceImport();
    const importedSource = imp.getModuleSpecifierSourceFile();
    if (namespaceImport?.getText() === localName && importedSource) {
      return { sourceFile: importedSource };
    }
  }
  return undefined;
}

function localVariableDeclaration(sourceFile: SourceFile, name: string): import('ts-morph').VariableDeclaration | undefined {
  for (const statement of sourceFile.getVariableStatements()) {
    for (const declaration of statement.getDeclarations()) {
      if (declaration.getName() === name) return declaration;
    }
  }
  return undefined;
}

function isStaticNonNullExpression(expression: Expression): boolean {
  const kind = expression.getKind();
  if (
    kind === SyntaxKind.ArrayLiteralExpression ||
    kind === SyntaxKind.ObjectLiteralExpression ||
    kind === SyntaxKind.StringLiteral ||
    kind === SyntaxKind.NoSubstitutionTemplateLiteral ||
    kind === SyntaxKind.NumericLiteral ||
    kind === SyntaxKind.TrueKeyword ||
    kind === SyntaxKind.FalseKeyword ||
    kind === SyntaxKind.ArrowFunction ||
    kind === SyntaxKind.FunctionExpression ||
    kind === SyntaxKind.ClassExpression
  ) {
    return true;
  }
  if (Node.isAsExpression(expression) || Node.isSatisfiesExpression(expression)) {
    return isStaticNonNullExpression(expression.getExpression());
  }
  return false;
}

function isExplicitNullish(expression: Expression): boolean {
  return expression.getKind() === SyntaxKind.NullKeyword ||
    (Node.isIdentifier(expression) && expression.getText() === 'undefined');
}
