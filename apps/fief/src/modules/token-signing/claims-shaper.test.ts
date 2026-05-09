import { describe, expect, it } from "vitest";

import { type ClaimMappingProjectionEntry } from "@/modules/claims-mapping/projector";

import { shapeUserClaimsForSaleorPlugin } from "./claims-shaper";

/*
 * T55 — Tests for the claims-shaping helper.
 *
 * Per the T2 spike, Saleor signs all access/refresh tokens internally
 * (`saleor/core/jwt_manager.py`). The Saleor `BasePlugin` (T57) calls
 * apps/fief over HTTPS for `external_obtain_access_tokens` (T19) and
 * `external_refresh` (T20), and apps/fief returns a user-claims payload
 * which the plugin then hands to Saleor's own `jwt_encode`.
 *
 * This helper is the single transformation point that:
 *   1. Projects Fief claims through the operator-configured `claimMapping`
 *      (T14) into Saleor's split metadata buckets.
 *   2. Merges those projected entries on top of whatever Saleor already
 *      has (Fief is the source of truth for mapped keys, so the projection
 *      WINS on key collisions — operator intent overrides whatever drifted
 *      onto the Saleor user previously).
 *   3. Normalizes optional name fields to `string | null` (Saleor's
 *      `_get_or_create_user` rejects `undefined`).
 *
 * The helper is pure — no I/O, no env, no globals — so the entire test
 * surface is plain table tests.
 */

const mapping = (
  fiefClaim: string,
  saleorMetadataKey: string,
  visibility: "public" | "private",
): ClaimMappingProjectionEntry & { required: boolean; reverseSyncEnabled: boolean } => ({
  fiefClaim,
  saleorMetadataKey,
  visibility,
  required: false,
  reverseSyncEnabled: false,
});

const baseSaleorCustomer = {
  id: "VXNlcjox",
  email: "user@example.com",
  firstName: "Ada",
  lastName: "Lovelace",
  isActive: true,
  metadata: {} as Record<string, string>,
  privateMetadata: {} as Record<string, string>,
};

describe("shapeUserClaimsForSaleorPlugin — round-trip shape", () => {
  it("returns the documented payload shape with all fields populated", () => {
    const result = shapeUserClaimsForSaleorPlugin({
      saleorCustomer: baseSaleorCustomer,
      fiefClaims: { plan: "pro" },
      claimMapping: [mapping("plan", "fief.plan", "public")],
    });

    /*
     * Lock the exact return shape — T19/T20 will JSON-serialize this and
     * the Saleor plugin (T57) consumes it positionally. Adding/removing a
     * field here is a wire-level breaking change that should fail loudly
     * in CI before it ships.
     */
    expect(result).toStrictEqual({
      id: "VXNlcjox",
      email: "user@example.com",
      firstName: "Ada",
      lastName: "Lovelace",
      isActive: true,
      metadata: { "fief.plan": "pro" },
      privateMetadata: {},
    });
  });

  it("returns the same key set even when the projection is empty", () => {
    const result = shapeUserClaimsForSaleorPlugin({
      saleorCustomer: baseSaleorCustomer,
      fiefClaims: {},
      claimMapping: [],
    });

    /*
     * T57 reads keys positionally; the helper must always emit all 7
     * top-level keys regardless of whether anything is mapped.
     */
    expect(Object.keys(result).sort()).toStrictEqual([
      "email",
      "firstName",
      "id",
      "isActive",
      "lastName",
      "metadata",
      "privateMetadata",
    ]);
  });
});

