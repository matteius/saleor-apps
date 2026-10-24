import { describe, expect, it } from "vitest";
import { z } from "zod";

import { zodReadableError } from "@/lib/zod-readable-error";

describe("zodReadableError", () => {
  it("Prints human readable error from Zod", () => {
    const schema = z.object({
      foo: z.string().min(4),
      bar: z.number().gt(3),
    });

    const result = schema.safeParse({ foo: "bar", bar: 2 }); // invalid

    if (result.success) {
      throw new Error("Should not be reached");
    } else {
      const error = zodReadableError(result.error);

      expect(error.message).toMatchInlineSnapshot(
        `"Validation error: Too small: expected string to have >=4 characters at "foo"; Too small: expected number to be >3 at "bar""`,
      );
    }
  });
});
