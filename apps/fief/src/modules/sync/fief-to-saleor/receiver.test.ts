import { createHmac, randomUUID } from "node:crypto";

import { err, ok, type Result } from "neverthrow";
import { afterEach, beforeEach, describe, expect, it, vi } from "vitest";

import { RotatingFiefEncryptor } from "@/modules/crypto/encryptor";
import {
  createAllowedOrigin,
  createEncryptedSecret,
  createFiefBaseUrl,
  createFiefClientId,
  createFiefTenantId,
  createFiefWebhookId,
  createProviderConnectionId,
  createProviderConnectionName,
  type ProviderConnection,
  type ProviderConnectionId,
} from "@/modules/provider-connections/provider-connection";
import {
  type ProviderConnectionRepo,
  ProviderConnectionRepoError,
} from "@/modules/provider-connections/provider-connection-repo";
import { createSaleorApiUrl, type SaleorApiUrl } from "@/modules/saleor/saleor-api-url";
import {
  type WebhookDirection,
  type WebhookEventId,
  type WebhookLog,
} from "@/modules/webhook-log/webhook-log";
import { type WebhookLogRepo, WebhookLogRepoError } from "@/modules/webhook-log/webhook-log-repo";

import { EventRouter } from "./event-router";
import {
  FIEF_WEBHOOK_SIGNATURE_HEADER,
  FIEF_WEBHOOK_TIMESTAMP_HEADER,
  type FindConnectionById,
  parseFiefWebhookBody,
  synthesizeEventId,
} from "./receiver";

/*
 * The kill-switch helpers read the typed `env` object. Mock per-test like
 * `kill-switches.test.ts` does so we can flip `FIEF_SYNC_DISABLED` on/off.
 */
type EnvShape = {
  FIEF_SYNC_DISABLED: boolean;
  FIEF_SALEOR_TO_FIEF_DISABLED: boolean;
};

const mockEnv = (overrides: Partial<EnvShape> = {}) => {
  vi.doMock("@/lib/env", () => ({
    env: {
      FIEF_SYNC_DISABLED: false,
      FIEF_SALEOR_TO_FIEF_DISABLED: false,
      SECRET_KEY: "test_secret_key",
      ...overrides,
    },
  }));
};

afterEach(() => {
  vi.doUnmock("@/lib/env");
  vi.resetModules();
});

const SALEOR_URL = createSaleorApiUrl("https://shop.example/graphql/")._unsafeUnwrap();

/*
 * The receiver needs a real (deterministic) encryptor so we can mint
 * ciphertext for the connection's webhook secret in setup AND have the
 * receiver decrypt it back for HMAC verification. Use a fixed AES-256
 * key so the round-trip is repeatable across test runs.
 */
const TEST_AES_KEY = "0".repeat(64);
const buildEncryptor = () => new RotatingFiefEncryptor({ secretKey: TEST_AES_KEY });

const buildConnection = (overrides: {
  id: ProviderConnectionId;
  webhookSecretPlain: string;
  pendingWebhookSecretPlain?: string | null;
  softDeletedAt?: Date | null;
}): ProviderConnection => {
  const enc = buildEncryptor();

  return {
    id: overrides.id,
    saleorApiUrl: SALEOR_URL,
    name: createProviderConnectionName("test-conn"),
    fief: {
      baseUrl: createFiefBaseUrl("https://fief.example.com"),
      tenantId: createFiefTenantId("tenant-1"),
      clientId: createFiefClientId("client-1"),
      webhookId: createFiefWebhookId("webhook-1"),
      encryptedClientSecret: createEncryptedSecret(enc.encrypt("client_secret_plain").ciphertext),
      encryptedPendingClientSecret: null,
      encryptedAdminToken: createEncryptedSecret(enc.encrypt("admin_token_plain").ciphertext),
      encryptedWebhookSecret: createEncryptedSecret(
        enc.encrypt(overrides.webhookSecretPlain).ciphertext,
      ),
      encryptedPendingWebhookSecret:
        overrides.pendingWebhookSecretPlain == null
          ? null
          : createEncryptedSecret(enc.encrypt(overrides.pendingWebhookSecretPlain).ciphertext),
    },
    branding: {
      encryptedSigningKey: createEncryptedSecret(enc.encrypt("signing_key_plain").ciphertext),
      allowedOrigins: [createAllowedOrigin("https://shop.example")],
    },
    claimMapping: [],
    softDeletedAt: overrides.softDeletedAt ?? null,
  };
};

