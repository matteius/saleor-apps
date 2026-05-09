import { MongoMemoryServer } from "mongodb-memory-server";
import { afterAll, beforeAll, beforeEach, describe, expect, it, vi } from "vitest";

import { createSaleorApiUrl } from "@/modules/saleor/saleor-api-url";

import {
  createWebhookEventId,
  createWebhookLogConnectionId,
  WEBHOOK_LOG_TTL_MS,
} from "../../webhook-log";

/*
 * T11 — Behavioural test suite for the Mongo-backed webhook-log repo,
 * the dlq repo, and the registered migration.
 *
 * Why a single test file: the three modules form one persistence
 * contract (record→retry→move-to-dlq), so the most useful tests cross
 * the boundary. Splitting this into three files would force per-test
 * boot of the Mongo memory server and triple the suite runtime.
 */

let mongoServer: MongoMemoryServer;

beforeAll(async () => {
  mongoServer = await MongoMemoryServer.create();
  vi.stubEnv("MONGODB_URL", mongoServer.getUri());
  vi.stubEnv("MONGODB_DATABASE", "fief_webhook_log_test");
}, 120_000);

afterAll(async () => {
  if (mongoServer) {
    await mongoServer.stop();
  }
  vi.unstubAllEnvs();
});

/*
 * Each test runs in a fresh module graph so the migration registry,
 * the Mongo client singleton, and the repo's internal collection
 * cache all start clean. Between tests we drop the database (so
 * indexes + `_schema_versions` reset).
 */
beforeEach(async () => {
  vi.resetModules();
  vi.restoreAllMocks();

  const { getMongoClient, closeMongoClient } = await import("@/modules/db/mongo-client");
  const client = await getMongoClient();
  const db = client.db("fief_webhook_log_test");

  await db.dropDatabase();
  await closeMongoClient();

  vi.resetModules();
});

const SALEOR_API_URL = createSaleorApiUrl("https://shop-1.saleor.cloud/graphql/")._unsafeUnwrap();
const CONNECTION_ID = createWebhookLogConnectionId("conn-default")._unsafeUnwrap();

const buildInput = (overrides: Partial<{ eventId: string; eventType: string }> = {}) => ({
  saleorApiUrl: SALEOR_API_URL,
  connectionId: CONNECTION_ID,
  direction: "fief_to_saleor" as const,
  eventId: createWebhookEventId(overrides.eventId ?? "evt-1")._unsafeUnwrap(),
  eventType: overrides.eventType ?? "user.created",
  payloadRedacted: { foo: "bar" },
});

