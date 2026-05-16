/**
 * Per-repo configuration. Customers commit this to the root of their repo.
 * The orchestrator reads it after cloning.
 */
export default {
  /**
   * Per-rule enable/disable + thresholds.
   * Missing rules use the platform default.
   */
  rules: {
    'angular/subscription-leak':      { enabled: true,  confidenceFloor: 0.75 },
    'angular/null-without-guard':     { enabled: true,  confidenceFloor: 0.80 },
    'angular/template-method-call':   { enabled: true,  confidenceFloor: 0.78 },
    'angular/trackby-missing':        { enabled: true,  severity: 'info'      },
    'angular/signal-over-trigger':    { enabled: false                          },
    'angular/indexeddb-stale-read':   { enabled: true,  confidenceFloor: 0.80 },
  },

  /**
   * Voice tuning — appended to the system prompt for the voice-rewrite step.
   * Keep it short. This is *not* a place to encode review rules; those live
   * in the rule pack.
   */
  voice: {
    glossary: {
      // Internal acronyms expanded for plain-English rewrites.
      'CDS': 'customer data service',
    },
    bannedWords: ['leverage', 'utilize', 'paradigm'],
  },

  /**
   * Runtime scenarios. The runtime-runner executes one of these when a
   * finding needs corroboration. Path is relative to repo root.
   */
  runtime: {
    baseUrl: 'http://localhost:4200',
    scenarios: [
      {
        id: 'login-and-browse',
        description: 'Login then navigate through 3 list views — covers shell + most leaf components.',
        scriptPath: 'tests/scenarios/login-and-browse.scenario.ts',
        exercises: ['ShellComponent', 'UserListComponent', 'OrderListComponent'],
        timeoutMs: 60_000,
        iterations: 3,
      },
    ],
  },

  /**
   * Per-file or per-path exclusions. Common cases: generated code, vendor
   * scripts, legacy modules we know we'll rewrite.
   */
  exclude: [
    'src/generated/**',
    'src/vendor/**',
  ],
};
