import { describe, expect, it } from "vitest";

import { createSyncSeq, type SyncSeq } from "@/modules/identity-map/identity-map";

import {
  FIEF_SYNC_ORIGIN_KEY,
  FIEF_SYNC_SEQ_KEY,
  shouldSkip,
  type SyncOrigin,
  tagWrite,
} from "./loop-guard";

/*
 * T13 — Loop-guard module unit tests.
 *
 * This module is the canary against infinite sync loops in production
 * (PRD §F2.8 / §F2.9). The tests below exhaustively cover every branch
 * because every sync handler depends on the exactness of these decisions.
 *
 * Coverage:
 *   - Constants: exact string values exported (T23-T29 import them).
 *   - tagWrite: produces metadata + privateMetadata containing the right
 *     keys on the right surface.
 *   - shouldSkip 4×3 matrix:
 *       4 origin combos: incoming {fief|saleor} × processing {fief|saleor}
 *       3 seq orderings: incoming < lastSeen, incoming === lastSeen, incoming > lastSeen
 *   - "this would have looped" explicit case (incoming origin === processing
 *     side, fresh seq) — must skip (true).
 *   - Missing/undefined incoming origin: do NOT skip on origin alone — fall
 *     through to the seq check.
 *   - Missing/undefined incoming seq with non-loop origin: do NOT skip
 *     (allow the write).
 *   - Round-trip: tagWrite produces a marker readable by shouldSkip.
 */

const seq = (n: number): SyncSeq => createSyncSeq(n)._unsafeUnwrap();

describe("loop-guard constants", () => {
  it("exports FIEF_SYNC_ORIGIN_KEY with the exact metadata key string", () => {
    expect(FIEF_SYNC_ORIGIN_KEY).toBe("fief_sync_origin");
  });

  it("exports FIEF_SYNC_SEQ_KEY with the exact private-metadata key string", () => {
    expect(FIEF_SYNC_SEQ_KEY).toBe("fief_sync_seq");
  });
});

describe("tagWrite", () => {
  it("places origin under metadata (public) keyed by FIEF_SYNC_ORIGIN_KEY for targetSide=fief", () => {
    const result = tagWrite("fief", seq(1));

    expect(result.metadata).toStrictEqual({ [FIEF_SYNC_ORIGIN_KEY]: "fief" });
  });

  it("places origin under metadata (public) keyed by FIEF_SYNC_ORIGIN_KEY for targetSide=saleor", () => {
    const result = tagWrite("saleor", seq(1));

    expect(result.metadata).toStrictEqual({ [FIEF_SYNC_ORIGIN_KEY]: "saleor" });
  });

  it("places seq under privateMetadata keyed by FIEF_SYNC_SEQ_KEY (stringified)", () => {
    const result = tagWrite("fief", seq(42));

    expect(result.privateMetadata).toStrictEqual({ [FIEF_SYNC_SEQ_KEY]: "42" });
  });

  it("stringifies seq=0 as the literal '0' (not falsy-stripped)", () => {
    const result = tagWrite("saleor", seq(0));

    expect(result.privateMetadata[FIEF_SYNC_SEQ_KEY]).toBe("0");
  });

  it("returns Record<string,string> values only (Saleor metadata constraint)", () => {
    const result = tagWrite("fief", seq(7));

    for (const v of Object.values(result.metadata)) {
      expect(typeof v).toBe("string");
    }
    for (const v of Object.values(result.privateMetadata)) {
      expect(typeof v).toBe("string");
    }
  });

  it("does not put the origin key in privateMetadata or the seq key in metadata", () => {
    const result = tagWrite("fief", seq(3));

    expect(result.privateMetadata[FIEF_SYNC_ORIGIN_KEY]).toBeUndefined();
    expect(result.metadata[FIEF_SYNC_SEQ_KEY]).toBeUndefined();
  });
});

