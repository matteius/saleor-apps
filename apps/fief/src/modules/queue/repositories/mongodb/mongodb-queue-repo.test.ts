import { MongoMemoryServer } from "mongodb-memory-server";
import { afterAll, beforeAll, beforeEach, describe, expect, it, vi } from "vitest";

import { createSaleorApiUrl } from "@/modules/saleor/saleor-api-url";
import {
  createWebhookEventId,
  createWebhookLogConnectionId,
} from "@/modules/webhook-log/webhook-log";

/*
 * T52 — Behavioural test suite for the Mongo-backed in-process queue
 * (`MongodbOutboundQueueRepo`) and the queue worker.
 *
 * Layout mirrors T11's webhook-log/dlq test file: one describe block per
 * persistence concern (enqueue, lease, complete, releaseWithBackoff,
 * worker happy path, worker retry path, worker DLQ handoff, worker stop).
 */

let mongoServer: MongoMemoryServer;

beforeAll(async () => {
  mongoServer = await MongoMemoryServer.create();
  vi.stubEnv("MONGODB_URL", mongoServer.getUri());
  vi.stubEnv("MONGODB_DATABASE", "fief_outbound_queue_test");
}, 120_000);

afterAll(async () => {
  if (mongoServer) {
    await mongoServer.stop();
  }
  vi.unstubAllEnvs();
});

beforeEach(async () => {
  vi.resetModules();
  vi.restoreAllMocks();

  const { getMongoClient, closeMongoClient } = await import("@/modules/db/mongo-client");
  const client = await getMongoClient();
  const db = client.db("fief_outbound_queue_test");

  await db.dropDatabase();
  await closeMongoClient();

  vi.resetModules();
});

const SALEOR_API_URL = createSaleorApiUrl("https://shop-1.saleor.cloud/graphql/")._unsafeUnwrap();
const CONNECTION_ID = createWebhookLogConnectionId("conn-default")._unsafeUnwrap();

const buildEnqueueInput = (
  overrides: Partial<{
    eventId: string;
    eventType: string;
    payload: Record<string, unknown>;
  }> = {},
) => ({
  saleorApiUrl: SALEOR_API_URL,
  connectionId: CONNECTION_ID,
  eventType: overrides.eventType ?? "customer.created",
  eventId: createWebhookEventId(overrides.eventId ?? "evt-1")._unsafeUnwrap(),
  payload: overrides.payload ?? { foo: "bar" },
});

async function setupRepo() {
  const { MongodbOutboundQueueRepo } = await import("./mongodb-queue-repo");
  const { registerOutboundQueueMigrations } = await import("../../migrations");
  const { runMigrations, resetMigrationRegistryForTests } = await import(
    "@/modules/db/migration-runner"
  );

  resetMigrationRegistryForTests();
  registerOutboundQueueMigrations();
  await runMigrations();

  return new MongodbOutboundQueueRepo();
}

describe("MongodbOutboundQueueRepo — enqueue", () => {
  it("inserts a queue job with attempts=0 and nextAttemptAt=now", async () => {
    const repo = await setupRepo();
    const before = Date.now();
    const result = await repo.enqueue(buildEnqueueInput({ eventId: "evt-enq-1" }));
    const after = Date.now();

    const job = result._unsafeUnwrap();

    expect(job.id).toBeDefined();
    expect(job.attempts).toBe(0);
    expect(job.nextAttemptAt).toBeInstanceOf(Date);
    expect(job.nextAttemptAt.getTime()).toBeGreaterThanOrEqual(before - 100);
    expect(job.nextAttemptAt.getTime()).toBeLessThanOrEqual(after + 100);
    expect(job.eventType).toBe("customer.created");
    expect(job.eventId).toBe("evt-enq-1");
    expect(job.payload).toStrictEqual({ foo: "bar" });
    expect(job.lockedBy).toBeUndefined();
    expect(job.lockedUntil).toBeUndefined();
  });

  it("is idempotent on duplicate eventId — returns the existing job, does not insert again", async () => {
    const repo = await setupRepo();
    const first = (await repo.enqueue(buildEnqueueInput({ eventId: "evt-dedup" })))._unsafeUnwrap();

    const second = (
      await repo.enqueue(buildEnqueueInput({ eventId: "evt-dedup", eventType: "ignored" }))
    )._unsafeUnwrap();

    expect(second.id).toBe(first.id);
    // The first one's eventType wins; the second call should NOT overwrite.
    expect(second.eventType).toBe("customer.created");

    const allJobs = (await repo.peek({}))._unsafeUnwrap();

    expect(allJobs).toHaveLength(1);
  });
});