describe("MongodbWebhookLogRepo — record + dedup", () => {
  it("dedupCheck returns false initially and true after a row is recorded", async () => {
    const { MongodbWebhookLogRepo } = await import("./mongodb-webhook-log-repo");
    const { registerWebhookLogAndDlqMigrations } = await import("../../migrations");
    const { runMigrations, resetMigrationRegistryForTests } = await import(
      "@/modules/db/migration-runner"
    );

    resetMigrationRegistryForTests();
    registerWebhookLogAndDlqMigrations();
    await runMigrations();

    const repo = new MongodbWebhookLogRepo();
    const eventId = createWebhookEventId("evt-dedup-1")._unsafeUnwrap();

    const before = await repo.dedupCheck({
      saleorApiUrl: SALEOR_API_URL,
      direction: "fief_to_saleor",
      eventId,
    });

    expect(before._unsafeUnwrap()).toBe(false);

    const recorded = await repo.record(buildInput({ eventId: "evt-dedup-1" }));

    expect(recorded._unsafeUnwrap().eventId).toBe("evt-dedup-1");

    const after = await repo.dedupCheck({
      saleorApiUrl: SALEOR_API_URL,
      direction: "fief_to_saleor",
      eventId,
    });

    expect(after._unsafeUnwrap()).toBe(true);
  });

  it("a second record with the same (saleorApiUrl, direction, eventId) returns the existing row, not a duplicate", async () => {
    const { MongodbWebhookLogRepo } = await import("./mongodb-webhook-log-repo");
    const { registerWebhookLogAndDlqMigrations } = await import("../../migrations");
    const { runMigrations, resetMigrationRegistryForTests } = await import(
      "@/modules/db/migration-runner"
    );

    resetMigrationRegistryForTests();
    registerWebhookLogAndDlqMigrations();
    await runMigrations();

    const repo = new MongodbWebhookLogRepo();
    const first = await repo.record(buildInput({ eventId: "evt-2" }));
    const firstRow = first._unsafeUnwrap();

    const second = await repo.record(buildInput({ eventId: "evt-2", eventType: "ignored" }));

    expect(second._unsafeUnwrap().id).toBe(firstRow.id);
    // Second insert was the existing row — NOT the new payload.
    expect(second._unsafeUnwrap().eventType).toBe("user.created");

    const list = await repo.list({ saleorApiUrl: SALEOR_API_URL });

    expect(list._unsafeUnwrap()).toHaveLength(1);
  });

  it("sets ttl to ~30 days hence on insert", async () => {
    const { MongodbWebhookLogRepo } = await import("./mongodb-webhook-log-repo");
    const { registerWebhookLogAndDlqMigrations } = await import("../../migrations");
    const { runMigrations, resetMigrationRegistryForTests } = await import(
      "@/modules/db/migration-runner"
    );

    resetMigrationRegistryForTests();
    registerWebhookLogAndDlqMigrations();
    await runMigrations();

    const repo = new MongodbWebhookLogRepo();
    const before = Date.now();
    const recorded = await repo.record(buildInput({ eventId: "evt-ttl" }));
    const after = Date.now();

    const row = recorded._unsafeUnwrap();

    expect(row.ttl).toBeInstanceOf(Date);

    const ttlMs = row.ttl.getTime();

    // ttl should be createdAt + 30 days, ±100ms slack for test wall clock.
    expect(ttlMs).toBeGreaterThanOrEqual(before + WEBHOOK_LOG_TTL_MS - 100);
    expect(ttlMs).toBeLessThanOrEqual(after + WEBHOOK_LOG_TTL_MS + 100);
  });
});