describe("shapeUserClaimsForSaleorPlugin — null/undefined name normalization", () => {
  it("normalizes undefined firstName to null", () => {
    const result = shapeUserClaimsForSaleorPlugin({
      saleorCustomer: { ...baseSaleorCustomer, firstName: undefined },
      fiefClaims: {},
      claimMapping: [],
    });

    expect(result.firstName).toBeNull();
    /*
     * Critical: the field MUST be present (as null), not omitted. Saleor's
     * `_get_or_create_user` distinguishes "missing field" (don't change)
     * from "explicit null" (clear) — the plugin contract requires explicit
     * presence so the user always reflects the latest claims state.
     */
    expect("firstName" in result).toBe(true);
  });

  it("normalizes undefined lastName to null", () => {
    const result = shapeUserClaimsForSaleorPlugin({
      saleorCustomer: { ...baseSaleorCustomer, lastName: undefined },
      fiefClaims: {},
      claimMapping: [],
    });

    expect(result.lastName).toBeNull();
    expect("lastName" in result).toBe(true);
  });

  it("preserves an explicitly empty-string firstName/lastName (does NOT coerce '' → null)", () => {
    /*
     * Empty string is a real user-supplied value (some Saleor users have
     * blank names by intent). Normalizing "" → null would silently mutate
     * data on every refresh; pin the behavior.
     */
    const result = shapeUserClaimsForSaleorPlugin({
      saleorCustomer: { ...baseSaleorCustomer, firstName: "", lastName: "" },
      fiefClaims: {},
      claimMapping: [],
    });

    expect(result.firstName).toBe("");
    expect(result.lastName).toBe("");
  });

  it("never emits undefined for firstName or lastName", () => {
    const result = shapeUserClaimsForSaleorPlugin({
      saleorCustomer: {
        ...baseSaleorCustomer,
        firstName: undefined,
        lastName: undefined,
      },
      fiefClaims: {},
      claimMapping: [],
    });

    expect(result.firstName).not.toBeUndefined();
    expect(result.lastName).not.toBeUndefined();
  });
});

describe("shapeUserClaimsForSaleorPlugin — projection merging", () => {
  it("merges projected metadata entries into existing Saleor metadata", () => {
    const result = shapeUserClaimsForSaleorPlugin({
      saleorCustomer: {
        ...baseSaleorCustomer,
        metadata: { "saleor.preexisting": "keep-me" },
      },
      fiefClaims: { plan: "pro" },
      claimMapping: [mapping("plan", "fief.plan", "public")],
    });

    expect(result.metadata).toStrictEqual({
      "saleor.preexisting": "keep-me",
      "fief.plan": "pro",
    });
  });

  it("merges projected privateMetadata entries into existing Saleor privateMetadata", () => {
    const result = shapeUserClaimsForSaleorPlugin({
      saleorCustomer: {
        ...baseSaleorCustomer,
        privateMetadata: { "saleor.internal": "stays" },
      },
      fiefClaims: { tenant_id: "acme" },
      claimMapping: [mapping("tenant_id", "fief.tenant_id", "private")],
    });

    expect(result.privateMetadata).toStrictEqual({
      "saleor.internal": "stays",
      "fief.tenant_id": "acme",
    });
  });

  it("Fief claim WINS on metadata key collision (projection takes precedence)", () => {
    /*
     * Per the task contract: the operator-configured mapping is the
     * source of truth for any key it owns. If Saleor metadata holds a
     * stale value at the same key (because an admin edited it manually,
     * or a previous mapping wrote a different value), the fresh Fief
     * projection MUST overwrite it on every auth round-trip.
     */
    const result = shapeUserClaimsForSaleorPlugin({
      saleorCustomer: {
        ...baseSaleorCustomer,
        metadata: { "fief.plan": "free" },
      },
      fiefClaims: { plan: "pro" },
      claimMapping: [mapping("plan", "fief.plan", "public")],
    });

    expect(result.metadata).toStrictEqual({ "fief.plan": "pro" });
  });

  it("Fief claim WINS on privateMetadata key collision", () => {
    const result = shapeUserClaimsForSaleorPlugin({
      saleorCustomer: {
        ...baseSaleorCustomer,
        privateMetadata: { "fief.tenant_id": "stale" },
      },
      fiefClaims: { tenant_id: "current" },
      claimMapping: [mapping("tenant_id", "fief.tenant_id", "private")],
    });

    expect(result.privateMetadata).toStrictEqual({ "fief.tenant_id": "current" });
  });

  it("does NOT touch a key in the OPPOSITE bucket from the mapping", () => {
    /*
     * Visibility-routing isolation: a public mapping must not collide
     * with a same-keyed entry in the private bucket and vice-versa.
     */
    const result = shapeUserClaimsForSaleorPlugin({
      saleorCustomer: {
        ...baseSaleorCustomer,
        privateMetadata: { "fief.plan": "private-side-untouched" },
      },
      fiefClaims: { plan: "pro" },
      claimMapping: [mapping("plan", "fief.plan", "public")],
    });

    expect(result.metadata).toStrictEqual({ "fief.plan": "pro" });
    expect(result.privateMetadata).toStrictEqual({ "fief.plan": "private-side-untouched" });
  });
});