/*
 * In-memory webhook-log repo just sufficient for the receiver tests.
 * Records an internal Map keyed by `(saleorApiUrl, direction, eventId)`
 * tuple so dedupCheck reports membership accurately.
 */
class InMemoryWebhookLogRepo implements WebhookLogRepo {
  public readonly seen: {
    saleorApiUrl: SaleorApiUrl;
    direction: WebhookDirection;
    eventId: WebhookEventId;
  }[] = [];
  public readonly recorded: WebhookLog[] = [];
  public failDedup = false;

  async record(input: Parameters<WebhookLogRepo["record"]>[0]) {
    const row: WebhookLog = {
      id: ("log-" + (this.recorded.length + 1)) as WebhookLog["id"],
      saleorApiUrl: input.saleorApiUrl,
      connectionId: input.connectionId,
      direction: input.direction,
      eventId: input.eventId,
      eventType: input.eventType,
      status: input.initialStatus ?? "retrying",
      attempts: 0,
      payloadRedacted: input.payloadRedacted,
      ttl: new Date(Date.now() + 30 * 24 * 60 * 60 * 1000),
      createdAt: new Date(),
    };

    this.recorded.push(row);
    this.seen.push({
      saleorApiUrl: input.saleorApiUrl,
      direction: input.direction,
      eventId: input.eventId,
    });

    return ok(row);
  }

  async dedupCheck(args: {
    saleorApiUrl: SaleorApiUrl;
    direction: WebhookDirection;
    eventId: WebhookEventId;
  }) {
    if (this.failDedup) {
      return err(new WebhookLogRepoError("dedup-check-failed-for-test"));
    }

    return ok(
      this.seen.some(
        (s) =>
          s.saleorApiUrl === args.saleorApiUrl &&
          s.direction === args.direction &&
          (s.eventId as unknown as string) === (args.eventId as unknown as string),
      ),
    );
  }

  async recordAttempt(): ReturnType<WebhookLogRepo["recordAttempt"]> {
    throw new Error("not used in T22 receiver tests");
  }

  async moveToDlq(): ReturnType<WebhookLogRepo["moveToDlq"]> {
    throw new Error("not used in T22 receiver tests");
  }

  async list(): ReturnType<WebhookLogRepo["list"]> {
    return ok([]);
  }

  async getById(): ReturnType<WebhookLogRepo["getById"]> {
    return ok(null);
  }
}

const noopProviderConnectionRepo = {
  /*
   * We don't exercise the tenant-scoped repo path in these tests — the
   * receiver only uses the injected `findConnectionById` lookup.
   */
  create: vi.fn(),
  get: vi.fn(),
  list: vi.fn(),
  update: vi.fn(),
  softDelete: vi.fn(),
  restore: vi.fn(),
  getDecryptedSecrets: vi.fn(),
} as unknown as ProviderConnectionRepo;

/**
 * Build a deterministic Fief signature for `(timestamp, body, secret)`
 * matching `delivery.py:_get_signature` exactly.
 */
const sign = (args: { secret: string; timestamp: string; body: string }): string => {
  return createHmac("sha256", args.secret)
    .update(`${args.timestamp}.${args.body}`, "utf-8")
    .digest("hex");
};

const buildBody = (overrides: { type?: string; data?: Record<string, unknown> } = {}): string =>
  JSON.stringify({
    type: overrides.type ?? "user.created",
    data: overrides.data ?? { id: "fief-user-1", email: "u@example.com" },
  });