describe("MongodbOutboundQueueRepo — lease", () => {
  it("returns the next due job and atomically locks it for the worker", async () => {
    const repo = await setupRepo();
    const enqueued = (
      await repo.enqueue(buildEnqueueInput({ eventId: "evt-lease" }))
    )._unsafeUnwrap();

    const leased = (await repo.lease("worker-A", 30_000))._unsafeUnwrap();

    expect(leased).not.toBeNull();
    expect(leased?.id).toBe(enqueued.id);
    expect(leased?.lockedBy).toBe("worker-A");
    expect(leased?.lockedUntil).toBeInstanceOf(Date);
    expect((leased?.lockedUntil?.getTime() ?? 0) - Date.now()).toBeGreaterThan(20_000);
  });

  it("returns null when no eligible job exists", async () => {
    const repo = await setupRepo();
    const leased = (await repo.lease("worker-A", 30_000))._unsafeUnwrap();

    expect(leased).toBeNull();
  });

  it("does not return jobs whose nextAttemptAt is in the future", async () => {
    const repo = await setupRepo();

    await repo.enqueue(buildEnqueueInput({ eventId: "evt-future" }));

    const job = (await repo.peek({}))._unsafeUnwrap()[0]!;

    // Push nextAttemptAt 1 hour into the future.
    const future = new Date(Date.now() + 60 * 60 * 1000);

    (await repo.releaseWithBackoff(job.id, 1, future))._unsafeUnwrap();

    const leased = (await repo.lease("worker-A", 30_000))._unsafeUnwrap();

    expect(leased).toBeNull();
  });

  it("two concurrent lease() calls on the same single job return the job to exactly one worker", async () => {
    const repo = await setupRepo();

    await repo.enqueue(buildEnqueueInput({ eventId: "evt-race" }));

    const [a, b] = await Promise.all([
      repo.lease("worker-A", 30_000),
      repo.lease("worker-B", 30_000),
    ]);

    const aLeased = a._unsafeUnwrap();
    const bLeased = b._unsafeUnwrap();
    const winners = [aLeased, bLeased].filter((j) => j !== null);

    expect(winners).toHaveLength(1);
  });

  it("a lease whose lockedUntil has expired is re-leasable", async () => {
    const repo = await setupRepo();

    await repo.enqueue(buildEnqueueInput({ eventId: "evt-expired" }));

    // Acquire with a tiny lease window so it expires almost immediately.
    const first = (await repo.lease("worker-A", 1))._unsafeUnwrap();

    expect(first).not.toBeNull();

    // Wait long enough for the lease to expire.
    await new Promise((r) => setTimeout(r, 30));

    const second = (await repo.lease("worker-B", 30_000))._unsafeUnwrap();

    expect(second).not.toBeNull();
    expect(second?.id).toBe(first?.id);
    expect(second?.lockedBy).toBe("worker-B");
  });
});

describe("MongodbOutboundQueueRepo — complete", () => {
  it("removes the leased job from the queue", async () => {
    const repo = await setupRepo();
    const enqueued = (
      await repo.enqueue(buildEnqueueInput({ eventId: "evt-complete" }))
    )._unsafeUnwrap();

    (await repo.lease("worker-A", 30_000))._unsafeUnwrap();
    (await repo.complete(enqueued.id))._unsafeUnwrap();

    const remaining = (await repo.peek({}))._unsafeUnwrap();

    expect(remaining).toHaveLength(0);
  });
});

