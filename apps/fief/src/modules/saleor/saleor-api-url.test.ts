import { describe, expect, it } from "vitest";

import {
  createSaleorApiUrl,
  type SaleorApiUrl,
  SaleorApiUrlValidationError,
} from "./saleor-api-url";

describe("SaleorApiUrl", () => {
  describe("createSaleorApiUrl", () => {
    it("accepts a valid https Saleor GraphQL URL", () => {
      const result = createSaleorApiUrl("https://demo.saleor.io/graphql/");

      expect(result.isOk()).toBe(true);
      expect(result._unsafeUnwrap()).toBe("https://demo.saleor.io/graphql/");
    });

    it("accepts a valid http Saleor GraphQL URL (local dev)", () => {
      const result = createSaleorApiUrl("http://localhost:8000/graphql/");

      expect(result.isOk()).toBe(true);
      expect(result._unsafeUnwrap()).toBe("http://localhost:8000/graphql/");
    });

    it("rejects an empty string", () => {
      const result = createSaleorApiUrl("");

      expect(result.isErr()).toBe(true);
      expect(result._unsafeUnwrapErr()).toBeInstanceOf(SaleorApiUrlValidationError);
    });

    it("rejects a URL with a non-http(s) scheme", () => {
      const result = createSaleorApiUrl("ftp://demo.saleor.io/graphql/");

      expect(result.isErr()).toBe(true);
      expect(result._unsafeUnwrapErr()).toBeInstanceOf(SaleorApiUrlValidationError);
    });

    it("rejects a URL not ending with /graphql/", () => {
      const result = createSaleorApiUrl("https://demo.saleor.io/");

      expect(result.isErr()).toBe(true);
      expect(result._unsafeUnwrapErr()).toBeInstanceOf(SaleorApiUrlValidationError);
    });

    it("rejects a missing-scheme URL string", () => {
      const result = createSaleorApiUrl("demo.saleor.io/graphql/");

      expect(result.isErr()).toBe(true);
      expect(result._unsafeUnwrapErr()).toBeInstanceOf(SaleorApiUrlValidationError);
    });

    it("brands the type so raw strings are not assignable", () => {
      // @ts-expect-error - if this fails - it means the type is not branded
      const testValue: SaleorApiUrl = "";

      expect(testValue).toBe("");
    });

    it("attaches the SaleorApiUrl.ValidationError brand on the error", () => {
      const result = createSaleorApiUrl("");

      expect(result.isErr()).toBe(true);

      const err = result._unsafeUnwrapErr();

      // `_brand` is set via BaseError.subclass props; verify the literal value.
      expect((err as unknown as { _brand: string })._brand).toBe("SaleorApiUrl.ValidationError");
    });
  });
});