const buildHeaders = (
  signature: string,
  timestamp: string,
): Record<string, string | undefined> => ({
  [FIEF_WEBHOOK_SIGNATURE_HEADER]: signature,
  [FIEF_WEBHOOK_TIMESTAMP_HEADER]: timestamp,
});

const loadReceiver = async () => {
  /*
   * Re-import after mockEnv() so the receiver's transitive imports of
   * `@/lib/env` (via kill-switches) read our stub.
   */
  return import("./receiver");
};

describe("FiefReceiver — T22", () => {
  let connectionId: ProviderConnectionId;
  let connection: ProviderConnection;
  let webhookSecretPlain: string;
  let webhookLogRepo: InMemoryWebhookLogRepo;
  let eventRouter: EventRouter;
  let findConnectionById: FindConnectionById;

  beforeEach(() => {
    connectionId = createProviderConnectionId(randomUUID());
    webhookSecretPlain = "fief-webhook-secret-plain-32bytes-here";
    connection = buildConnection({ id: connectionId, webhookSecretPlain });
    webhookLogRepo = new InMemoryWebhookLogRepo();
    eventRouter = new EventRouter();
    findConnectionById = vi.fn(async (id) =>
      id === connectionId
        ? ok(connection)
        : err(new ProviderConnectionRepoError.NotFound(`not-found ${id}`)),
    );
  });

  describe("happy path", () => {
    it("verifies signature, dedups, dispatches, and returns 'accepted' (dispatched=true)", async () => {
      mockEnv({ FIEF_SYNC_DISABLED: false });
      const { FiefReceiver: ReceiverClass } = await loadReceiver();

      const handler = vi.fn(() => ok(undefined));

      eventRouter.registerHandler("user.created", handler);

      const body = buildBody({ type: "user.created" });
      const timestamp = "1734000000";
      const signature = sign({ secret: webhookSecretPlain, timestamp, body });

      const receiver = new ReceiverClass({
        providerConnectionRepo: noopProviderConnectionRepo,
        findConnectionById,
        webhookLogRepo,
        encryptor: buildEncryptor(),
        eventRouter,
      });

      const result = await receiver.receive({
        rawBody: body,
        headers: buildHeaders(signature, timestamp),
        connectionIdQueryParam: connectionId as unknown as string,
      });

      expect(result.isOk()).toBe(true);
      const outcome = result._unsafeUnwrap();

      expect(outcome.kind).toBe("accepted");
      if (outcome.kind === "accepted") {
        expect(outcome.dispatched).toBe(true);
        expect(outcome.eventType).toBe("user.created");
      }
      expect(handler).toHaveBeenCalledTimes(1);
      expect(webhookLogRepo.recorded.length).toBe(1);
      expect(webhookLogRepo.recorded[0].status).toBe("ok");
    });
  });

  describe("HMAC verification", () => {
    it("returns 'unauthorized' when the signature does not match", async () => {
      mockEnv({ FIEF_SYNC_DISABLED: false });
      const { FiefReceiver: ReceiverClass } = await loadReceiver();

      const body = buildBody();
      const timestamp = "1734000000";
      const wrongSignature = sign({ secret: "wrong-secret", timestamp, body });

      const receiver = new ReceiverClass({
        providerConnectionRepo: noopProviderConnectionRepo,
        findConnectionById,
        webhookLogRepo,
        encryptor: buildEncryptor(),
        eventRouter,
      });

      const result = await receiver.receive({
        rawBody: body,
        headers: buildHeaders(wrongSignature, timestamp),
        connectionIdQueryParam: connectionId as unknown as string,
      });

      const outcome = result._unsafeUnwrap();

      expect(outcome.kind).toBe("unauthorized");
      if (outcome.kind === "unauthorized") {
        expect(outcome.reason).toBe("signature-mismatch");
      }
      expect(webhookLogRepo.recorded.length).toBe(0);
    });

    it("returns 'unauthorized' (signature-missing) when headers are absent", async () => {
      mockEnv({ FIEF_SYNC_DISABLED: false });
      const { FiefReceiver: ReceiverClass } = await loadReceiver();

      const body = buildBody();

      const receiver = new ReceiverClass({
        providerConnectionRepo: noopProviderConnectionRepo,
        findConnectionById,
        webhookLogRepo,
        encryptor: buildEncryptor(),
        eventRouter,
      });

      const result = await receiver.receive({
        rawBody: body,
        headers: {},
        connectionIdQueryParam: connectionId as unknown as string,
      });

      const outcome = result._unsafeUnwrap();

      expect(outcome.kind).toBe("unauthorized");
      if (outcome.kind === "unauthorized") {
        expect(outcome.reason).toBe("signature-missing");
      }
    });

    it("accepts a signature computed from the PENDING webhook secret during a rotation window", async () => {
      mockEnv({ FIEF_SYNC_DISABLED: false });
      const { FiefReceiver: ReceiverClass } = await loadReceiver();

      const pendingSecret = "fief-pending-webhook-secret-rotation-window";

      connection = buildConnection({
        id: connectionId,
        webhookSecretPlain,
        pendingWebhookSecretPlain: pendingSecret,
      });
      findConnectionById = vi.fn(async () => ok(connection));

      const body = buildBody({ type: "user.updated" });
      const timestamp = "1734000123";
      const signatureViaPending = sign({ secret: pendingSecret, timestamp, body });

      const handler = vi.fn(() => ok(undefined));

      eventRouter.registerHandler("user.updated", handler);

      const receiver = new ReceiverClass({
        providerConnectionRepo: noopProviderConnectionRepo,
        findConnectionById,
        webhookLogRepo,
        encryptor: buildEncryptor(),
        eventRouter,
      });

      const result = await receiver.receive({
        rawBody: body,
        headers: buildHeaders(signatureViaPending, timestamp),
        connectionIdQueryParam: connectionId as unknown as string,
      });

      const outcome = result._unsafeUnwrap();

      expect(outcome.kind).toBe("accepted");
      expect(handler).toHaveBeenCalledTimes(1);
    });

    it("still accepts the CURRENT secret while a pending secret is also in place", async () => {
      mockEnv({ FIEF_SYNC_DISABLED: false });
      const { FiefReceiver: ReceiverClass } = await loadReceiver();

      const pendingSecret = "different-pending-secret";

      connection = buildConnection({
        id: connectionId,
        webhookSecretPlain,
        pendingWebhookSecretPlain: pendingSecret,
      });
      findConnectionById = vi.fn(async () => ok(connection));

      const body = buildBody({ type: "user.deleted" });
      const timestamp = "1734000200";
      const signatureViaCurrent = sign({ secret: webhookSecretPlain, timestamp, body });

      const receiver = new ReceiverClass({
        providerConnectionRepo: noopProviderConnectionRepo,
        findConnectionById,
        webhookLogRepo,
        encryptor: buildEncryptor(),
        eventRouter,
      });

      const result = await receiver.receive({
        rawBody: body,
        headers: buildHeaders(signatureViaCurrent, timestamp),
        connectionIdQueryParam: connectionId as unknown as string,
      });

      const outcome = result._unsafeUnwrap();

      expect(outcome.kind).toBe("accepted");
    });
  });

  describe("connection lookup", () => {
    it("returns 'gone' (connection-not-found) for an unknown connectionId", async () => {
      mockEnv({ FIEF_SYNC_DISABLED: false });
      const { FiefReceiver: ReceiverClass } = await loadReceiver();

      findConnectionById = vi.fn(async () =>
        err(new ProviderConnectionRepoError.NotFound("missing")),
      );

      const body = buildBody();
      const timestamp = "1734000300";
      const signature = sign({ secret: webhookSecretPlain, timestamp, body });

      const receiver = new ReceiverClass({
        providerConnectionRepo: noopProviderConnectionRepo,
        findConnectionById,
        webhookLogRepo,
        encryptor: buildEncryptor(),
        eventRouter,
      });

      const result = await receiver.receive({
        rawBody: body,
        headers: buildHeaders(signature, timestamp),
        connectionIdQueryParam: connectionId as unknown as string,
      });

      const outcome = result._unsafeUnwrap();

      expect(outcome.kind).toBe("gone");
      if (outcome.kind === "gone") {
        expect(outcome.reason).toBe("connection-not-found");
      }
      expect(webhookLogRepo.recorded.length).toBe(0);
    });

    it("returns 'gone' (connection-soft-deleted) for a soft-deleted connection", async () => {
      mockEnv({ FIEF_SYNC_DISABLED: false });
      const { FiefReceiver: ReceiverClass } = await loadReceiver();

      const softDeleted = buildConnection({
        id: connectionId,
        webhookSecretPlain,
        softDeletedAt: new Date("2026-04-01T00:00:00.000Z"),
      });

      findConnectionById = vi.fn(async () => ok(softDeleted));

      const body = buildBody();
      const timestamp = "1734000400";
      const signature = sign({ secret: webhookSecretPlain, timestamp, body });

      const receiver = new ReceiverClass({
        providerConnectionRepo: noopProviderConnectionRepo,
        findConnectionById,
        webhookLogRepo,
        encryptor: buildEncryptor(),
        eventRouter,
      });

      const result = await receiver.receive({
        rawBody: body,
        headers: buildHeaders(signature, timestamp),
        connectionIdQueryParam: connectionId as unknown as string,
      });

      const outcome = result._unsafeUnwrap();

      expect(outcome.kind).toBe("gone");
      if (outcome.kind === "gone") {
        expect(outcome.reason).toBe("connection-soft-deleted");
      }
    });

    it("returns 'bad-request' for missing connectionId query param", async () => {
      mockEnv({ FIEF_SYNC_DISABLED: false });
      const { FiefReceiver: ReceiverClass } = await loadReceiver();

      const receiver = new ReceiverClass({
        providerConnectionRepo: noopProviderConnectionRepo,
        findConnectionById,
        webhookLogRepo,
        encryptor: buildEncryptor(),
        eventRouter,
      });

      const result = await receiver.receive({
        rawBody: buildBody(),
        headers: buildHeaders("aa", "1"),
        connectionIdQueryParam: null,
      });

      expect(result._unsafeUnwrap().kind).toBe("bad-request");
    });
  });

  describe("kill switch", () => {
    it("returns 'service-unavailable' when FIEF_SYNC_DISABLED is true", async () => {
      mockEnv({ FIEF_SYNC_DISABLED: true });
      const { FiefReceiver: ReceiverClass } = await loadReceiver();

      const body = buildBody();
      const timestamp = "1734000500";
      const signature = sign({ secret: webhookSecretPlain, timestamp, body });

      const receiver = new ReceiverClass({
        providerConnectionRepo: noopProviderConnectionRepo,
        findConnectionById,
        webhookLogRepo,
        encryptor: buildEncryptor(),
        eventRouter,
      });

      const result = await receiver.receive({
        rawBody: body,
        headers: buildHeaders(signature, timestamp),
        connectionIdQueryParam: connectionId as unknown as string,
      });

      const outcome = result._unsafeUnwrap();

      expect(outcome.kind).toBe("service-unavailable");
      if (outcome.kind === "service-unavailable") {
        expect(outcome.reason).toBe("fief-sync-disabled");
      }
      // No event router invocation expected.
      expect(webhookLogRepo.recorded.length).toBe(0);
    });
  });

  describe("dedup", () => {
    it("returns 'duplicate' on a second delivery with the same timestamp+body+connection", async () => {
      mockEnv({ FIEF_SYNC_DISABLED: false });
      const { FiefReceiver: ReceiverClass } = await loadReceiver();

      const handler = vi.fn(() => ok(undefined));

      eventRouter.registerHandler("user.created", handler);

      const body = buildBody({ type: "user.created" });
      const timestamp = "1734000600";
      const signature = sign({ secret: webhookSecretPlain, timestamp, body });

      const receiver = new ReceiverClass({
        providerConnectionRepo: noopProviderConnectionRepo,
        findConnectionById,
        webhookLogRepo,
        encryptor: buildEncryptor(),
        eventRouter,
      });

      // First delivery — accepted + recorded.
      const first = await receiver.receive({
        rawBody: body,
        headers: buildHeaders(signature, timestamp),
        connectionIdQueryParam: connectionId as unknown as string,
      });

      expect(first._unsafeUnwrap().kind).toBe("accepted");

      // Second delivery (same payload + ts) — duplicate.
      const second = await receiver.receive({
        rawBody: body,
        headers: buildHeaders(signature, timestamp),
        connectionIdQueryParam: connectionId as unknown as string,
      });

      const outcome = second._unsafeUnwrap();

      expect(outcome.kind).toBe("duplicate");
      // Handler should NOT have run a second time.
      expect(handler).toHaveBeenCalledTimes(1);
    });
  });

  describe("unknown event type — forward-compat", () => {
    it("returns 'accepted' (dispatched=false) and records the row when no handler is registered", async () => {
      mockEnv({ FIEF_SYNC_DISABLED: false });
      const { FiefReceiver: ReceiverClass } = await loadReceiver();

      const body = buildBody({
        type: "tenant.created",
        data: { id: "tenant-1" },
      });
      const timestamp = "1734000700";
      const signature = sign({ secret: webhookSecretPlain, timestamp, body });

      const receiver = new ReceiverClass({
        providerConnectionRepo: noopProviderConnectionRepo,
        findConnectionById,
        webhookLogRepo,
        encryptor: buildEncryptor(),
        eventRouter, // no handlers registered
      });

      const result = await receiver.receive({
        rawBody: body,
        headers: buildHeaders(signature, timestamp),
        connectionIdQueryParam: connectionId as unknown as string,
      });

      const outcome = result._unsafeUnwrap();

      expect(outcome.kind).toBe("accepted");
      if (outcome.kind === "accepted") {
        expect(outcome.dispatched).toBe(false);
        expect(outcome.eventType).toBe("tenant.created");
      }
      // Row recorded with status "ok" (no handler => no retry needed).
      expect(webhookLogRepo.recorded.length).toBe(1);
      expect(webhookLogRepo.recorded[0].status).toBe("ok");
    });
  });

  describe("payload helpers", () => {
    it("parseFiefWebhookBody rejects non-JSON bodies", () => {
      const result = parseFiefWebhookBody("not json");

      expect(result.isErr()).toBe(true);
    });

    it("parseFiefWebhookBody rejects bodies without {type, data}", () => {
      const result = parseFiefWebhookBody(JSON.stringify({ foo: "bar" }));

      expect(result.isErr()).toBe(true);
    });

    it("parseFiefWebhookBody accepts {type, data} with extra fields", () => {
      const result = parseFiefWebhookBody(
        JSON.stringify({ type: "user.created", data: { id: "x" }, extra: 1 }),
      );

      expect(result.isOk()).toBe(true);
    });

    it("synthesizeEventId is deterministic across same-timestamp/same-body inputs", () => {
      const a = synthesizeEventId({ timestamp: "1234", rawBody: "payload" });
      const b = synthesizeEventId({ timestamp: "1234", rawBody: "payload" });

      expect(a).toBe(b);
    });

    it("synthesizeEventId varies when the body differs", () => {
      const a = synthesizeEventId({ timestamp: "1234", rawBody: "a" });
      const b = synthesizeEventId({ timestamp: "1234", rawBody: "b" });

      expect(a).not.toBe(b);
    });
  });
});

/*
 * Unused-import keeper so vitest doesn't drop the `Result` type re-export
 * referenced by ambient inference.
 */
const _unused: Result<unknown, unknown> = ok(undefined);

void _unused;
