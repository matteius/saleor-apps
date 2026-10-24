import { describe, expect, it } from "vitest";

import { newConfigInputSchema } from "@/modules/app-config/trpc-handlers/new-config-input-schema";

describe("newConfigInputSchema", () => {
  it("Properly parses valid input", () => {
    expect(
      newConfigInputSchema.parse({
        name: "test",
        merchantCode: "test-merchant",
        shippingCompanyCode: "50000",
        skuAsName: true,
        secretSpCode: "test-sp",
        terminalId: "test-terminal",
        useSandbox: true,
      }),
    ).toStrictEqual({
      name: "test",
      merchantCode: "test-merchant",
      shippingCompanyCode: "50000",
      skuAsName: true,
      secretSpCode: "test-sp",
      terminalId: "test-terminal",
      useSandbox: true,
    });
  });

  it("Returns list of errors for invalid input", () => {
    expect(() =>
      newConfigInputSchema.parse({
        name: "",
        merchantCode: "test-merchant",
        shippingCompanyCode: "aaaaaaaaaa",
        skuAsName: true,
        secretSpCode: "test-sp",
        terminalId: "test-terminal",
        useSandbox: true,
      }),
    ).toThrowErrorMatchingInlineSnapshot(`
      [ZodError: [
        {
          "origin": "string",
          "code": "too_small",
          "minimum": 1,
          "inclusive": true,
          "path": [
            "name"
          ],
          "message": "Too small: expected string to have >=1 characters"
        },
        {
          "origin": "string",
          "code": "too_big",
          "maximum": 5,
          "inclusive": true,
          "exact": true,
          "path": [
            "shippingCompanyCode"
          ],
          "message": "Too big: expected string to have exactly 5 characters"
        }
      ]]
    `);
  });
});