describe("shouldSkip — origin × seq matrix", () => {
  /*
   * 4 origin combos × 3 seq orderings = 12 cells. Each cell asserts the
   * loop-guard decision. We use lastSeen=10 and walk the incoming seq
   * across {5 (older), 10 (equal), 15 (newer)}.
   */
  const lastSeen = seq(10);
  const older = seq(5);
  const equal = seq(10);
  const newer = seq(15);

  describe("incoming=fief × processing=fief (LOOP)", () => {
    const processing: SyncOrigin = "fief";
    const origin: SyncOrigin = "fief";

    it("older seq → skip (loop trumps)", () => {
      expect(
        shouldSkip({
          incomingMarker: { origin, seq: older },
          processingSide: processing,
          lastSeenSeq: lastSeen,
        }),
      ).toBe(true);
    });
    it("equal seq → skip (loop trumps)", () => {
      expect(
        shouldSkip({
          incomingMarker: { origin, seq: equal },
          processingSide: processing,
          lastSeenSeq: lastSeen,
        }),
      ).toBe(true);
    });
    it("newer seq → skip (loop wins even with fresh seq)", () => {
      expect(
        shouldSkip({
          incomingMarker: { origin, seq: newer },
          processingSide: processing,
          lastSeenSeq: lastSeen,
        }),
      ).toBe(true);
    });
  });

  describe("incoming=saleor × processing=saleor (LOOP)", () => {
    const processing: SyncOrigin = "saleor";
    const origin: SyncOrigin = "saleor";

    it("older seq → skip", () => {
      expect(
        shouldSkip({
          incomingMarker: { origin, seq: older },
          processingSide: processing,
          lastSeenSeq: lastSeen,
        }),
      ).toBe(true);
    });
    it("equal seq → skip", () => {
      expect(
        shouldSkip({
          incomingMarker: { origin, seq: equal },
          processingSide: processing,
          lastSeenSeq: lastSeen,
        }),
      ).toBe(true);
    });
    it("newer seq → skip (loop wins)", () => {
      expect(
        shouldSkip({
          incomingMarker: { origin, seq: newer },
          processingSide: processing,
          lastSeenSeq: lastSeen,
        }),
      ).toBe(true);
    });
  });

  describe("incoming=fief × processing=saleor (no loop)", () => {
    const processing: SyncOrigin = "saleor";
    const origin: SyncOrigin = "fief";

    it("older seq → skip on out-of-order rule", () => {
      expect(
        shouldSkip({
          incomingMarker: { origin, seq: older },
          processingSide: processing,
          lastSeenSeq: lastSeen,
        }),
      ).toBe(true);
    });
    it("equal seq → skip on out-of-order rule (already processed)", () => {
      expect(
        shouldSkip({
          incomingMarker: { origin, seq: equal },
          processingSide: processing,
          lastSeenSeq: lastSeen,
        }),
      ).toBe(true);
    });
    it("newer seq → proceed (false)", () => {
      expect(
        shouldSkip({
          incomingMarker: { origin, seq: newer },
          processingSide: processing,
          lastSeenSeq: lastSeen,
        }),
      ).toBe(false);
    });
  });

  describe("incoming=saleor × processing=fief (no loop)", () => {
    const processing: SyncOrigin = "fief";
    const origin: SyncOrigin = "saleor";

    it("older seq → skip on out-of-order rule", () => {
      expect(
        shouldSkip({
          incomingMarker: { origin, seq: older },
          processingSide: processing,
          lastSeenSeq: lastSeen,
        }),
      ).toBe(true);
    });
    it("equal seq → skip on out-of-order rule", () => {
      expect(
        shouldSkip({
          incomingMarker: { origin, seq: equal },
          processingSide: processing,
          lastSeenSeq: lastSeen,
        }),
      ).toBe(true);
    });
    it("newer seq → proceed (false)", () => {
      expect(
        shouldSkip({
          incomingMarker: { origin, seq: newer },
          processingSide: processing,
          lastSeenSeq: lastSeen,
        }),
      ).toBe(false);
    });
  });
});

describe("shouldSkip — explicit 'this would have looped without the guard' case", () => {
  /*
   * Realistic scenario: T23 just wrote a customer to Saleor and tagged it
   * "fief" + seq=11. Saleor fires CUSTOMER_UPDATED. Our T26 handler picks
   * it up and is about to write back into Fief. The marker on the incoming
   * Saleor event shows origin=fief; processing side is "fief". Without the
   * guard this is a tight infinite loop. The seq is fresh (newer than what
   * we have) — we MUST still drop it.
   */
  it("incoming origin matches processing side and seq is strictly fresh → skip (true)", () => {
    const result = shouldSkip({
      incomingMarker: { origin: "fief", seq: seq(99) },
      processingSide: "fief",
      lastSeenSeq: seq(10),
    });

    expect(result).toBe(true);
  });

  it("symmetric saleor→saleor loop with fresh seq → skip (true)", () => {
    const result = shouldSkip({
      incomingMarker: { origin: "saleor", seq: seq(50) },
      processingSide: "saleor",
      lastSeenSeq: seq(10),
    });

    expect(result).toBe(true);
  });
});

