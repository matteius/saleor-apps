/**
 * Exponential backoff schedule for the failed-mint DLQ retry sweeper (T32).
 *
 * Indexed by `attemptCount - 1`:
 *   attemptCount=1 → wait 5 min before next attempt
 *   attemptCount=2 → wait 30 min
 *   attemptCount=3 → wait 4 hr
 *   attemptCount=4 → wait 24 hr (last retry; if THIS attempt also fails, no
 *                                further automatic retry — the entry is
 *                                flagged via markFinalFailure and Sentry pages
 *                                on-call at fatal level)
 *
 * Total worst-case time to escalate ≈ 28h45m, which gives the on-call team
 * enough sleep that the page lands during waking hours regardless of when the
 * initial failure occurred.
 *
 * The schedule is intentionally exposed as a plain array (rather than a class
 * with an `attemptDelay()` method) so unit tests can assert against the exact
 * values without re-implementing the formula.
 */
export const DLQ_BACKOFF_SECONDS = [
  5 * 60, // 5 min after 1st failure
  30 * 60, // 30 min after 2nd
  4 * 60 * 60, // 4 hr after 3rd
  24 * 60 * 60, // 24 hr after 4th (then alert + stop)
];

export const MAX_DLQ_ATTEMPTS = 4;

/**
 * Compute the unix-seconds timestamp at which the next retry should be
 * scheduled, given the *current* attempt count (i.e. the count after the
 * failure being recorded).
 *
 * Example: caller just observed the 1st mint failure → `attemptCount=1` →
 * returns `nowUnixSeconds + 5*60`.
 *
 * Returns `null` if `attemptCount >= MAX_DLQ_ATTEMPTS` — caller should call
 * `dlqRepo.markFinalFailure(...)` and fire a Sentry alert instead.
 */
export function computeNextRetryAt(attemptCount: number, nowUnixSeconds: number): number | null {
  if (attemptCount >= MAX_DLQ_ATTEMPTS) {
    return null;
  }

  const delay = DLQ_BACKOFF_SECONDS[attemptCount - 1];

  if (delay === undefined) {
    return null;
  }

  return nowUnixSeconds + delay;
}