describe("MongodbWebhookLogRepo — recordAttempt + maxAttempts", () => {
  it("increments attempts and keeps status at retrying while attempts < max", async () => {
    const { MongodbWebhookLogRepo } = await import("./mongodb-webhook-log-repo");
    const { registerWebhookLogAndDlqMigrations } = await import("../../migrations");
    const { runMigrations, resetMigrationRegistryForTests } = await import(
      "@/modules/db/migration-runner"
    );

    resetMigrationRegistryForTests();
    registerWebhookLogAndDlqMigrations();
    await runMigrations();

    const repo = new MongodbWebhookLogRepo();
    const recorded = (await repo.record(buildInput({ eventId: "evt-attempt-1" })))._unsafeUnwrap();

    const second = (
      await repo.recordAttempt({ id: recorded.id, maxAttempts: 6, error: "transient" })
    )._unsafeUnwrap();

    expect(second.row.attempts).toBe(1);
    expect(second.row.status).toBe("retrying");
    expect(second.row.lastError).toBe("transient");
    expect(second.becameDead).toBe(false);
  });

  it("flips status to dead once attempts reaches maxAttempts (default 6)", async () => {
    const { MongodbWebhookLogRepo } = await import("./mongodb-webhook-log-repo");
    const { registerWebhookLogAndDlqMigrations } = await import("../../migrations");
    const { runMigrations, resetMigrationRegistryForTests } = await import(
      "@/modules/db/migration-runner"
    );

    resetMigrationRegistryForTests();
    registerWebhookLogAndDlqMigrations();
    await runMigrations();

    const repo = new MongodbWebhookLogRepo();
    const recorded = (await repo.record(buildInput({ eventId: "evt-dead" })))._unsafeUnwrap();

    let last;

    for (let i = 0; i < 6; i++) {
      last = (
        await repo.recordAttempt({
          id: recorded.id,
          maxAttempts: 6,
          error: `fail-${i}`,
        })
      )._unsafeUnwrap();
    }

    expect(last?.row.attempts).toBe(6);
    expect(last?.row.status).toBe("dead");
    expect(last?.becameDead).toBe(true);
  });

  it("honours a caller-configured maxAttempts (e.g. 2)", async () => {
    const { MongodbWebhookLogRepo } = await import("./mongodb-webhook-log-repo");
    const { registerWebhookLogAndDlqMigrations } = await import("../../migrations");
    const { runMigrations, resetMigrationRegistryForTests } = await import(
      "@/modules/db/migration-runner"
    );

    resetMigrationRegistryForTests();
    registerWebhookLogAndDlqMigrations();
    await runMigrations();

    const repo = new MongodbWebhookLogRepo();
    const recorded = (await repo.record(buildInput({ eventId: "evt-max-2" })))._unsafeUnwrap();

    const first = (
      await repo.recordAttempt({ id: recorded.id, maxAttempts: 2, error: "x" })
    )._unsafeUnwrap();

    expect(first.row.status).toBe("retrying");
    expect(first.becameDead).toBe(false);

    const second = (
      await repo.recordAttempt({ id: recorded.id, maxAttempts: 2, error: "y" })
    )._unsafeUnwrap();

    expect(second.row.attempts).toBe(2);
    expect(second.row.status).toBe("dead");
    expect(second.becameDead).toBe(true);
  });

  it("flips to ok when success: true is reported", async () => {
    const { MongodbWebhookLogRepo } = await import("./mongodb-webhook-log-repo");
    const { registerWebhookLogAndDlqMigrations } = await import("../../migrations");
    const { runMigrations, resetMigrationRegistryForTests } = await import(
      "@/modules/db/migration-runner"
    );

    resetMigrationRegistryForTests();
    registerWebhookLogAndDlqMigrations();
    await runMigrations();

    const repo = new MongodbWebhookLogRepo();
    const recorded = (await repo.record(buildInput({ eventId: "evt-success" })))._unsafeUnwrap();

    const result = (
      await repo.recordAttempt({ id: recorded.id, maxAttempts: 6, success: true })
    )._unsafeUnwrap();

    expect(result.row.status).toBe("ok");
    expect(result.row.attempts).toBe(1);
    expect(result.becameDead).toBe(false);
  });

  it("returns NotFoundError when the row does not exist", async () => {
    const { MongodbWebhookLogRepo } = await import("./mongodb-webhook-log-repo");
    const { registerWebhookLogAndDlqMigrations } = await import("../../migrations");
    const { runMigrations, resetMigrationRegistryForTests } = await import(
      "@/modules/db/migration-runner"
    );
    const { createWebhookLogId } = await import("../../webhook-log");

    resetMigrationRegistryForTests();
    registerWebhookLogAndDlqMigrations();
    await runMigrations();

    const repo = new MongodbWebhookLogRepo();
    const missingId = createWebhookLogId("does-not-exist")._unsafeUnwrap();
    const result = await repo.recordAttempt({ id: missingId, maxAttempts: 6 });

    expect(result.isErr()).toBe(true);
  });
});

