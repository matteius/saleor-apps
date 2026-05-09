import type { SyncSeq } from "@/modules/identity-map/identity-map";

/*
 * T13 — Loop-guard module: origin marker + monotonic sequence.
 *
 * Sole purpose: prevent the natural infinite loop between Saleor and Fief
 * when each side mirrors writes to the other. Every sync handler (T19,
 * T23, T26-T29) calls `tagWrite(...)` before writing OUT, and calls
 * `shouldSkip(...)` before writing IN. PRD §F2.8 / §F2.9.
 *
 * The guard combines two independent decisions:
 *
 *   (a) Origin marker — if the side that ORIGINATED the event is the same
 *       side we're about to WRITE INTO, this is a feedback echo. Drop it.
 *
 *   (b) Monotonic seq — every outbound write carries a `SyncSeq` (branded
 *       non-negative integer) per `(saleorApiUrl, fiefUserId)`. If the
 *       incoming seq is `<= lastSeenSeq`, the write has already been
 *       applied (or a newer one has) — drop it.
 *
 * Pure module by design. NO I/O, NO deps beyond the SyncSeq brand. The
 * tagged metadata round-trips through Saleor's `metadata` /
 * `privateMetadata` fields and through Fief user metadata, so the values
 * MUST be `string` (per Saleor's `Record<string, string>` constraint).
 *
 * Missing-field semantics (legacy / untagged events):
 *   - Missing origin: do NOT skip on origin alone. Fall through to seq.
 *   - Missing seq: do NOT skip on seq alone. Fall through to origin.
 *   - Both missing: proceed (false). Untagged event → no info to drop on.
 */

export const FIEF_SYNC_ORIGIN_KEY = "fief_sync_origin";
export const FIEF_SYNC_SEQ_KEY = "fief_sync_seq";

export type SyncOrigin = "fief" | "saleor";

export interface IncomingSyncMarker {
  origin?: SyncOrigin;
  seq?: SyncSeq;
}

export interface TaggedWrite {
  metadata: Record<string, string>;
  privateMetadata: Record<string, string>;
}

/**
 * Build the metadata payload for an outbound write.
 *
 * `targetSide` is the side we're writing INTO — it identifies who SHOULD
 * later see this marker echoed back and drop it. (E.g. when T23 writes a
 * Saleor customer in response to a Fief webhook, `targetSide = "fief"` —
 * because the Fief-side handler T26 must drop the Saleor echo.)
 *
 * `currentSeq` must be the freshly-bumped seq from the identity-map repo
 * (T10 enforces monotonicity at the storage layer).
 *
 * The origin lives in PUBLIC metadata so cross-side handlers that only
 * have read access to public fields can still see it. The seq lives in
 * PRIVATE metadata because clients have no business reading our internal
 * sync sequence numbers.
 */
export const tagWrite = (targetSide: SyncOrigin, currentSeq: SyncSeq): TaggedWrite => ({
  metadata: {
    [FIEF_SYNC_ORIGIN_KEY]: targetSide,
  },
  privateMetadata: {
    [FIEF_SYNC_SEQ_KEY]: String(currentSeq),
  },
});

export interface ShouldSkipInput {
  /**
   * The marker extracted from the incoming event (origin + seq). Either
   * field may be undefined if the event was untagged (legacy / external).
   */
  incomingMarker: IncomingSyncMarker;
  /** The side we're about to WRITE INTO. */
  processingSide: SyncOrigin;
  /** The largest seq already persisted for this `(saleorApiUrl, fiefUserId)`. */
  lastSeenSeq: SyncSeq;
}

/**
 * Decide whether to drop this incoming sync event.
 *
 * Returns `true` (skip) if either:
 *   (a) `incomingMarker.origin === processingSide` — feedback loop, OR
 *   (b) `incomingMarker.seq` is defined AND `incomingMarker.seq <= lastSeenSeq`
 *       — out-of-order or duplicate.
 *
 * Otherwise `false` (proceed).
 */
export const shouldSkip = ({
  incomingMarker,
  processingSide,
  lastSeenSeq,
}: ShouldSkipInput): boolean => {
  if (incomingMarker.origin !== undefined && incomingMarker.origin === processingSide) {
    return true;
  }

  if (incomingMarker.seq !== undefined && incomingMarker.seq <= lastSeenSeq) {
    return true;
  }

  return false;
};
