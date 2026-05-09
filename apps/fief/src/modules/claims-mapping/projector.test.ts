import { describe, expect, it } from "vitest";

import { type ClaimMappingProjectionEntry, projectClaimsToSaleorMetadata } from "./projector";

/*
 * T14 — Pure-function tests for the claims-mapping projector.
 *
 * The projector is the single deterministic translation from a Fief user-claims
 * bag to Saleor's split metadata buckets (`metadata` is public/storefront-visible,
 * `privateMetadata` is server-only). It is consumed by the Fief→Saleor sync
 * handlers (T22-T29) and the reconciliation job (T30-T32). Because both call
 * sites compare the projected output to what's already stored in Saleor, the
 * function MUST be deterministic across runs — same input produces the same
 * string output regardless of object/array key insertion order.
 *
 * Per PRD §F3.3, removing a mapping does NOT delete previously-written
 * metadata. The projector models this by simply omitting absent claims from
 * the output; the caller is responsible for never issuing delete instructions
 * (T43 ADR captures the rationale).
 */

const mapping = (
  fiefClaim: string,
  saleorMetadataKey: string,
  visibility: "public" | "private",
): ClaimMappingProjectionEntry => ({ fiefClaim, saleorMetadataKey, visibility });

describe("projectClaimsToSaleorMetadata — visibility routing", () => {
  it("routes a public mapping to the metadata bucket", () => {
    const result = projectClaimsToSaleorMetadata([mapping("plan", "fief.plan", "public")], {
      plan: "pro",
    });

    expect(result.metadata).toStrictEqual({ "fief.plan": "pro" });
    expect(result.privateMetadata).toStrictEqual({});
  });

  it("routes a private mapping to the privateMetadata bucket", () => {
    const result = projectClaimsToSaleorMetadata(
      [mapping("entitlements", "fief.entitlements", "private")],
      { entitlements: ["read", "write"] },
    );

    expect(result.privateMetadata).toStrictEqual({ "fief.entitlements": '["read","write"]' });
    expect(result.metadata).toStrictEqual({});
  });

  it("handles a mix of public and private mappings in a single pass", () => {
    const result = projectClaimsToSaleorMetadata(
      [mapping("plan", "fief.plan", "public"), mapping("tenant_id", "fief.tenant_id", "private")],
      { plan: "pro", tenant_id: "acme" },
    );

    expect(result.metadata).toStrictEqual({ "fief.plan": "pro" });
    expect(result.privateMetadata).toStrictEqual({ "fief.tenant_id": "acme" });
  });
});

describe("projectClaimsToSaleorMetadata — missing-claim semantics", () => {
  it("skips an undefined claim (key absent from output)", () => {
    const result = projectClaimsToSaleorMetadata([mapping("plan", "fief.plan", "public")], {
      // plan is missing
    });

    expect(result.metadata).toStrictEqual({});
    expect(result.privateMetadata).toStrictEqual({});
    expect("fief.plan" in result.metadata).toBe(false);
  });

  it("skips a null claim value (does NOT write the literal string 'null')", () => {
    const result = projectClaimsToSaleorMetadata([mapping("plan", "fief.plan", "public")], {
      plan: null,
    });

    expect(result.metadata).toStrictEqual({});
    expect(result.privateMetadata).toStrictEqual({});
  });

  it("does not write empty-string sentinel for missing claims", () => {
    const result = projectClaimsToSaleorMetadata(
      [mapping("missing_one", "fief.missing", "private")],
      {},
    );

    expect(Object.keys(result.privateMetadata)).toHaveLength(0);
    expect(result.privateMetadata["fief.missing"]).toBeUndefined();
  });
});