describe("shouldSkip — missing fields", () => {
  it("missing incoming origin + fresh seq → proceed (false)", () => {
    /*
     * Legacy event with no origin marker. Don't drop on origin alone — fall
     * through to seq check. Seq is fresh, so the write proceeds.
     */
    const result = shouldSkip({
      incomingMarker: { seq: seq(20) },
      processingSide: "fief",
      lastSeenSeq: seq(10),
    });

    expect(result).toBe(false);
  });

  it("missing incoming origin + stale seq → skip (true) on seq rule", () => {
    const result = shouldSkip({
      incomingMarker: { seq: seq(5) },
      processingSide: "fief",
      lastSeenSeq: seq(10),
    });

    expect(result).toBe(true);
  });

  it("missing incoming origin + equal seq → skip (true) on seq rule", () => {
    const result = shouldSkip({
      incomingMarker: { seq: seq(10) },
      processingSide: "fief",
      lastSeenSeq: seq(10),
    });

    expect(result).toBe(true);
  });

  it("missing incoming seq + non-loop origin → proceed (false)", () => {
    /*
     * No seq to compare → cannot infer out-of-order. Origin doesn't loop.
     * Allow the write.
     */
    const result = shouldSkip({
      incomingMarker: { origin: "saleor" },
      processingSide: "fief",
      lastSeenSeq: seq(10),
    });

    expect(result).toBe(false);
  });

  it("missing incoming seq + loop origin → skip (true) on origin rule", () => {
    const result = shouldSkip({
      incomingMarker: { origin: "fief" },
      processingSide: "fief",
      lastSeenSeq: seq(10),
    });

    expect(result).toBe(true);
  });

  it("both incoming origin and seq missing → proceed (false)", () => {
    /* Fully legacy / untagged event. No information to drop on. Allow. */
    const result = shouldSkip({
      incomingMarker: {},
      processingSide: "fief",
      lastSeenSeq: seq(10),
    });

    expect(result).toBe(false);
  });

  it("lastSeenSeq=0 + missing incoming seq + non-loop origin → proceed (false)", () => {
    /* Boundary: cold start, lastSeenSeq is the brand's minimum (0). */
    const result = shouldSkip({
      incomingMarker: { origin: "saleor" },
      processingSide: "fief",
      lastSeenSeq: seq(0),
    });

    expect(result).toBe(false);
  });

  it("lastSeenSeq=0 + incoming seq=0 (non-loop) → skip (true) on equal-seq rule", () => {
    const result = shouldSkip({
      incomingMarker: { origin: "saleor", seq: seq(0) },
      processingSide: "fief",
      lastSeenSeq: seq(0),
    });

    expect(result).toBe(true);
  });
});

describe("tagWrite ↔ shouldSkip round-trip", () => {
  /*
   * tagWrite produces strings (metadata is always Record<string,string> on
   * the wire). When the marker comes back to us (either via Saleor's
   * customer.metadata or as an extracted Fief metadata field) and is
   * re-parsed into the {origin, seq} shape, shouldSkip must be able to use
   * it. We simulate the parse step here.
   */
  it("a tagWrite('fief', seq) marker drives shouldSkip to true when processingSide=fief", () => {
    const tag = tagWrite("fief", seq(7));

    const parsedOrigin = tag.metadata[FIEF_SYNC_ORIGIN_KEY] as SyncOrigin;
    const parsedSeq = seq(Number.parseInt(tag.privateMetadata[FIEF_SYNC_SEQ_KEY], 10));

    const result = shouldSkip({
      incomingMarker: { origin: parsedOrigin, seq: parsedSeq },
      processingSide: "fief",
      lastSeenSeq: seq(0),
    });

    expect(result).toBe(true);
  });

  it("a tagWrite('saleor', seq) marker drives shouldSkip to false when processingSide=fief and seq is fresh", () => {
    const tag = tagWrite("saleor", seq(7));

    const parsedOrigin = tag.metadata[FIEF_SYNC_ORIGIN_KEY] as SyncOrigin;
    const parsedSeq = seq(Number.parseInt(tag.privateMetadata[FIEF_SYNC_SEQ_KEY], 10));

    const result = shouldSkip({
      incomingMarker: { origin: parsedOrigin, seq: parsedSeq },
      processingSide: "fief",
      lastSeenSeq: seq(0),
    });

    expect(result).toBe(false);
  });

  it("round-trips the seq value exactly through string ⇄ number", () => {
    const tag = tagWrite("fief", seq(2_147_483_647));

    expect(tag.privateMetadata[FIEF_SYNC_SEQ_KEY]).toBe("2147483647");
  });
});
