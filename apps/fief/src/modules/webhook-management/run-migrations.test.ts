import { type WebhookManifest } from "@saleor/app-sdk/types";
import { afterEach, describe, expect, it, vi } from "vitest";

import { type CreateMigrationRunner, RunWebhookMigrationsUseCase } from "./run-migrations";

/*
 * T49 unit tests — `RunWebhookMigrationsUseCase` wraps the shared
 * `WebhookMigrationRunner` from `@saleor/webhook-utils`.
 *
 * The runner itself is exhaustively covered in the package's own tests; here we
 * only assert the wrapper's contract:
 *
 *   1. it constructs the runner with the right args (saleorApiUrl, token,
 *      logger, getManifests, dryRun);
 *   2. it calls `runner.migrate()` exactly once;
 *   3. it returns `ok(undefined)` on the happy path;
 *   4. it returns `err(RunWebhookMigrationsError)` if the runner throws;
 *   5. it no-ops cleanly when the manifest list is empty (T1 scaffolds an empty
 *      `webhooks: []` — the runner must still complete without error).
 *
 * The runner is injected via the `createMigrationRunner` factory (DI seam) so
 * we never construct a real urql client in unit tests.
 */

const makeManifest = (overrides: Partial<WebhookManifest> = {}): WebhookManifest => ({
  name: "test-webhook",
  asyncEvents: ["CUSTOMER_CREATED"],
  query: "subscription { event { ... on CustomerCreated { user { id } } } }",
  targetUrl: "https://app.example.com/api/webhooks/saleor/customer-created",
  isActive: true,
  ...overrides,
});

describe("RunWebhookMigrationsUseCase", () => {
  afterEach(() => {
    vi.restoreAllMocks();
  });

  it("invokes the runner factory with the supplied saleorApiUrl, token, dryRun=false and getManifests", async () => {
    const migrate = vi.fn().mockResolvedValue(undefined);
    const factory: CreateMigrationRunner = vi.fn().mockReturnValue({ migrate });

    const getWebhookManifests = vi.fn().mockResolvedValue([makeManifest()]);

    const useCase = new RunWebhookMigrationsUseCase({
      createMigrationRunner: factory,
      getWebhookManifests,
    });

    const result = await useCase.execute({
      saleorApiUrl: "https://shop.example/graphql/",
      token: "app-token-xyz",
    });

    expect(result.isOk()).toBe(true);
    expect(factory).toHaveBeenCalledTimes(1);

    const factoryArgs = (factory as unknown as ReturnType<typeof vi.fn>).mock.calls[0][0];

    expect(factoryArgs.saleorApiUrl).toBe("https://shop.example/graphql/");
    expect(factoryArgs.token).toBe("app-token-xyz");
    expect(factoryArgs.dryRun).toBe(false);
    expect(typeof factoryArgs.getManifests).toBe("function");
    expect(factoryArgs.logger).toBeDefined();

    expect(migrate).toHaveBeenCalledTimes(1);
  });

  it("forwards the underlying app/instance details to the supplied getWebhookManifests fn", async () => {
    const migrate = vi.fn().mockResolvedValue(undefined);
    let capturedFactoryArgs: Parameters<CreateMigrationRunner>[0] | undefined;
    const factory: CreateMigrationRunner = (args) => {
      capturedFactoryArgs = args;

      return { migrate };
    };

    const getWebhookManifests = vi.fn().mockResolvedValue([makeManifest()]);

    const useCase = new RunWebhookMigrationsUseCase({
      createMigrationRunner: factory,
      getWebhookManifests,
    });

    await useCase.execute({
      saleorApiUrl: "https://shop.example/graphql/",
      token: "app-token-xyz",
    });

    // Simulate the runner pulling app/instance details and invoking our manifest fn.
    const fakeAppDetails = { appUrl: "https://app.example.com", webhooks: [] } as never;
    const fakeInstanceDetails = { version: "3.22.0" } as never;

    const manifests = await capturedFactoryArgs!.getManifests({
      appDetails: fakeAppDetails,
      instanceDetails: fakeInstanceDetails,
    });

    expect(getWebhookManifests).toHaveBeenCalledWith({
      appDetails: fakeAppDetails,
      instanceDetails: fakeInstanceDetails,
    });
    expect(manifests).toStrictEqual([makeManifest()]);
  });

  it("returns ok(undefined) on the happy path", async () => {
    const migrate = vi.fn().mockResolvedValue(undefined);
    const factory: CreateMigrationRunner = () => ({ migrate });

    const useCase = new RunWebhookMigrationsUseCase({
      createMigrationRunner: factory,
      getWebhookManifests: async () => [makeManifest()],
    });

    const result = await useCase.execute({
      saleorApiUrl: "https://shop.example/graphql/",
      token: "tok",
    });

    expect(result.isOk()).toBe(true);
    expect(result._unsafeUnwrap()).toBeUndefined();
  });

  it("no-ops cleanly when the manifest list is empty (T1 baseline: webhooks=[])", async () => {
    const migrate = vi.fn().mockResolvedValue(undefined);
    let capturedFactoryArgs: Parameters<CreateMigrationRunner>[0] | undefined;
    const factory: CreateMigrationRunner = (args) => {
      capturedFactoryArgs = args;

      return { migrate };
    };

    const useCase = new RunWebhookMigrationsUseCase({
      createMigrationRunner: factory,
      getWebhookManifests: async () => [],
    });

    const result = await useCase.execute({
      saleorApiUrl: "https://shop.example/graphql/",
      token: "tok",
    });

    expect(result.isOk()).toBe(true);
    expect(migrate).toHaveBeenCalledTimes(1);

    // The empty-list contract bubbles all the way through getManifests too.
    const manifests = await capturedFactoryArgs!.getManifests({
      appDetails: { appUrl: "https://app.example.com", webhooks: [] } as never,
      instanceDetails: { version: "3.22.0" } as never,
    });

    expect(manifests).toStrictEqual([]);
  });

  it("returns err(RunWebhookMigrationsError) wrapping the cause when the runner throws", async () => {
    const cause = new Error("Saleor unreachable");
    const migrate = vi.fn().mockRejectedValue(cause);
    const factory: CreateMigrationRunner = () => ({ migrate });

    const useCase = new RunWebhookMigrationsUseCase({
      createMigrationRunner: factory,
      getWebhookManifests: async () => [makeManifest()],
    });

    const result = await useCase.execute({
      saleorApiUrl: "https://shop.example/graphql/",
      token: "tok",
    });

    expect(result.isErr()).toBe(true);

    const error = result._unsafeUnwrapErr();

    expect(error._brand).toBe("WebhookManagement.RunWebhookMigrationsError");
    /*
     * `modern-errors` merges the `cause` error's `message` into the wrapper's
     * `.message` (with a `\n` separator). Asserting message contents is the
     * documented way to confirm the cause was preserved end-to-end.
     */
    expect(error.message).toContain("Saleor unreachable");
  });

  it("propagates non-Error throws as a wrapped RunWebhookMigrationsError", async () => {
    const migrate = vi.fn().mockRejectedValue("string-thrown");
    const factory: CreateMigrationRunner = () => ({ migrate });

    const useCase = new RunWebhookMigrationsUseCase({
      createMigrationRunner: factory,
      getWebhookManifests: async () => [makeManifest()],
    });

    const result = await useCase.execute({
      saleorApiUrl: "https://shop.example/graphql/",
      token: "tok",
    });

    expect(result.isErr()).toBe(true);
    expect(result._unsafeUnwrapErr()._brand).toBe("WebhookManagement.RunWebhookMigrationsError");
  });
});
