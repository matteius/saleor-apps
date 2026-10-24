import { describe, expect, it } from "vitest";

import {
  type AtobaraiShippingCompanyCode,
  createAtobaraiShippingCompanyCode,
} from "./atobarai-shipping-company-code";

describe("createAtobaraiShippingCompanyCode", () => {
  it("should create a valid AtobaraiShippingCompanyCode from a valid shipping company code", () => {
    const result = createAtobaraiShippingCompanyCode("50000");

    expect(result).toBe("50000");
  });

  it("should throw validation error when input is an invalid shipping company code", () => {
    expect(() => createAtobaraiShippingCompanyCode("99999")).toThrowErrorMatchingInlineSnapshot(
      `
      [AtobaraiShippingCompanyCodeValidationError: [
        {
          "code": "invalid_value",
          "values": [
            "50000",
            "55555",
            "59010",
            "59020",
            "59030",
            "59040",
            "59041",
            "59042",
            "59043",
            "59050",
            "59060",
            "59080",
            "59090",
            "59100",
            "59110",
            "59140",
            "59150",
            "59160"
          ],
          "path": [],
          "message": "Invalid option: expected one of \\"50000\\"|\\"55555\\"|\\"59010\\"|\\"59020\\"|\\"59030\\"|\\"59040\\"|\\"59041\\"|\\"59042\\"|\\"59043\\"|\\"59050\\"|\\"59060\\"|\\"59080\\"|\\"59090\\"|\\"59100\\"|\\"59110\\"|\\"59140\\"|\\"59150\\"|\\"59160\\""
        }
      ]
      ZodValidationError: Validation error: Invalid option: expected one of "50000"|"55555"|"59010"|"59020"|"59030"|"59040"|"59041"|"59042"|"59043"|"59050"|"59060"|"59080"|"59090"|"59100"|"59110"|"59140"|"59150"|"59160"
      Invalid shipping company code: Validation error: Invalid option: expected one of "50000"|"55555"|"59010"|"59020"|"59030"|"59040"|"59041"|"59042"|"59043"|"59050"|"59060"|"59080"|"59090"|"59100"|"59110"|"59140"|"59150"|"59160"]
    `,
    );
  });

  it("shouldn't be assignable without createAtobaraiShippingCompanyCode", () => {
    // @ts-expect-error - if this fails - it means the type is not branded
    const testValue: AtobaraiShippingCompanyCode = "50000";

    expect(testValue).toBe("50000");
  });
});
