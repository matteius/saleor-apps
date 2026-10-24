import { describe, expect, it } from "vitest";

import {
  type AtobaraiShopOrderDate,
  createAtobaraiShopOrderDate,
} from "./atobarai-shop-order-date";

describe("createAtobaraiShopOrderDate", () => {
  it("should create a valid AtobaraiShopOrderDate from a valid date string", () => {
    const result = createAtobaraiShopOrderDate("2025-07-08T00:00:00Z");

    expect(result).toBe("2025-07-08");
  });

  it("should throw validation error when input is an empty string", () => {
    expect(() => createAtobaraiShopOrderDate("")).toThrowErrorMatchingInlineSnapshot(
      `
      [AtobaraiShopOrderDateValidationError: [
        {
          "origin": "string",
          "code": "invalid_format",
          "format": "datetime",
          "pattern": "/^(?:(?:\\\\d\\\\d[2468][048]|\\\\d\\\\d[13579][26]|\\\\d\\\\d0[48]|[02468][048]00|[13579][26]00)-02-29|\\\\d{4}-(?:(?:0[13578]|1[02])-(?:0[1-9]|[12]\\\\d|3[01])|(?:0[469]|11)-(?:0[1-9]|[12]\\\\d|30)|(?:02)-(?:0[1-9]|1\\\\d|2[0-8])))T(?:(?:[01]\\\\d|2[0-3]):[0-5]\\\\d:[0-5]\\\\d(?:\\\\.\\\\d+)?(?:Z|([+-](?:[01]\\\\d|2[0-3]):[0-5]\\\\d)))$/",
          "path": [],
          "message": "Invalid ISO datetime"
        }
      ]
      ZodValidationError: Validation error: Invalid ISO datetime
      Invalid shop order date: Validation error: Invalid ISO datetime]
    `,
    );
  });

  it("shouldn't be assignable without createAtobaraiShopOrderDate", () => {
    // @ts-expect-error - if this fails - it means the type is not branded
    const testValue: AtobaraiShopOrderDate = "";

    expect(testValue).toBe("");
  });
});
