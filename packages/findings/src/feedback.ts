/**
 * Feedback records collected from ADO comment threads. Used by the
 * confidence engine's weekly recalibration cron.
 *
 *   - `resolved` = author marked thread resolved without rebuttal text
 *   - `refuted` = author replied with a refutation phrase, or reacted thumbs-down
 *   - `ignored` = thread still active after N days
 */
export type FeedbackOutcome = 'resolved' | 'refuted' | 'ignored';

export interface FeedbackRecord {
  findingId: string;
  ruleId: string;
  tenantId: string;
  adoThreadId: number;
  outcome: FeedbackOutcome;
  /** When the outcome was determined (UTC ISO). */
  observedAt: string;
  /** Optional refutation text excerpt (≤ 240 chars). */
  refutationExcerpt?: string;
}

export interface FeedbackStore {
  record(rec: FeedbackRecord): Promise<void>;
  forRule(ruleId: string, tenantId: string, sinceIso: string): Promise<FeedbackRecord[]>;
}

/** Common refutation phrases — used by a periodic poller that scrapes thread replies. */
export const REFUTATION_PHRASES: ReadonlyArray<RegExp> = [
  /\bnot (a |an )?real (issue|bug)\b/i,
  /\bfalse positive\b/i,
  /\bthis is intentional\b/i,
  /\bworks as designed\b/i,
  /\bwon'?t fix\b/i,
  /@abid (mute|ignore|skip)\b/i,
];

export function looksLikeRefutation(text: string): boolean {
  return REFUTATION_PHRASES.some((re) => re.test(text));
}
