import { describe, expect, it } from "vitest";

import {
  type AtobaraiMoney,
  AtobaraiMoneyValidationError,
  createAtobaraiMoney,
} from "./atobarai-money";

describe("createAtobaraiMoney", () => {
  it("should create a valid AtobaraiMoney", () => {
    const result = createAtobaraiMoney({
      amount: 1000,
      currency: "JPY",
    });

    expect(result).toStrictEqual({ amount: 1000, currency: "JPY" });
  });

  it("should throw AtobaraiMoneyValidationError when currency is an empty string", () => {
    expect(() => createAtobaraiMoney({ amount: 1000, currency: "" })).toThrow(
      AtobaraiMoneyValidationError,
    );
    expect(() =>
      createAtobaraiMoney({ amount: 1000, currency: "" }),
    ).toThrowErrorMatchingInlineSnapshot(
      `
      [AtobaraiMoneyValidationError: [
        {
          "code": "invalid_value",
          "values": [
            "JPY"
          ],
          "path": [
            "currency"
          ],
          "message": "Invalid input: expected \\"JPY\\""
        }
      ]
      ZodValidationError: Validation error: Invalid input: expected "JPY" at "currency"
      Invalid money data: Validation error: Invalid input: expected "JPY" at "currency"]
    `,
    );
  });

  it("should throw AtobaraiMoneyValidationError when currency is not JPY", () => {
    expect(() => createAtobaraiMoney({ amount: 1000, currency: "USD" })).toThrow(
      AtobaraiMoneyValidationError,
    );
    expect(() =>
      createAtobaraiMoney({ amount: 1000, currency: "USD" }),
    ).toThrowErrorMatchingInlineSnapshot(
      `
      [AtobaraiMoneyValidationError: [
        {
          "code": "invalid_value",
          "values": [
            "JPY"
          ],
          "path": [
            "currency"
          ],
          "message": "Invalid input: expected \\"JPY\\""
        }
      ]
      ZodValidationError: Validation error: Invalid input: expected "JPY" at "currency"
      Invalid money data: Validation error: Invalid input: expected "JPY" at "currency"]
    `,
    );
  });

  it("shouldn't be assignable without createAtobaraiMoney", () => {
    // @ts-expect-error - if this fails - it means the type is not branded
    const testValue: AtobaraiMoney = { amount: 1000, currency: "JPY" };

    expect(testValue).toStrictEqual({ amount: 1000, currency: "JPY" });
  });
});
