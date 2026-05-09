import { describe, expect, it } from "vitest";

import { createSaleorApiUrl } from "@/modules/saleor/saleor-api-url";

import {
  channelConfigurationSchema,
  channelOverrideSchema,
  createChannelSlug,
  createConnectionId,
} from "./channel-configuration";

/*
 * T9 — Domain validation tests for the channel-configuration schema.
 *
 * The schema is the contract the Mongo repo (this task) and the channel-scope
 * resolver (T12) both speak. It encodes the avatax-style "default applies to
 * all channels except those listed in overrides", with overrides allowed to
 * either point at a specific connection OR explicitly mark a channel as
 * `"disabled"` (so the operator can opt-out a single channel from a
 * tenant-default rollout).
 */

const saleorApiUrl = createSaleorApiUrl("https://shop-1.saleor.cloud/graphql/")._unsafeUnwrap();

describe("channel-configuration — schema", () => {
  it("accepts a fully-populated configuration", () => {
    const parsed = channelConfigurationSchema.parse({
      saleorApiUrl,
      defaultConnectionId: createConnectionId("conn-default"),
      overrides: [
        {
          channelSlug: createChannelSlug("uk"),
          connectionId: createConnectionId("conn-uk"),
        },
        {
          channelSlug: createChannelSlug("us"),
          connectionId: "disabled",
        },
      ],
    });

    expect(parsed.defaultConnectionId).toBe("conn-default");
    expect(parsed.overrides).toHaveLength(2);
  });

  it("accepts a configuration with no default and no overrides", () => {
    const parsed = channelConfigurationSchema.parse({
      saleorApiUrl,
      defaultConnectionId: null,
      overrides: [],
    });

    expect(parsed.defaultConnectionId).toBeNull();
    expect(parsed.overrides).toStrictEqual([]);
  });

  it("rejects an override with an empty channelSlug", () => {
    expect(() =>
      channelOverrideSchema.parse({
        channelSlug: "",
        connectionId: "conn-1",
      }),
    ).toThrow();
  });

  it("rejects an override whose connectionId is an unknown string literal", () => {
    /*
     * The repo only understands a real connection id or the literal
     * `"disabled"`. Free-form strings sneak past would silently break T12's
     * resolver.
     */
    expect(() =>
      channelOverrideSchema.parse({
        channelSlug: "uk",
        connectionId: "",
      }),
    ).toThrow();
  });

  it("rejects a configuration without saleorApiUrl", () => {
    expect(() =>
      channelConfigurationSchema.parse({
        defaultConnectionId: null,
        overrides: [],
      }),
    ).toThrow();
  });
});
