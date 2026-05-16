#!/usr/bin/env node
import 'dotenv/config';
import * as readline from 'node:readline/promises';
import { stdin, stdout } from 'node:process';
import kleur from 'kleur';
import { parsePrInput, type ParseDefaults } from './parse-url.js';
import { reviewOnePr } from './review.js';

/**
 * Interactive CLI server.
 *
 * Boot once → ask for a PR link → analyze → show findings → ask whether to
 * post → loop. Quit with `exit`, `quit`, or Ctrl-C.
 */
async function main() {
  banner();
  validateEnv();

  const rl = readline.createInterface({ input: stdin, output: stdout, terminal: true });
  const defaults: ParseDefaults = {};
  if (process.env['ADO_ORG']) defaults.organization = process.env['ADO_ORG'];
  if (process.env['ADO_PROJECT']) defaults.project = process.env['ADO_PROJECT'];
  if (process.env['ADO_REPO']) defaults.repo = process.env['ADO_REPO'];
  const defaultPr = process.env['ABID_DEFAULT_PR'];

  try {
    while (true) {
      console.log('');
      const promptText =
        kleur.cyan('Enter PR URL or PR number') +
        (defaultPr ? kleur.dim(` (default: ${defaultPr})`) : '') +
        kleur.cyan(' → ');
      const raw = (await rl.question(promptText)).trim();

      if (raw === 'exit' || raw === 'quit' || raw === 'q') break;
      const input = raw === '' ? defaultPr ?? '' : raw;
      if (!input) {
        console.log(kleur.yellow('Please enter a PR URL, a PR number, or "exit".'));
        continue;
      }

      const parsed = parsePrInput(input, defaults);
      if ('error' in parsed) {
        console.log(kleur.red(`✗ ${parsed.error}`));
        continue;
      }

      console.log(
        kleur.dim(`\n→ ${parsed.organization} / ${parsed.project} / ${parsed.repo}  #${parsed.pullRequestId}\n`),
      );

      const t0 = Date.now();
      let result;
      try {
        result = await reviewOnePr(parsed);
      } catch (err) {
        const e = err as Error;
        console.log(kleur.red(`✗ Review failed: ${e.message}`));
        if (process.env['LOG_LEVEL'] === 'debug') console.error(e.stack);
        continue;
      }
      console.log(kleur.dim(`(${((Date.now() - t0) / 1000).toFixed(1)}s)`));
      console.log(result.summaryLine);
      console.log(result.renderedFindings);

      // Ask whether to post.
      const postable = result.findings.filter((f) => f.stage === 'rewritten' || f.stage === 'clustered');
      if (postable.length > 0) {
        const ans = (await rl.question(
          kleur.cyan(`\nPost ${postable.length} comment(s) to ADO PR #${parsed.pullRequestId}? `) +
            kleur.dim('[y/N] ') + kleur.cyan('→ '),
        )).trim().toLowerCase();
        if (ans === 'y' || ans === 'yes') {
          try {
            const posted = await result.postNow();
            console.log(kleur.green(`✓ Posted ${posted} comment(s) to ADO.`));
          } catch (err) {
            console.log(kleur.red(`✗ Posting failed: ${(err as Error).message}`));
          }
        } else {
          console.log(kleur.dim('Skipped posting.'));
        }
      }
    }
  } finally {
    rl.close();
    console.log(kleur.dim('\nbye'));
  }
}

function banner() {
  console.log('');
  console.log(kleur.bold().cyan('  Abid Review — interactive PR analyzer'));
  console.log(kleur.dim('  Type a PR URL or number. Type "exit" to quit.'));
}

function validateEnv() {
  const required = ['MISTRAL_API_KEY', 'ABID_ADO_PAT', 'ADO_ORG'];
  const missing = required.filter((k) => !process.env[k]);
  if (missing.length > 0) {
    console.log(kleur.red(`Missing required .env keys: ${missing.join(', ')}`));
    console.log(kleur.dim('Copy .env.example to .env and fill in the values.'));
    process.exit(1);
  }
}

main().catch((err) => {
  console.error(kleur.red(`fatal: ${(err as Error).message}`));
  process.exit(1);
});
