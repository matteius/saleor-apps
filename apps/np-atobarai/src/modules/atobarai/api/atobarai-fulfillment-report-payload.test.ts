import { describe, expect, it } from "vitest";

import { mockedAtobaraiShippingCompanyCode } from "@/__tests__/mocks/atobarai/mocked-atobarai-shipping-company-code";
import { mockedAtobaraiTransactionId } from "@/__tests__/mocks/atobarai/mocked-atobarai-transaction-id";

import {
  type AtobaraiFulfillmentReportPayload,
  createAtobaraiFulfillmentReportPayload,
} from "./atobarai-fulfillment-report-payload";

describe("createAtobaraiFulfillmentReportPayload", () => {
  it("should create a valid AtobaraiFulfillmentReportPayload", () => {
    const result = createAtobaraiFulfillmentReportPayload({
      trackingNumber: "1234567890123456789",
      atobaraiTransactionId: mockedAtobaraiTransactionId,
      shippingCompanyCode: mockedAtobaraiShippingCompanyCode,
    });

    expect(result).toMatchInlineSnapshot(`
      {
        "transactions": [
          {
            "np_transaction_id": "np_trans_id",
            "pd_company_code": "50000",
            "slip_no": "1234567890123456789",
          },
        ],
      }
    `);
  });

  it("should throw validation error when slip_no is more than 20 characters", () => {
    expect(() =>
      createAtobaraiFulfillmentReportPayload({
        trackingNumber: "more-then-20-characters",
        atobaraiTransactionId: mockedAtobaraiTransactionId,
        shippingCompanyCode: mockedAtobaraiShippingCompanyCode,
      }),
    ).toThrowErrorMatchingInlineSnapshot(`
      [AtobaraiFulfillmentReportPayloadValidationError: [
        {
          "origin": "string",
          "code": "too_big",
          "maximum": 20,
          "inclusive": true,
          "path": [
            "transactions",
            0,
            "slip_no"
          ],
          "message": "Too big: expected string to have <=20 characters"
        }
      ]
      ZodValidationError: Validation error: Too big: expected string to have <=20 characters at "transactions[0].slip_no"
      Invalid fulfillment report payload: Validation error: Too big: expected string to have <=20 characters at "transactions[0].slip_no"]
    `);
  });

  it("should throw validation error when slip_no is empty", () => {
    expect(() =>
      createAtobaraiFulfillmentReportPayload({
        trackingNumber: "",
        atobaraiTransactionId: mockedAtobaraiTransactionId,
        shippingCompanyCode: mockedAtobaraiShippingCompanyCode,
      }),
    ).toThrowErrorMatchingInlineSnapshot(`
      [AtobaraiFulfillmentReportPayloadValidationError: [
        {
          "origin": "string",
          "code": "too_small",
          "minimum": 1,
          "inclusive": true,
          "path": [
            "transactions",
            0,
            "slip_no"
          ],
          "message": "Too small: expected string to have >=1 characters"
        }
      ]
      ZodValidationError: Validation error: Too small: expected string to have >=1 characters at "transactions[0].slip_no"
      Invalid fulfillment report payload: Validation error: Too small: expected string to have >=1 characters at "transactions[0].slip_no"]
    `);
  });

  it("shouldn't be assignable without createAtobaraiFulfillmentReportPayload", () => {
    // @ts-expect-error - if this fails - it means the type is not branded
    const testValue: AtobaraiFulfillmentReportPayload = { transactions: [] };

    expect(testValue).toStrictEqual({
      transactions: [],
    });
  });
});