describe("MongodbWebhookLogRepo — moveToDlq", () => {
  it("writes to the dlq collection AND removes the row from webhook_log", async () => {
    const { MongodbWebhookLogRepo } = await import("./mongodb-webhook-log-repo");
    const { MongodbDlqRepo } = await import("@/modules/dlq/repositories/mongodb/mongodb-dlq-repo");
    const { registerWebhookLogAndDlqMigrations } = await import("../../migrations");
    const { runMigrations, resetMigrationRegistryForTests } = await import(
      "@/modules/db/migration-runner"
    );

    resetMigrationRegistryForTests();
    registerWebhookLogAndDlqMigrations();
    await runMigrations();

    const repo = new MongodbWebhookLogRepo();
    const dlqRepo = new MongodbDlqRepo();
    const recorded = (await repo.record(buildInput({ eventId: "evt-move" })))._unsafeUnwrap();

    // Push to the dead state so the move-to-dlq is on a realistic path.
    for (let i = 0; i < 6; i++) {
      await repo.recordAttempt({ id: recorded.id, maxAttempts: 6, error: `e-${i}` });
    }

    const moveResult = await repo.moveToDlq(recorded.id);

    expect(moveResult.isOk()).toBe(true);

    const remaining = (await repo.list({ saleorApiUrl: SALEOR_API_URL }))._unsafeUnwrap();

    expect(remaining).toHaveLength(0);

    const dlqList = (await dlqRepo.list({ saleorApiUrl: SALEOR_API_URL }))._unsafeUnwrap();

    expect(dlqList).toHaveLength(1);
    expect(dlqList[0]?.eventId).toBe("evt-move");
    expect(dlqList[0]?.attempts).toBe(6);
    expect(dlqList[0]?.status).toBe("dead");
    expect(dlqList[0]?.movedToDlqAt).toBeInstanceOf(Date);
  });

  it("returns NotFoundError when the source row does not exist", async () => {
    const { MongodbWebhookLogRepo } = await import("./mongodb-webhook-log-repo");
    const { registerWebhookLogAndDlqMigrations } = await import("../../migrations");
    const { runMigrations, resetMigrationRegistryForTests } = await import(
      "@/modules/db/migration-runner"
    );
    const { createWebhookLogId } = await import("../../webhook-log");

    resetMigrationRegistryForTests();
    registerWebhookLogAndDlqMigrations();
    await runMigrations();

    const repo = new MongodbWebhookLogRepo();
    const missingId = createWebhookLogId("nope")._unsafeUnwrap();
    const result = await repo.moveToDlq(missingId);

    expect(result.isErr()).toBe(true);
  });
});

describe("MongodbDlqRepo — getById + delete", () => {
  it("getById returns the row after add; null after delete", async () => {
    const { MongodbDlqRepo } = await import("@/modules/dlq/repositories/mongodb/mongodb-dlq-repo");
    const { registerWebhookLogAndDlqMigrations } = await import("../../migrations");
    const { runMigrations, resetMigrationRegistryForTests } = await import(
      "@/modules/db/migration-runner"
    );
    const { createDlqEntryId, projectWebhookLogToDlqEntry } = await import("@/modules/dlq/dlq");
    const { createWebhookLogId } = await import("../../webhook-log");

    resetMigrationRegistryForTests();
    registerWebhookLogAndDlqMigrations();
    await runMigrations();

    const dlqRepo = new MongodbDlqRepo();
    const id = createDlqEntryId("dlq-1")._unsafeUnwrap();
    const entry = projectWebhookLogToDlqEntry({
      id: createWebhookLogId("dlq-1")._unsafeUnwrap(),
      saleorApiUrl: SALEOR_API_URL,
      connectionId: CONNECTION_ID,
      direction: "fief_to_saleor",
      eventId: createWebhookEventId("evt-x")._unsafeUnwrap(),
      eventType: "user.created",
      status: "dead",
      attempts: 6,
      lastError: "boom",
      payloadRedacted: { foo: 1 },
      ttl: new Date(),
      createdAt: new Date(),
    });

    (await dlqRepo.add(entry))._unsafeUnwrap();

    const fetched = (await dlqRepo.getById(id))._unsafeUnwrap();

    expect(fetched?.eventId).toBe("evt-x");

    (await dlqRepo.delete(id))._unsafeUnwrap();

    const afterDelete = (await dlqRepo.getById(id))._unsafeUnwrap();

    expect(afterDelete).toBeNull();
  });
});

