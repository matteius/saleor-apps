import { describe, expect, it } from "vitest";

/*
 * T10 — Domain entity unit tests.
 *
 * Exercises:
 *   - Branded primitive parsers (`createSaleorUserId`, `createSyncSeq`) reject
 *     malformed input via Result<E>.
 *   - `IdentityMapRowSchema` validates the persisted shape.
 *   - The branded types are nominal — a SyncSeq is not assignable to a
 *     SaleorUserId at the type level (compile-time only; we keep one runtime
 *     check on the schemas to ensure the brands aren't confused at the
 *     value layer either).
 */

describe("identity-map domain entity", () => {
  it("createSaleorUserId accepts a non-empty string and brands it", async () => {
    const { createSaleorUserId } = await import("./identity-map");

    const result = createSaleorUserId("VXNlcjox");

    expect(result.isOk()).toBe(true);
    expect(result._unsafeUnwrap()).toBe("VXNlcjox");
  });

  it("createSaleorUserId rejects empty string", async () => {
    const { createSaleorUserId, IdentityMapValidationError } = await import("./identity-map");

    const result = createSaleorUserId("");

    expect(result.isErr()).toBe(true);
    expect(result._unsafeUnwrapErr()).toBeInstanceOf(IdentityMapValidationError);
  });

  it("createSyncSeq accepts a non-negative integer", async () => {
    const { createSyncSeq } = await import("./identity-map");

    expect(createSyncSeq(0)._unsafeUnwrap()).toBe(0);
    expect(createSyncSeq(1)._unsafeUnwrap()).toBe(1);
    expect(createSyncSeq(2_000_000_000)._unsafeUnwrap()).toBe(2_000_000_000);
  });

  it("createSyncSeq rejects negative or non-integer values", async () => {
    const { createSyncSeq, IdentityMapValidationError } = await import("./identity-map");

    expect(createSyncSeq(-1).isErr()).toBe(true);
    expect(createSyncSeq(1.5).isErr()).toBe(true);
    expect(createSyncSeq(Number.NaN).isErr()).toBe(true);
    expect(createSyncSeq(-1)._unsafeUnwrapErr()).toBeInstanceOf(IdentityMapValidationError);
  });

  it("IdentityMapRowSchema parses a well-formed row", async () => {
    const { IdentityMapRowSchema } = await import("./identity-map");

    const parsed = IdentityMapRowSchema.parse({
      saleorApiUrl: "https://shop-1.saleor.cloud/graphql/",
      saleorUserId: "VXNlcjox",
      fiefUserId: "11111111-1111-4111-8111-111111111111",
      lastSyncSeq: 42,
      lastSyncedAt: new Date("2026-05-09T12:00:00Z"),
    });

    expect(parsed.saleorUserId).toBe("VXNlcjox");
    expect(parsed.fiefUserId).toBe("11111111-1111-4111-8111-111111111111");
    expect(parsed.lastSyncSeq).toBe(42);
    expect(parsed.lastSyncedAt).toBeInstanceOf(Date);
  });

  it("IdentityMapRowSchema rejects rows missing required fields", async () => {
    const { IdentityMapRowSchema } = await import("./identity-map");

    expect(() =>
      IdentityMapRowSchema.parse({
        saleorApiUrl: "https://shop-1.saleor.cloud/graphql/",
        saleorUserId: "VXNlcjox",
        // fiefUserId missing
        lastSyncSeq: 42,
        lastSyncedAt: new Date(),
      }),
    ).toThrow();
  });

  it("IdentityMapRowSchema rejects negative lastSyncSeq", async () => {
    const { IdentityMapRowSchema } = await import("./identity-map");

    expect(() =>
      IdentityMapRowSchema.parse({
        saleorApiUrl: "https://shop-1.saleor.cloud/graphql/",
        saleorUserId: "VXNlcjox",
        fiefUserId: "11111111-1111-4111-8111-111111111111",
        lastSyncSeq: -1,
        lastSyncedAt: new Date(),
      }),
    ).toThrow();
  });
});
