import { describe, expect, it } from "vitest";

import { type AtobaraiMerchantCode, createAtobaraiMerchantCode } from "./atobarai-merchant-code";

describe("createAtobaraiMerchantCode", () => {
  it("should create a valid AtobaraiMerchantCode from a non-empty string", () => {
    const result = createAtobaraiMerchantCode("MERCHANT123");

    expect(result).toBe("MERCHANT123");
  });

  it("should throw validation error when input is an empty string", () => {
    expect(() => createAtobaraiMerchantCode("")).toThrowErrorMatchingInlineSnapshot(
      `
      [AtobaraiMerchantCodeValidationError: [
        {
          "origin": "string",
          "code": "too_small",
          "minimum": 1,
          "inclusive": true,
          "path": [],
          "message": "Too small: expected string to have >=1 characters"
        }
      ]
      ZodValidationError: Validation error: Too small: expected string to have >=1 characters
      Invalid merchant code: Validation error: Too small: expected string to have >=1 characters]
    `,
    );
  });

  it("shouldn't be assignable without createAtobaraiMerchantCode", () => {
    // @ts-expect-error - if this fails - it means the type is not branded
    const testValue: AtobaraiMerchantCode = "";

    expect(testValue).toBe("");
  });
});
