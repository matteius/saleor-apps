/*
 * T14 — Claims-mapping projector.
 *
 * Pure deterministic translation from a Fief user-claims bag to Saleor's split
 * metadata buckets. The Fief→Saleor sync handlers (T22-T29) and the
 * reconciliation job (T30-T32) call this once per user and compare the output
 * to what's already stored in Saleor; only deltas are written.
 *
 * Saleor terminology (which this module follows):
 *   - `metadata`        — public, returned from the storefront API.
 *   - `privateMetadata` — server-only, gated behind the `MANAGE_USERS` perm.
 *
 * Per PRD §F3.3 (and the T43 ADR), removing a mapping does NOT delete
 * previously-written Saleor metadata. The projector implements this by
 * simply omitting absent claims from the output — the caller never receives
 * a delete instruction, so previously-written values stay in place.
 *
 * The function is pure (no I/O, no global state) and deterministic: the same
 * `(mapping, claims)` input always produces the same output, regardless of
 * insertion order of object keys in the claims bag. This is necessary because
 * the diff-against-Saleor optimization in the sync handlers depends on stable
 * string equality between projector runs.
 */

/*
 * The shape of a single mapping entry as consumed by the projector.
 *
 * NOTE: this is structurally a subset of T8's `ClaimMappingEntry` (which
 * currently exports `{ fiefClaim, saleorMetadataKey, required }`). The PRD
 * §F3.1 calls for a `visibility: "public" | "private"` field on the entry; T8
 * is expected to add it (tracked under T36's reverse-sync future-additions).
 * Until then, the projector defines its own input contract — callers map
 * the persisted entry onto this shape at the boundary. This keeps T14
 * decoupled from the in-flight T8 schema migration without forcing a
 * cross-task edit.
 */
export interface ClaimMappingProjectionEntry {
  fiefClaim: string;
  saleorMetadataKey: string;
  visibility: "public" | "private";
}

export interface ProjectedSaleorMetadata {
  /** Public bucket. Storefront-visible. */
  metadata: Record<string, string>;
  /** Server-only bucket. Gated behind the `MANAGE_USERS` permission. */
  privateMetadata: Record<string, string>;
}

/**
 * Project a Fief claims bag into the Saleor metadata buckets per the supplied
 * mapping rules.
 *
 * Skipped (i.e. NOT written to either bucket):
 *   - Claim is absent from `fiefUserClaims` (`undefined`).
 *   - Claim value is `null`. We treat `null` as "no value" rather than
 *     serializing the literal string "null" — operators expressed surprise
 *     in the PRD review when JSON `null` round-tripped to a metadata cell.
 *
 * Stringification:
 *   - Primitives (`string` | `number` | `boolean` | `bigint`): `String(v)`.
 *     Numbers print in their decimal form; booleans as "true" / "false".
 *   - `undefined` and `null`: skipped (see above).
 *   - Objects/arrays: stable JSON. Object keys are sorted lexicographically
 *     at every nesting level; array order is preserved. The result is byte-
 *     stable across runs regardless of original key insertion order, which
 *     is what makes the diff-against-Saleor optimization possible.
 */
export const projectClaimsToSaleorMetadata = (
  mapping: readonly ClaimMappingProjectionEntry[],
  fiefUserClaims: Record<string, unknown>,
): ProjectedSaleorMetadata => {
  const metadata: Record<string, string> = {};
  const privateMetadata: Record<string, string> = {};

  for (const entry of mapping) {
    const raw = fiefUserClaims[entry.fiefClaim];

    if (raw === undefined || raw === null) {
      /*
       * PRD §F3.3 alignment: omit absent claims so the caller never sends a
       * delete instruction for a missing/removed mapping value. See module
       * docblock for why "null" is treated as absent.
       */
      continue;
    }

    const stringified = stringifyClaim(raw);

    /*
     * Last-write semantics for duplicate `saleorMetadataKey` within the same
     * bucket. The UI (T36) is expected to prevent duplicates; pinned in tests.
     */
    if (entry.visibility === "public") {
      metadata[entry.saleorMetadataKey] = stringified;
    } else {
      privateMetadata[entry.saleorMetadataKey] = stringified;
    }
  }

  return { metadata, privateMetadata };
};

/*
 * Stringify a single claim value into the form Saleor metadata wants
 * (a single string per cell). Stable for objects/arrays.
 */
const stringifyClaim = (value: unknown): string => {
  switch (typeof value) {
    case "string":
      return value;
    case "number":
    case "boolean":
    case "bigint":
      return String(value);
    case "object":
      /*
       * `null` is filtered upstream; everything else here is array-or-object
       * (Date, Map, Set, etc. are out-of-spec for Fief claims — JSON.stringify
       * will produce "{}" or coerce to ISO-string for Date, which is the
       * documented browser default). If callers ship richer values we can
       * tighten the contract later.
       */
      return stableJsonStringify(value);
    default:
      /*
       * `undefined`, `function`, `symbol` — none of these are representable
       * OIDC claim shapes (claims are JSON-typed). Keep the function total
       * by falling back to `String(...)` — `"undefined"` etc. — but this
       * branch should be unreachable in practice given the upstream guard.
       */
      return String(value);
  }
};

/*
 * Stable JSON serializer. Recursively walks the value, sorting object keys
 * lexicographically at every level while preserving array order.
 *
 * Why not use `safe-stable-stringify`: it's a fine package but adds a runtime
 * dep for ~30 lines of behavior that's easy to inline and audit. If we later
 * need cycle detection, BigInt-safe handling, or custom sort comparators,
 * we can swap in the package without changing the projector's external API.
 *
 * Cycles will throw (matches `JSON.stringify` semantics). Fief claims are
 * delivered as JSON over HTTP so they cannot be cyclic in practice.
 */
const stableJsonStringify = (value: unknown): string => {
  return JSON.stringify(canonicalize(value));
};

const canonicalize = (value: unknown): unknown => {
  if (value === null || typeof value !== "object") {
    return value;
  }

  if (Array.isArray(value)) {
    return value.map(canonicalize);
  }

  const sortedEntries = Object.keys(value as Record<string, unknown>)
    .sort()
    .map((key) => [key, canonicalize((value as Record<string, unknown>)[key])] as const);

  return Object.fromEntries(sortedEntries);
};