describe("MongodbOutboundQueueRepo — releaseWithBackoff", () => {
  it("clears the lock and updates attempts + nextAttemptAt", async () => {
    const repo = await setupRepo();
    const enqueued = (
      await repo.enqueue(buildEnqueueInput({ eventId: "evt-backoff" }))
    )._unsafeUnwrap();

    (await repo.lease("worker-A", 30_000))._unsafeUnwrap();

    const target = new Date(Date.now() + 60_000);

    (await repo.releaseWithBackoff(enqueued.id, 3, target))._unsafeUnwrap();

    const all = (await repo.peek({}))._unsafeUnwrap();
    const job = all[0]!;

    expect(job.attempts).toBe(3);
    expect(job.nextAttemptAt.getTime()).toBe(target.getTime());
    expect(job.lockedBy).toBeUndefined();
    expect(job.lockedUntil).toBeUndefined();
  });
});

describe("Worker — happy path", () => {
  it("invokes the registered handler and removes the job on success", async () => {
    const repo = await setupRepo();
    const { startWorker, stopWorker } = await import("../../worker");

    const handler = vi.fn().mockResolvedValue(undefined);

    await repo.enqueue(
      buildEnqueueInput({ eventId: "evt-worker-1", eventType: "customer.created" }),
    );

    startWorker(
      {
        handlers: { "customer.created": handler },
      },
      {
        repo,
        pollIntervalMs: 5,
        leaseMs: 5_000,
        workerId: "test-worker",
      },
    );

    // Wait for the handler to be invoked.
    await waitFor(() => expect(handler).toHaveBeenCalledTimes(1));

    await stopWorker();

    const remaining = (await repo.peek({}))._unsafeUnwrap();

    expect(remaining).toHaveLength(0);
    expect(handler).toHaveBeenCalledWith(
      expect.objectContaining({
        eventType: "customer.created",
        eventId: "evt-worker-1",
        payload: { foo: "bar" },
      }),
    );
  });
});

describe("Worker — retry with exponential backoff", () => {
  it("on handler failure, increments attempts and schedules next attempt with backoff", async () => {
    const repo = await setupRepo();
    const { startWorker, stopWorker } = await import("../../worker");

    const handler = vi.fn().mockRejectedValue(new Error("transient"));

    const enqueued = (
      await repo.enqueue(
        buildEnqueueInput({ eventId: "evt-worker-retry", eventType: "customer.updated" }),
      )
    )._unsafeUnwrap();

    startWorker(
      {
        handlers: { "customer.updated": handler },
        webhookLogRepo: undefined,
      },
      {
        repo,
        pollIntervalMs: 5,
        leaseMs: 5_000,
        workerId: "test-worker",
      },
    );

    await waitFor(() => expect(handler).toHaveBeenCalledTimes(1));

    await stopWorker();

    // Wait for release to land before peek (releaseWithBackoff happens after the handler resolves).
    await waitFor(async () => {
      const all = (await repo.peek({}))._unsafeUnwrap();

      expect(all[0]?.attempts).toBe(1);
    });

    const all = (await repo.peek({}))._unsafeUnwrap();
    const job = all[0]!;

    expect(job.id).toBe(enqueued.id);
    expect(job.attempts).toBe(1);
    expect(job.lockedBy).toBeUndefined();
    expect(job.nextAttemptAt.getTime()).toBeGreaterThan(Date.now() - 100);
  });
});

