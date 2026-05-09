import { describe, expect, it } from "vitest";

import {
  createSaleorChannelSlug,
  createSaleorVariantId,
  createStripePriceId,
  PriceVariantMapError,
} from "./price-variant-map";

describe("PriceVariantMap domain types", () => {
  describe("branded ID factories", () => {
    it("createStripePriceId accepts non-empty string", () => {
      const id = createStripePriceId("price_TEST_123");

      expect(id).toBe("price_TEST_123");
    });

    it("createStripePriceId rejects empty string", () => {
      expect(() => createStripePriceId("")).toThrow();
    });

    it("createSaleorVariantId accepts non-empty string", () => {
      const id = createSaleorVariantId("UHJvZHVjdFZhcmlhbnQ6MQ==");

      expect(id).toBe("UHJvZHVjdFZhcmlhbnQ6MQ==");
    });

    it("createSaleorVariantId rejects empty string", () => {
      expect(() => createSaleorVariantId("")).toThrow();
    });

    it("createSaleorChannelSlug accepts non-empty string", () => {
      const slug = createSaleorChannelSlug("owlbooks");

      expect(slug).toBe("owlbooks");
    });
  });

  describe("PriceVariantMapError", () => {
    it("MappingMissingError is a BaseError subclass", () => {
      const e = new PriceVariantMapError.MappingMissingError("missing");

      expect(e).toBeInstanceOf(Error);
      expect(e.message).toBe("missing");
    });

    it("PersistenceFailedError is a BaseError subclass", () => {
      const e = new PriceVariantMapError.PersistenceFailedError("persist boom");

      expect(e).toBeInstanceOf(Error);
      expect(e.message).toBe("persist boom");
    });
  });
});
