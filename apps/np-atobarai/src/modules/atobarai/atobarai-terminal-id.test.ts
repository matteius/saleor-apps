import { describe, expect, it } from "vitest";

import { type AtobaraiTerminalId, createAtobaraiTerminalId } from "./atobarai-terminal-id";

describe("createAtobaraiTerminalId", () => {
  it("should create a valid AtobaraiTerminalId from a non-empty string", () => {
    const result = createAtobaraiTerminalId("TERMINAL_ID");

    expect(result).toBe("TERMINAL_ID");
  });

  it("should throw validation error when input is an empty string", () => {
    expect(() => createAtobaraiTerminalId("")).toThrowErrorMatchingInlineSnapshot(
      `
      [AtobaraiTerminalIdValidationError: [
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
      Invalid terminal ID: Validation error: Too small: expected string to have >=1 characters]
    `,
    );
  });

  it("shouldn't be assignable without createAtobaraiTerminalId", () => {
    // @ts-expect-error - if this fails - it means the type is not branded
    const testValue: AtobaraiTerminalId = "";

    expect(testValue).toBe("");
  });
});