describe("MongodbDlqRepo — no TTL", () => {
  it("the dlq collection has no TTL index (would-be expired field is unset)", async () => {
    await import("@/modules/dlq/repositories/mongodb/mongodb-dlq-repo");
    const { registerWebhookLogAndDlqMigrations } = await import("../../migrations");
    const { runMigrations, resetMigrationRegistryForTests } = await import(
      "@/modules/db/migration-runner"
    );
    const { getMongoClient, getMongoDatabaseName } = await import("@/modules/db/mongo-client");

    resetMigrationRegistryForTests();
    registerWebhookLogAndDlqMigrations();
    await runMigrations();

    const client = await getMongoClient();
    const db = client.db(getMongoDatabaseName());
    const dlqIndexes = await db.collection("dlq").indexes();
    const hasExpire = dlqIndexes.some((idx) => typeof idx.expireAfterSeconds === "number");

    expect(hasExpire).toBe(false);
  });
});

describe("Migration registration — version 005", () => {
  it("registers a single migration entry under version 005 that creates indexes for both collections", async () => {
    const { registerWebhookLogAndDlqMigrations } = await import("../../migrations");
    const { runMigrations, resetMigrationRegistryForTests } = await import(
      "@/modules/db/migration-runner"
    );
    const { getMongoClient, getMongoDatabaseName } = await import("@/modules/db/mongo-client");

    resetMigrationRegistryForTests();
    registerWebhookLogAndDlqMigrations();
    await runMigrations();

    const client = await getMongoClient();
    const db = client.db(getMongoDatabaseName());
    const versions = await db.collection("_schema_versions").find({}).toArray();

    expect(versions.some((v) => typeof v.name === "string" && v.name.startsWith("005:"))).toBe(
      true,
    );

    const webhookLogIndexes = await db.collection("webhook_log").indexes();
    const dlqIndexes = await db.collection("dlq").indexes();

    // Unique dedup index on (saleorApiUrl, direction, eventId).
    const hasDedupIdx = webhookLogIndexes.some(
      (idx) =>
        idx.unique === true &&
        Object.keys(idx.key as Record<string, unknown>).join(",") ===
          "saleorApiUrl,direction,eventId",
    );

    expect(hasDedupIdx).toBe(true);

    // TTL index on `ttl` field.
    const hasTtlIdx = webhookLogIndexes.some(
      (idx) => idx.expireAfterSeconds === 0 && (idx.key as Record<string, unknown>).ttl === 1,
    );

    expect(hasTtlIdx).toBe(true);

    // Health-screen index { saleorApiUrl, status, createdAt }.
    const hasHealthIdx = webhookLogIndexes.some(
      (idx) =>
        Object.keys(idx.key as Record<string, unknown>).join(",") ===
        "saleorApiUrl,status,createdAt",
    );

    expect(hasHealthIdx).toBe(true);

    // DLQ has { saleorApiUrl, createdAt } (or movedToDlqAt).
    const hasDlqIdx = dlqIndexes.some((idx) => {
      const keys = Object.keys(idx.key as Record<string, unknown>);

      return keys[0] === "saleorApiUrl";
    });

    expect(hasDlqIdx).toBe(true);
  });

  it("re-running registration is idempotent (registry de-dups on version+name)", async () => {
    const { registerWebhookLogAndDlqMigrations } = await import("../../migrations");
    const { runMigrations, resetMigrationRegistryForTests } = await import(
      "@/modules/db/migration-runner"
    );
    const { getMongoClient, getMongoDatabaseName } = await import("@/modules/db/mongo-client");

    resetMigrationRegistryForTests();
    registerWebhookLogAndDlqMigrations();
    registerWebhookLogAndDlqMigrations();
    registerWebhookLogAndDlqMigrations();

    await runMigrations();

    const client = await getMongoClient();
    const db = client.db(getMongoDatabaseName());
    const versions = await db.collection("_schema_versions").find({}).toArray();
    const v005Count = versions.filter(
      (v) => typeof v.name === "string" && v.name.startsWith("005:"),
    ).length;

    expect(v005Count).toBe(1);
  });
});