describe("projectClaimsToSaleorMetadata — stable serialization", () => {
  it("stringifies primitive numbers as their decimal form", () => {
    const result = projectClaimsToSaleorMetadata(
      [mapping("seat_count", "fief.seat_count", "public")],
      { seat_count: 42 },
    );

    expect(result.metadata).toStrictEqual({ "fief.seat_count": "42" });
  });

  it("stringifies booleans as 'true' / 'false'", () => {
    const result = projectClaimsToSaleorMetadata(
      [
        mapping("trial_active", "fief.trial_active", "public"),
        mapping("is_admin", "fief.is_admin", "private"),
      ],
      { trial_active: true, is_admin: false },
    );

    expect(result.metadata).toStrictEqual({ "fief.trial_active": "true" });
    expect(result.privateMetadata).toStrictEqual({ "fief.is_admin": "false" });
  });

  it("serializes a nested object with stable key ordering", () => {
    const insertionOrderA: Record<string, unknown> = {};

    insertionOrderA.b = 1;
    insertionOrderA.a = 2;
    insertionOrderA.c = 3;

    const insertionOrderB: Record<string, unknown> = {};

    insertionOrderB.c = 3;
    insertionOrderB.a = 2;
    insertionOrderB.b = 1;

    const resultA = projectClaimsToSaleorMetadata([mapping("perms", "fief.perms", "private")], {
      perms: insertionOrderA,
    });
    const resultB = projectClaimsToSaleorMetadata([mapping("perms", "fief.perms", "private")], {
      perms: insertionOrderB,
    });

    expect(resultA.privateMetadata["fief.perms"]).toStrictEqual(
      resultB.privateMetadata["fief.perms"],
    );
    expect(resultA.privateMetadata["fief.perms"]).toStrictEqual('{"a":2,"b":1,"c":3}');
  });

  it("serializes deeply-nested objects with stable ordering at every level", () => {
    const claim = {
      z: { y: 1, x: 2 },
      a: { c: 3, b: 4 },
    };

    const result = projectClaimsToSaleorMetadata(
      [mapping("scope_tree", "fief.scope_tree", "private")],
      { scope_tree: claim },
    );

    expect(result.privateMetadata["fief.scope_tree"]).toStrictEqual(
      '{"a":{"b":4,"c":3},"z":{"x":2,"y":1}}',
    );
  });

  it("preserves array order (arrays are positional, not order-sorted)", () => {
    const result = projectClaimsToSaleorMetadata([mapping("roles", "fief.roles", "private")], {
      roles: ["editor", "admin", "viewer"],
    });

    expect(result.privateMetadata["fief.roles"]).toStrictEqual('["editor","admin","viewer"]');
  });

  it("serializes an array of primitives stably", () => {
    const result = projectClaimsToSaleorMetadata([mapping("scopes", "fief.scopes", "private")], {
      scopes: ["read:profile", "read:billing", "write:billing"],
    });

    expect(result.privateMetadata["fief.scopes"]).toStrictEqual(
      '["read:profile","read:billing","write:billing"]',
    );
  });

  it("serializes an array of objects with each object's keys stably ordered", () => {
    const result = projectClaimsToSaleorMetadata([mapping("groups", "fief.groups", "private")], {
      groups: [
        { name: "admins", level: 10 },
        { level: 5, name: "users" },
      ],
    });

    expect(result.privateMetadata["fief.groups"]).toStrictEqual(
      '[{"level":10,"name":"admins"},{"level":5,"name":"users"}]',
    );
  });
});

describe("projectClaimsToSaleorMetadata — removed-mapping semantics (PRD §F3.3)", () => {
  it("omits the removed mapping's key without producing a delete instruction", () => {
    const claims = { plan: "pro", entitlements: ["read", "write"] };

    const before = projectClaimsToSaleorMetadata(
      [
        mapping("plan", "fief.plan", "public"),
        mapping("entitlements", "fief.entitlements", "private"),
      ],
      claims,
    );

    expect(before.metadata).toStrictEqual({ "fief.plan": "pro" });
    expect(before.privateMetadata).toStrictEqual({ "fief.entitlements": '["read","write"]' });

    // Operator removes the entitlements mapping. Same claims, smaller mapping.
    const after = projectClaimsToSaleorMetadata([mapping("plan", "fief.plan", "public")], claims);

    /*
     * The removed mapping's key MUST be absent — NOT mapped to undefined or
     * null or empty string. The caller (sync handler) compares this output to
     * what's already in Saleor and only writes deltas; an absent key produces
     * no write, which means the previously-written value stays in place. This
     * is the literal expression of PRD §F3.3.
     */
    expect("fief.entitlements" in after.privateMetadata).toBe(false);
    expect(after.privateMetadata).toStrictEqual({});
    expect(after.metadata).toStrictEqual({ "fief.plan": "pro" });
  });
});

describe("projectClaimsToSaleorMetadata — output invariants", () => {
  it("returns disjoint metadata / privateMetadata objects (mutating one does not affect the other)", () => {
    const result = projectClaimsToSaleorMetadata(
      [mapping("plan", "fief.plan", "public"), mapping("tenant_id", "fief.tenant_id", "private")],
      { plan: "pro", tenant_id: "acme" },
    );

    expect(result.metadata).not.toBe(result.privateMetadata);
  });

  it("returns empty buckets when given an empty mapping array", () => {
    const result = projectClaimsToSaleorMetadata([], { plan: "pro", tenant_id: "acme" });

    expect(result.metadata).toStrictEqual({});
    expect(result.privateMetadata).toStrictEqual({});
  });

  it("returns empty buckets when given an empty claims bag", () => {
    const result = projectClaimsToSaleorMetadata([mapping("plan", "fief.plan", "public")], {});

    expect(result.metadata).toStrictEqual({});
    expect(result.privateMetadata).toStrictEqual({});
  });

  it("when two mappings target the same saleorMetadataKey within the same bucket, the later mapping wins (last-write semantics)", () => {
    /*
     * Documented determinism: input order defines projection order. UI (T36)
     * is responsible for preventing duplicate keys in the same bucket; this
     * test pins behavior so a future refactor can't silently change it.
     */
    const result = projectClaimsToSaleorMetadata(
      [mapping("plan_v1", "fief.plan", "public"), mapping("plan_v2", "fief.plan", "public")],
      { plan_v1: "old", plan_v2: "new" },
    );

    expect(result.metadata).toStrictEqual({ "fief.plan": "new" });
  });
});
