import * as path from 'node:path';
import { Project, type ProjectOptions, type SourceFile } from 'ts-morph';

/**
 * Thin wrapper around a ts-morph Project, configured for Angular repos.
 *
 * Rules NEVER touch ts-morph directly. They get TypedSourceFile views through
 * `AstProject.getSourceFile()` and the project-wide TypeChecker through
 * `AstProject.typeChecker()`. This keeps the lib version coupled here.
 */
export class AstProject {
  private project: Project;
  private rootDir: string;

  constructor(rootDir: string, opts: Partial<ProjectOptions> = {}) {
    this.rootDir = path.resolve(rootDir);
    // We deliberately use the *user repo's* tsconfig so module resolution,
    // path mappings, and decorator emit settings match production.
    this.project = new Project({
      tsConfigFilePath: this.findTsConfig(),
      skipAddingFilesFromTsConfig: false,
      skipFileDependencyResolution: false,
      ...opts,
    });
  }

  private findTsConfig(): string {
    // Prefer the repo's tsconfig.json. We don't walk down — orchestrator points us at the right root.
    return path.join(this.rootDir, 'tsconfig.json');
  }

  get tsMorphProject(): Project {
    return this.project;
  }

  /** Loaded source files (excluding declaration-only files). */
  sourceFiles(): SourceFile[] {
    return this.project.getSourceFiles().filter((sf) => !sf.isDeclarationFile());
  }

  /** Repo-relative forward-slash path for a SourceFile. */
  relativePath(sf: SourceFile): string {
    return path.relative(this.rootDir, sf.getFilePath()).replace(/\\/g, '/');
  }

  getSourceFile(repoRelativePath: string): SourceFile | undefined {
    const abs = path.join(this.rootDir, repoRelativePath);
    return this.project.getSourceFile(abs);
  }

  /** Get the project-wide TypeChecker. */
  typeChecker() {
    return this.project.getTypeChecker();
  }
}
