import * as fs from 'node:fs';
import * as path from 'node:path';

/**
 * Loads versioned prompt templates from the `prompts/` directory at repo root.
 *
 * Each template lives in a directory like `prompts/voice-rewrite/v3.md` with
 * a small JSON sidecar `v3.meta.json` for parameters / model hints. We pick
 * the highest-versioned file by default; the orchestrator can override via
 * env (`ABID_PROMPT_VOICE_REWRITE_VERSION=v2`) for A/B comparisons.
 *
 * We intentionally keep prompts on disk rather than baking them into TS — it
 * lets product write/edit prompts without redeploying.
 */
export interface PromptTemplate {
  name: string;
  version: string;
  body: string;
  meta: PromptMeta;
}

export interface PromptMeta {
  /** Default model override for this template. */
  model?: string;
  /** Default temperature override. */
  temperature?: number;
  /** Max output tokens. */
  maxTokens?: number;
}

export class PromptLoader {
  constructor(private readonly promptsDir: string) {}

  load(name: string, version?: string): PromptTemplate {
    const dir = path.join(this.promptsDir, name);
    const files = fs.readdirSync(dir).filter((f) => f.endsWith('.md'));
    if (files.length === 0) throw new Error(`no prompt files for ${name} in ${dir}`);
    const chosen = version
      ? files.find((f) => f === `${version}.md`)
      : files.sort(versionDesc)[0]!;
    if (!chosen) throw new Error(`prompt ${name}@${version} not found`);
    const body = fs.readFileSync(path.join(dir, chosen), 'utf8');
    const ver = chosen.replace(/\.md$/, '');
    const metaPath = path.join(dir, `${ver}.meta.json`);
    const meta: PromptMeta = fs.existsSync(metaPath)
      ? JSON.parse(fs.readFileSync(metaPath, 'utf8'))
      : {};
    return { name, version: ver, body, meta };
  }
}

function versionDesc(a: string, b: string): number {
  // 'v3.md' > 'v2.md' > 'v10.md' should sort numerically; we strip 'v' and 'm' for ordering.
  const na = parseInt(a.replace(/^v(\d+)\.md$/, '$1'), 10);
  const nb = parseInt(b.replace(/^v(\d+)\.md$/, '$1'), 10);
  return nb - na;
}

/**
 * Replace `{{var}}` placeholders. We deliberately don't use a full template
 * language — every placeholder is a literal substitution wrapped in fixed
 * delimiters that signal "data, not instructions" to the model.
 */
export function fillPrompt(template: PromptTemplate, vars: Record<string, string>): string {
  return template.body.replace(/\{\{(\w+)\}\}/g, (_, name) => {
    const v = vars[name];
    if (v === undefined) {
      throw new Error(`prompt ${template.name}@${template.version} missing var '${name}'`);
    }
    return v;
  });
}
