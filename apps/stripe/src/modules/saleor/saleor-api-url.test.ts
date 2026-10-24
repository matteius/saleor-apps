import { describe, expect, it } from "vitest";

import {
  createSaleorApiUrl,
  type SaleorApiUrl,
  SaleorApiUrlValidationError,
} from "./saleor-api-url";

describe("SaleorApiUrl", () => {
  describe("create", () => {
    it("should create valid URL with https", () => {
      const result = createSaleorApiUrl("https://demo.saleor.io/graphql/");

      expect(result.isOk()).toBe(true);
      expect(result._unsafeUnwrap()).toBe("https://demo.saleor.io/graphql/");
    });

    it("should create valid URL with http", () => {
      const result = createSaleorApiUrl("http://demo.saleor.io/graphql/");

      expect(result.isOk()).toBe(true);
      expect(result._unsafeUnwrap()).toBe("http://demo.saleor.io/graphql/");
    });

    it("should reject empty URL", () => {
      const result = createSaleorApiUrl("");

      expect(result.isErr()).toBe(true);
      expect(result._unsafeUnwrapErr()).toBeInstanceOf(SaleorApiUrlValidationError);
      expect(result._unsafeUnwrapErr()).toMatchInlineSnapshot(`
        [SaleorApiUrlValidationError: ZodError: [
          {
            "code": "invalid_format",
            "format": "url",
            "path": [],
            "message": "Invalid URL"
          },
          {
            "origin": "string",
            "code": "invalid_format",
            "format": "ends_with",
            "suffix": "/graphql/",
            "path": [],
            "message": "Invalid string: must end with \\"/graphql/\\""
          },
          {
            "code": "custom",
            "path": [],
            "message": "Invalid input: must start with \\"http://\\" or \\"https://\\""
          }
        ]]
      `);
    });

    it("should reject URL not starting with http/https", () => {
      const result = createSaleorApiUrl("ftp://demo.saleor.io/graphql/");

      expect(result.isErr()).toBe(true);
      expect(result._unsafeUnwrapErr()).toBeInstanceOf(SaleorApiUrlValidationError);
      expect(result._unsafeUnwrapErr()).toMatchInlineSnapshot(`
        [SaleorApiUrlValidationError: ZodError: [
          {
            "code": "custom",
            "path": [],
            "message": "Invalid input: must start with \\"http://\\" or \\"https://\\""
          }
        ]]
      `);
    });

    it("should reject URL not ending with /graphql/", () => {
      const result = createSaleorApiUrl("https://demo.saleor.io/");

      expect(result.isErr()).toBe(true);
      expect(result._unsafeUnwrapErr()).toBeInstanceOf(SaleorApiUrlValidationError);
      expect(result._unsafeUnwrapErr()).toMatchInlineSnapshot(`
        [SaleorApiUrlValidationError: ZodError: [
          {
            "origin": "string",
            "code": "invalid_format",
            "format": "ends_with",
            "suffix": "/graphql/",
            "path": [],
            "message": "Invalid string: must end with \\"/graphql/\\""
          }
        ]]
      `);
    });

    it("should reject incorrect URL", () => {
      const result = createSaleorApiUrl("demo.saleor.io/graphql/");

      expect(result.isErr()).toBe(true);
      expect(result._unsafeUnwrapErr()).toBeInstanceOf(SaleorApiUrlValidationError);
      expect(result._unsafeUnwrapErr()).toMatchInlineSnapshot(`
        [SaleorApiUrlValidationError: ZodError: [
          {
            "code": "invalid_format",
            "format": "url",
            "path": [],
            "message": "Invalid URL"
          },
          {
            "code": "custom",
            "path": [],
            "message": "Invalid input: must start with \\"http://\\" or \\"https://\\""
          }
        ]]
      `);
    });

    it("shouldn't be assignable without createSaleorApiUrl", () => {
      // @ts-expect-error - if this fails - it means the type is not branded
      const testValue: SaleorApiUrl = "";

      expect(testValue).toBe("");
    });
  });
});