describe("Worker — DLQ handoff at max attempts", () => {
  it("on the 6th failure, hands off to T11's DLQ via webhookLogRepo and removes from queue", async () => {
    const repo = await setupRepo();
    const { startWorker, stopWorker } = await import("../../worker");
    const { MongodbWebhookLogRepo } = await import(
      "@/modules/webhook-log/repositories/mongodb/mongodb-webhook-log-repo"
    );
    const { MongodbDlqRepo } = await import("@/modules/dlq/repositories/mongodb/mongodb-dlq-repo");
    const { registerWebhookLogAndDlqMigrations } = await import("@/modules/webhook-log/migrations");
    const { runMigrations } = await import("@/modules/db/migration-runner");

    // T11 migration registers under a different version, so it co-exists with T52's "006".
    registerWebhookLogAndDlqMigrations();
    await runMigrations();

    const webhookLogRepo = new MongodbWebhookLogRepo();
    const dlqRepo = new MongodbDlqRepo();
    const handler = vi.fn().mockRejectedValue(new Error("permanent"));

    // Enqueue once, but pre-set attempts=5 so the next failure is the 6th (terminal).
    const enqueued = (
      await repo.enqueue(buildEnqueueInput({ eventId: "evt-dlq", eventType: "order.updated" }))
    )._unsafeUnwrap();

    (await repo.releaseWithBackoff(enqueued.id, 5, new Date(Date.now() - 1)))._unsafeUnwrap();

    startWorker(
      {
        handlers: { "order.updated": handler },
        webhookLogRepo,
      },
      {
        repo,
        pollIntervalMs: 5,
        leaseMs: 5_000,
        workerId: "test-worker",
        maxAttempts: 6,
      },
    );

    await waitFor(() => expect(handler).toHaveBeenCalledTimes(1));

    await waitFor(async () => {
      const remaining = (await repo.peek({}))._unsafeUnwrap();

      expect(remaining).toHaveLength(0);
    });

    await stopWorker();

    // The job is gone from the queue.
    const queueRemaining = (await repo.peek({}))._unsafeUnwrap();

    expect(queueRemaining).toHaveLength(0);

    // The DLQ has a row tied to the original eventId.
    const dlqList = (await dlqRepo.list({ saleorApiUrl: SALEOR_API_URL }))._unsafeUnwrap();

    expect(dlqList).toHaveLength(1);
    expect(dlqList[0]?.eventId).toBe("evt-dlq");
    expect(dlqList[0]?.status).toBe("dead");
    expect(dlqList[0]?.attempts).toBe(6);
  });
});

describe("Worker — stopWorker halts the loop cleanly", () => {
  it("after stopWorker resolves, no further handler invocations occur", async () => {
    const repo = await setupRepo();
    const { startWorker, stopWorker } = await import("../../worker");

    const handler = vi.fn().mockResolvedValue(undefined);

    await repo.enqueue(buildEnqueueInput({ eventId: "evt-stop-1", eventType: "customer.created" }));

    startWorker(
      {
        handlers: { "customer.created": handler },
      },
      {
        repo,
        pollIntervalMs: 5,
        leaseMs: 5_000,
        workerId: "test-worker",
      },
    );

    await waitFor(() => expect(handler).toHaveBeenCalledTimes(1));

    await stopWorker();

    const callsAfterStop = handler.mock.calls.length;

    // Enqueue a second job after stop — it should NOT be processed.
    await repo.enqueue(buildEnqueueInput({ eventId: "evt-stop-2", eventType: "customer.created" }));

    await new Promise((r) => setTimeout(r, 80));

    expect(handler.mock.calls.length).toBe(callsAfterStop);

    const remaining = (await repo.peek({}))._unsafeUnwrap();

    expect(remaining).toHaveLength(1);
    expect(remaining[0]?.eventId).toBe("evt-stop-2");
  });
});

/**
 * Poll until `assertion` passes (or 2-second timeout). Used in worker
 * tests because the worker loop runs on its own polling cadence and we
 * don't want flaky `setTimeout(N)` assertions.
 */
async function waitFor(assertion: () => void | Promise<void>, timeoutMs = 2000): Promise<void> {
  const start = Date.now();

  while (true) {
    try {
      await assertion();

      return;
    } catch (err) {
      if (Date.now() - start > timeoutMs) {
        throw err;
      }
      await new Promise((r) => setTimeout(r, 10));
    }
  }
}
