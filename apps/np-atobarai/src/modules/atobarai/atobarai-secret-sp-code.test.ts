import { describe, expect, it } from "vitest";

import { type AtobaraiSecretSpCode, createAtobaraiSecretSpCode } from "./atobarai-secret-sp-code";

describe("createAtobaraiSecretSpCode", () => {
  it("should create a valid AtobaraiSpCode from a non-empty string", () => {
    const result = createAtobaraiSecretSpCode("SP_CODE");

    expect(result).toBe("SP_CODE");
  });

  it("should throw validation error when input is an empty string", () => {
    expect(() => createAtobaraiSecretSpCode("")).toThrowErrorMatchingInlineSnapshot(
      `
      [AtobaraiSecretSpCodeValidationError: [
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
      Invalid secret SP code: Validation error: Too small: expected string to have >=1 characters]
    `,
    );
  });

  it("shouldn't be assignable without createAtobaraiSecretSpCode", () => {
    // @ts-expect-error - if this fails - it means the type is not branded
    const testValue: AtobaraiSecretSpCode = "";

    expect(testValue).toBe("");
  });
});
