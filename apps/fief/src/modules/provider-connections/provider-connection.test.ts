import { describe, expect, it } from "vitest";

import {
  claimMappingEntrySchema,
  parseProviderConnection,
  providerConnectionSchema,
  ProviderConnectionValidationError,
} from "./provider-connection";

/*
 * T8 + T17 — schema-level tests for `ProviderConnection`.
 *
 * Focus areas:
 *   - The new `claimMappingEntrySchema` fields (`visibility`,
 *     `reverseSyncEnabled`) added by T17 default correctly when omitted, and
 *     the legacy three-field shape (`fiefClaim`, `saleorMetadataKey`,
 *     `required`) still round-trips so existing persisted docs do not need a
 *     data migration.
 *   - `parseProviderConnection` returns a `Result` (no throw) for both ok
 *     and validation-error paths.
 */

interface RawProviderConnectionFixture {
  id: string;
  saleorApiUrl: string;
  name: string;
  fief: {
    baseUrl: string;
    tenantId: string;
    clientId: string;
    webhookId: string | null;
    encryptedClientSecret: string;
    encryptedPendingClientSecret: string | null;
    encryptedAdminToken: string;
    encryptedWebhookSecret: string;
    encryptedPendingWebhookSecret: string | null;
  };
  branding: {
    encryptedSigningKey: string;
    allowedOrigins: string[];
  };
  claimMapping: Array<{
    fiefClaim: string;
    saleorMetadataKey: string;
    required: boolean;
    visibility?: "public" | "private";
    reverseSyncEnabled?: boolean;
  }>;
  softDeletedAt: Date | null;
}

const buildValidProviderConnectionRaw = (): RawProviderConnectionFixture => ({
  id: "00000000-0000-4000-8000-000000000001",
  saleorApiUrl: "https://shop.example.com/graphql/",
  name: "Default tenant",
  fief: {
    baseUrl: "https://tenant.fief.dev",
    tenantId: "tenant-uuid-1",
    clientId: "client-uuid-1",
    webhookId: null,
    encryptedClientSecret: "iv:cipher",
    encryptedPendingClientSecret: null,
    encryptedAdminToken: "iv:cipher",
    encryptedWebhookSecret: "iv:cipher",
    encryptedPendingWebhookSecret: null,
  },
  branding: {
    encryptedSigningKey: "iv:cipher",
    allowedOrigins: ["https://storefront.example.com"],
  },
  claimMapping: [{ fiefClaim: "email", saleorMetadataKey: "fief.email", required: true }],
  softDeletedAt: null,
});

describe("claimMappingEntrySchema — T17 schema extension", () => {
  it("defaults `visibility` to 'private' when omitted (legacy doc shape)", () => {
    const parsed = claimMappingEntrySchema.parse({
      fiefClaim: "email",
      saleorMetadataKey: "fief.email",
      required: true,
    });

    expect(parsed.visibility).toBe("private");
  });

  it("defaults `reverseSyncEnabled` to `false` when omitted (legacy doc shape)", () => {
    const parsed = claimMappingEntrySchema.parse({
      fiefClaim: "email",
      saleorMetadataKey: "fief.email",
      required: true,
    });

    expect(parsed.reverseSyncEnabled).toBe(false);
  });

  it("accepts the explicit `'public'` visibility", () => {
    const parsed = claimMappingEntrySchema.parse({
      fiefClaim: "plan",
      saleorMetadataKey: "fief.plan",
      required: false,
      visibility: "public",
    });

    expect(parsed.visibility).toBe("public");
  });

  it("accepts `reverseSyncEnabled: true`", () => {
    const parsed = claimMappingEntrySchema.parse({
      fiefClaim: "plan",
      saleorMetadataKey: "fief.plan",
      required: false,
      reverseSyncEnabled: true,
    });

    expect(parsed.reverseSyncEnabled).toBe(true);
  });

  it("rejects unknown visibility values", () => {
    const result = claimMappingEntrySchema.safeParse({
      fiefClaim: "plan",
      saleorMetadataKey: "fief.plan",
      required: false,
      visibility: "secret",
    });

    expect(result.success).toBe(false);
  });

  it("preserves the legacy `required` field for back-compat", () => {
    const parsed = claimMappingEntrySchema.parse({
      fiefClaim: "email",
      saleorMetadataKey: "fief.email",
      required: true,
    });

    expect(parsed.required).toBe(true);
  });
});

describe("providerConnectionSchema — T17 round-trip with mixed claim mappings", () => {
  it("round-trips a doc whose claim mappings mix legacy and new shapes", () => {
    const raw = buildValidProviderConnectionRaw();

    raw.claimMapping = [
      // Legacy shape (no visibility / reverseSyncEnabled).
      { fiefClaim: "email", saleorMetadataKey: "fief.email", required: true },
      // T17 shape with explicit fields.
      {
        fiefClaim: "plan",
        saleorMetadataKey: "fief.plan",
        required: false,
        visibility: "public",
        reverseSyncEnabled: true,
      } as never,
    ];

    const parsed = providerConnectionSchema.parse(raw);

    expect(parsed.claimMapping).toHaveLength(2);
    expect(parsed.claimMapping[0].visibility).toBe("private");
    expect(parsed.claimMapping[0].reverseSyncEnabled).toBe(false);
    expect(parsed.claimMapping[1].visibility).toBe("public");
    expect(parsed.claimMapping[1].reverseSyncEnabled).toBe(true);
  });
});

describe("providerConnectionSchema — fief.webhookId T17 extension", () => {
  it("accepts an explicit `null` webhookId for legacy connections", () => {
    const raw = buildValidProviderConnectionRaw();

    raw.fief.webhookId = null;

    const parsed = providerConnectionSchema.parse(raw);

    expect(parsed.fief.webhookId).toBeNull();
  });

  it("accepts a non-empty string webhookId for T17+ connections", () => {
    const raw = buildValidProviderConnectionRaw();

    raw.fief.webhookId = "00000000-0000-4000-8000-000000000099";

    const parsed = providerConnectionSchema.parse(raw);

    expect(parsed.fief.webhookId).toBe("00000000-0000-4000-8000-000000000099");
  });

  it("rejects an empty webhookId string", () => {
    const raw = buildValidProviderConnectionRaw();

    raw.fief.webhookId = "";

    const result = providerConnectionSchema.safeParse(raw);

    expect(result.success).toBe(false);
  });
});

describe("parseProviderConnection — Result return shape", () => {
  it("returns ok(...) for a valid raw doc", () => {
    const result = parseProviderConnection(buildValidProviderConnectionRaw());

    expect(result.isOk()).toBe(true);
  });

  it("returns err(ProviderConnectionValidationError) for an invalid doc", () => {
    const result = parseProviderConnection({ id: "not-a-uuid" });

    expect(result.isErr()).toBe(true);
    expect(result._unsafeUnwrapErr()).toBeInstanceOf(ProviderConnectionValidationError);
  });
});