describe("shapeUserClaimsForSaleorPlugin — empty mapping leaves metadata untouched", () => {
  it("returns Saleor metadata verbatim when the mapping is empty", () => {
    const saleorMetadata = {
      "saleor.something": "value-1",
      "saleor.another": "value-2",
    };
    const saleorPrivateMetadata = { "saleor.internal": "value-3" };

    const result = shapeUserClaimsForSaleorPlugin({
      saleorCustomer: {
        ...baseSaleorCustomer,
        metadata: saleorMetadata,
        privateMetadata: saleorPrivateMetadata,
      },
      fiefClaims: { plan: "pro", anything: "else" },
      claimMapping: [],
    });

    expect(result.metadata).toStrictEqual(saleorMetadata);
    expect(result.privateMetadata).toStrictEqual(saleorPrivateMetadata);
  });

  it("ignores Fief claims that have no mapping entry", () => {
    const result = shapeUserClaimsForSaleorPlugin({
      saleorCustomer: baseSaleorCustomer,
      fiefClaims: { unmapped_one: "x", unmapped_two: 42 },
      claimMapping: [mapping("plan", "fief.plan", "public")],
    });

    expect(result.metadata).toStrictEqual({});
    expect(result.privateMetadata).toStrictEqual({});
  });

  it("does not mutate the input metadata objects", () => {
    /*
     * Helper is pure — caller-provided metadata buckets must stay
     * unmodified after the call. This matters because T19/T20 read
     * the same Saleor customer object both before and after shaping
     * (e.g. for diff-against-Saleor optimization in the sync path).
     */
    const inputMetadata = { "saleor.preexisting": "keep" };
    const inputPrivate = { "saleor.internal": "stays" };

    shapeUserClaimsForSaleorPlugin({
      saleorCustomer: {
        ...baseSaleorCustomer,
        metadata: inputMetadata,
        privateMetadata: inputPrivate,
      },
      fiefClaims: { plan: "pro" },
      claimMapping: [mapping("plan", "fief.plan", "public")],
    });

    expect(inputMetadata).toStrictEqual({ "saleor.preexisting": "keep" });
    expect(inputPrivate).toStrictEqual({ "saleor.internal": "stays" });
  });
});

describe("shapeUserClaimsForSaleorPlugin — isActive passthrough", () => {
  it("honors isActive: false (Saleor will gate login on this)", () => {
    const result = shapeUserClaimsForSaleorPlugin({
      saleorCustomer: { ...baseSaleorCustomer, isActive: false },
      fiefClaims: {},
      claimMapping: [],
    });

    expect(result.isActive).toBe(false);
  });

  it("honors isActive: true", () => {
    const result = shapeUserClaimsForSaleorPlugin({
      saleorCustomer: { ...baseSaleorCustomer, isActive: true },
      fiefClaims: {},
      claimMapping: [],
    });

    expect(result.isActive).toBe(true);
  });
});

describe("shapeUserClaimsForSaleorPlugin — multi-claim integration", () => {
  it("projects multiple mappings across both visibility buckets in one pass", () => {
    const result = shapeUserClaimsForSaleorPlugin({
      saleorCustomer: {
        ...baseSaleorCustomer,
        metadata: { "saleor.public.untouched": "still-here" },
        privateMetadata: { "saleor.private.untouched": "still-here-too" },
      },
      fiefClaims: {
        plan: "pro",
        tenant_id: "acme",
        seat_count: 42,
      },
      claimMapping: [
        mapping("plan", "fief.plan", "public"),
        mapping("tenant_id", "fief.tenant_id", "private"),
        mapping("seat_count", "fief.seat_count", "private"),
      ],
    });

    expect(result.metadata).toStrictEqual({
      "saleor.public.untouched": "still-here",
      "fief.plan": "pro",
    });
    expect(result.privateMetadata).toStrictEqual({
      "saleor.private.untouched": "still-here-too",
      "fief.tenant_id": "acme",
      "fief.seat_count": "42",
    });
  });
});
