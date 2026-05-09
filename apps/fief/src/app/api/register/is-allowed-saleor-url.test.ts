import { describe, expect, it } from "vitest";

import { isAllowedSaleorUrl } from "./is-allowed-saleor-url";

/*
 * T16 — `isAllowedSaleorUrl` extracted as a pure function so the regex/allowlist
 * gate can be exercised without booting the SDK handler.
 */

describe("isAllowedSaleorUrl", () => {
  it("returns true when the pattern is undefined (open-by-default, matches Stripe)", () => {
    expect(isAllowedSaleorUrl("https://shop.example/graphql/", undefined)).toBe(true);
  });

  it("returns true when the pattern is the empty string (treated as unset)", () => {
    expect(isAllowedSaleorUrl("https://shop.example/graphql/", "")).toBe(true);
  });

  it("returns true when the URL matches the pattern", () => {
    expect(
      isAllowedSaleorUrl(
        "https://my-shop.saleor.cloud/graphql/",
        "^https://[^.]+\\.saleor\\.cloud/graphql/$",
      ),
    ).toBe(true);
  });

  it("returns false when the URL does not match the pattern", () => {
    expect(
      isAllowedSaleorUrl(
        "https://random-shop.example.com/graphql/",
        "^https://[^.]+\\.saleor\\.cloud/graphql/$",
      ),
    ).toBe(false);
  });

  it("supports a substring/anchored pattern (.includes-style match)", () => {
    expect(isAllowedSaleorUrl("https://shop.opensensor.io/graphql/", "opensensor\\.io")).toBe(true);
    expect(isAllowedSaleorUrl("https://other.saleor.cloud/graphql/", "opensensor\\.io")).toBe(
      false,
    );
  });
});
