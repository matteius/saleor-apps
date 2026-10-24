import { describe, expect, it } from "vitest";

import { type AtobaraiErrorResponse, createAtobaraiErrorResponse } from "./atobarai-error-response";

describe("createAtobaraiRegisterTransactionErrorResponse", () => {
  it("should successfully parse a valid error response", () => {
    const rawResponse = {
      errors: [
        {
          codes: ["ERR001", "ERR002"],
          id: "transaction_123",
        },
        {
          codes: ["ERR003"],
          id: "transaction_456",
        },
      ],
    };

    const result = createAtobaraiErrorResponse(rawResponse);

    expect(result).toMatchInlineSnapshot(`
      {
        "errors": [
          {
            "codes": [
              "ERR001",
              "ERR002",
            ],
            "id": "transaction_123",
          },
          {
            "codes": [
              "ERR003",
            ],
            "id": "transaction_456",
          },
        ],
      }
    `);
  });

  it("should parse error response with empty errors array", () => {
    const rawResponse = {
      errors: [],
    };

    const result = createAtobaraiErrorResponse(rawResponse);

    expect(result).toMatchInlineSnapshot(`
      {
        "errors": [],
      }
    `);
  });

  it("should throw validation error when response is missing errors field", () => {
    const rawResponse = {
      results: [],
    };

    expect(() => createAtobaraiErrorResponse(rawResponse)).toThrowErrorMatchingInlineSnapshot(
      `
      [AtobaraiErrorResponseValidationError: [
        {
          "expected": "array",
          "code": "invalid_type",
          "path": [
            "errors"
          ],
          "message": "Invalid input: expected array, received undefined"
        }
      ]
      ZodValidationError: Validation error: Invalid input: expected array, received undefined at "errors"
      Invalid Atobarai error response format: Validation error: Invalid input: expected array, received undefined at "errors"]
    `,
    );
  });

  it("shouldn't be assignable without createAtobaraiRegisterTransactionErrorResponse", () => {
    // @ts-expect-error - if this fails - it means the type is not branded
    const testValue: AtobaraiErrorResponse = { errors: [] };

    expect(testValue).toStrictEqual({ errors: [] });
  });
});
