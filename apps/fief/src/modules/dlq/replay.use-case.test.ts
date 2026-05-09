/*
 * @vitest-environment node
 *
 * T51 — DLQ replay use case tests (TDD RED).
 *
 * Surface under test:
 *   - `DlqReplayUseCase.replay({ dlqEntryId })` orchestrates:
 *       1. Load DLQ entry (T11). Missing -> `not_found`.
 *       2. Load connection (T8). Soft-deleted -> `connection_deleted`
 *          (NOT removed from DLQ — T37 UI consumes this code to keep
 *          the row around so the operator can see it.)
 *       3. Branch on direction:
 *          - `fief_to_saleor` -> dispatch via T22's receiver path
 *            (eventRouter.dispatch under the hood).
 *          - `saleor_to_fief` -> enqueue via T52's outbound queue.
 *       4. Remove from DLQ on success.
 *       5. Record replay attempt in webhook_log.
 *
 * The use case is a small orchestrator — every collaborator is injected
 * so unit tests stay free of Mongo + HTTP. Each test asserts both the
 * `Result` shape and the relevant collaborator side-effects.
 */
import { err, ok, type Result } from "neverthrow";
import { afterEach, beforeEach, describe, expect, it, vi } from "vitest";

import { createLogger } from "@/lib/logger";
import { type DlqEntry, type DlqEntryId } from "@/modules/dlq/dlq";
import { type DlqNotFoundError, type DlqRepo, type DlqRepoError } from "@/modules/dlq/dlq-repo";
import {
  createProviderConnectionId,
  type ProviderConnection,
  type ProviderConnectionId,
} from "@/modules/provider-connections/provider-connection";
import {
  type ProviderConnectionRepo,
  ProviderConnectionRepoError,
} from "@/modules/provider-connections/provider-connection-repo";
import { type EnqueueJobInput, type QueueJob } from "@/modules/queue/queue";
import { type OutboundQueueRepo, type QueueRepoError } from "@/modules/queue/queue-repo";
import { createSaleorApiUrl, type SaleorApiUrl } from "@/modules/saleor/saleor-api-url";
import { type WebhookEventPayload } from "@/modules/sync/fief-to-saleor/event-router";
import {
  createWebhookEventId,
  createWebhookLogConnectionId,
  type WebhookLog,
  type WebhookLogId,
} from "@/modules/webhook-log/webhook-log";
import {
  type RecordWebhookLogInput,
  type WebhookLogRepo,
  type WebhookLogRepoError,
} from "@/modules/webhook-log/webhook-log-repo";

const SALEOR_API_URL_RAW = "https://shop-replay.saleor.cloud/graphql/";
const SALEOR_API_URL: SaleorApiUrl = createSaleorApiUrl(SALEOR_API_URL_RAW)._unsafeUnwrap();
const CONNECTION_UUID = "33333333-3333-4333-8333-333333333333";

/*
 * Mocks for the protected-client-procedure auth chain. Module-scoped so
 * Vitest hoists `vi.mock(...)` correctly. Same seam as
 * `protected-client-procedure.test.ts` so tests stay isolated from JWT
 * verification + APL backends.
 */
const verifyJWTMock = vi.fn();
const aplGetMock = vi.fn();

vi.mock("@saleor/app-sdk/auth", () => ({
  verifyJWT: (...args: unknown[]) => verifyJWTMock(...args),
}));

vi.mock("@/lib/saleor-app", () => ({
  saleorApp: {
    apl: {
      get: (...args: unknown[]) => aplGetMock(...args),
    },
  },
}));

// ---------- Test doubles ----------

const buildDlqEntry = (overrides?: Partial<DlqEntry>): DlqEntry => ({
  id: "dlq-id-1" as unknown as DlqEntryId,
  saleorApiUrl: SALEOR_API_URL,
  connectionId: createWebhookLogConnectionId(CONNECTION_UUID)._unsafeUnwrap(),
  direction: "fief_to_saleor",
  eventId: createWebhookEventId("event-1")._unsafeUnwrap(),
  eventType: "user.created",
  status: "dead",
  attempts: 6,
  lastError: "boom",
  payloadRedacted: { id: "fief-user-1", email: "u@example.com" },
  createdAt: new Date("2026-05-01T00:00:00Z"),
  movedToDlqAt: new Date("2026-05-01T00:05:00Z"),
  ...(overrides ?? {}),
});

const buildConnection = (overrides?: Partial<ProviderConnection>): ProviderConnection => {
  /*
   * We don't need a fully-populated entity here — only `softDeletedAt`
   * matters for the use case's branching. Cast through `unknown` to keep
   * the test fixtures terse without importing every branded helper.
   */
  return {
    id: createProviderConnectionId(CONNECTION_UUID),
    saleorApiUrl: SALEOR_API_URL,
    softDeletedAt: null,
    ...(overrides ?? {}),
  } as unknown as ProviderConnection;
};

interface RepoStubs {
  dlqRepo: {
    repo: DlqRepo;
    delete: ReturnType<typeof vi.fn>;
    getById: ReturnType<typeof vi.fn>;
  };
  webhookLogRepo: {
    repo: WebhookLogRepo;
    record: ReturnType<typeof vi.fn>;
  };
  providerConnectionRepo: {
    repo: ProviderConnectionRepo;
    get: ReturnType<typeof vi.fn>;
  };
  fiefReceiver: {
    receiver: { dispatch: (payload: WebhookEventPayload) => Promise<Result<unknown, never>> };
    dispatch: ReturnType<typeof vi.fn>;
  };
  outboundQueue: {
    queue: Pick<OutboundQueueRepo, "enqueue">;
    enqueue: ReturnType<typeof vi.fn>;
  };
}

type DlqGetByIdImpl = (
  id: DlqEntryId,
) => Promise<Result<DlqEntry | null, InstanceType<typeof DlqRepoError>>>;
type DlqDeleteImpl = (
  id: DlqEntryId,
) => Promise<Result<void, InstanceType<typeof DlqRepoError | typeof DlqNotFoundError>>>;
type WebhookLogRecordImpl = (
  input: RecordWebhookLogInput,
) => Promise<Result<WebhookLog, InstanceType<typeof WebhookLogRepoError>>>;
type ProviderConnectionGetImpl = (access: {
  saleorApiUrl: SaleorApiUrl;
  id: ProviderConnectionId;
  includeSoftDeleted?: boolean;
}) => Promise<
  Result<
    ProviderConnection,
    | InstanceType<(typeof ProviderConnectionRepoError)["NotFound"]>
    | InstanceType<(typeof ProviderConnectionRepoError)["FailureFetching"]>
  >
>;
type ReceiverDispatchImpl = (payload: WebhookEventPayload) => Promise<Result<unknown, never>>;
type QueueEnqueueImpl = (
  input: EnqueueJobInput,
) => Promise<Result<QueueJob, InstanceType<typeof QueueRepoError>>>;

const buildStubs = (overrides?: {
  dlqGetById?: DlqGetByIdImpl;
  dlqDelete?: DlqDeleteImpl;
  webhookLogRecord?: WebhookLogRecordImpl;
  providerConnectionGet?: ProviderConnectionGetImpl;
  receiverDispatch?: ReceiverDispatchImpl;
  queueEnqueue?: QueueEnqueueImpl;
}): RepoStubs => {
  const dlqGetById = vi.fn<DlqGetByIdImpl>(
    overrides?.dlqGetById ?? (async () => ok(buildDlqEntry())),
  );
  const dlqDelete = vi.fn<DlqDeleteImpl>(overrides?.dlqDelete ?? (async () => ok(undefined)));
  const webhookLogRecord = vi.fn<WebhookLogRecordImpl>(
    overrides?.webhookLogRecord ??
      (async () => ok({ id: "log-id-1" as unknown as WebhookLogId } as WebhookLog)),
  );
  const providerConnectionGet = vi.fn<ProviderConnectionGetImpl>(
    overrides?.providerConnectionGet ?? (async () => ok(buildConnection())),
  );
  const receiverDispatch = vi.fn<ReceiverDispatchImpl>(
    overrides?.receiverDispatch ??
      (async () => ok({ kind: "dispatched" as const, eventType: "user.created" })),
  );
  const queueEnqueue = vi.fn<QueueEnqueueImpl>(
    overrides?.queueEnqueue ?? (async () => ok({ id: "job-id-1" } as unknown as QueueJob)),
  );

  return {
    dlqRepo: {
      delete: dlqDelete,
      getById: dlqGetById,
      repo: {
        add: async () => {
          throw new Error("dlqRepo.add must not be called from replay");
        },
        list: async () => {
          throw new Error("dlqRepo.list must not be called from replay");
        },
        getById: ((id: DlqEntryId) => dlqGetById(id)) as DlqRepo["getById"],
        delete: ((id: DlqEntryId) => dlqDelete(id)) as DlqRepo["delete"],
      },
    },
    webhookLogRepo: {
      record: webhookLogRecord,
      repo: {
        record: ((input: RecordWebhookLogInput) =>
          webhookLogRecord(input)) as WebhookLogRepo["record"],
        dedupCheck: async () => {
          throw new Error("dedupCheck not used in replay");
        },
        recordAttempt: async () => {
          throw new Error("recordAttempt not used in replay");
        },
        moveToDlq: async () => {
          throw new Error("moveToDlq not used in replay");
        },
        list: async () => {
          throw new Error("list not used in replay");
        },
        getById: async () => {
          throw new Error("getById not used in replay");
        },
      },
    },
    providerConnectionRepo: {
      get: providerConnectionGet,
      repo: {
        create: async () => {
          throw new Error("create not used in replay");
        },
        get: ((access: { saleorApiUrl: SaleorApiUrl; id: ProviderConnectionId }) =>
          providerConnectionGet(access)) as ProviderConnectionRepo["get"],
        list: async () => {
          throw new Error("list not used in replay");
        },
        update: async () => {
          throw new Error("update not used in replay");
        },
        softDelete: async () => {
          throw new Error("softDelete not used in replay");
        },
        restore: async () => {
          throw new Error("restore not used in replay");
        },
        getDecryptedSecrets: async () => {
          throw new Error("getDecryptedSecrets not used in replay");
        },
      },
    },
    fiefReceiver: {
      dispatch: receiverDispatch,
      receiver: {
        dispatch: (payload: WebhookEventPayload) =>
          receiverDispatch(payload) as Promise<Result<unknown, never>>,
      },
    },
    outboundQueue: {
      enqueue: queueEnqueue,
      queue: {
        enqueue: ((input: EnqueueJobInput) => queueEnqueue(input)) as OutboundQueueRepo["enqueue"],
      },
    },
  };
};

const buildUseCase = async (stubs: RepoStubs) => {
  const { DlqReplayUseCase } = await import("./replay.use-case");

  return new DlqReplayUseCase({
    dlqRepo: stubs.dlqRepo.repo,
    webhookLogRepo: stubs.webhookLogRepo.repo,
    providerConnectionRepo: stubs.providerConnectionRepo.repo,
    fiefReceiver: stubs.fiefReceiver.receiver,
    outboundQueue: stubs.outboundQueue.queue,
    logger: createLogger("test.dlq.replay"),
  });
};

afterEach(() => {
  vi.restoreAllMocks();
});

describe("DlqReplayUseCase — T51", () => {
  describe("not-found path", () => {
    it("returns not_found when DLQ entry id does not exist", async () => {
      const stubs = buildStubs({ dlqGetById: async () => ok(null) });
      const useCase = await buildUseCase(stubs);

      const result = await useCase.replay({
        dlqEntryId: "missing" as unknown as DlqEntryId,
      });

      expect(result.isErr()).toBe(true);
      const error = result._unsafeUnwrapErr();

      expect(error.code).toBe("not_found");
      expect(stubs.dlqRepo.delete).not.toHaveBeenCalled();
      expect(stubs.fiefReceiver.dispatch).not.toHaveBeenCalled();
      expect(stubs.outboundQueue.enqueue).not.toHaveBeenCalled();
      expect(stubs.webhookLogRepo.record).not.toHaveBeenCalled();
    });
  });

  describe("connection-deleted path", () => {
    it("returns connection_deleted when the bound connection is soft-deleted (does NOT remove from DLQ)", async () => {
      const stubs = buildStubs({
        providerConnectionGet: async () =>
          ok(buildConnection({ softDeletedAt: new Date("2026-04-01T00:00:00Z") })),
      });
      const useCase = await buildUseCase(stubs);

      const result = await useCase.replay({
        dlqEntryId: "dlq-id-1" as unknown as DlqEntryId,
      });

      expect(result.isErr()).toBe(true);
      const error = result._unsafeUnwrapErr();

      expect(error.code).toBe("connection_deleted");
      // MUST NOT delete the DLQ row — operator UI keeps it visible.
      expect(stubs.dlqRepo.delete).not.toHaveBeenCalled();
      // MUST NOT replay through any sync path.
      expect(stubs.fiefReceiver.dispatch).not.toHaveBeenCalled();
      expect(stubs.outboundQueue.enqueue).not.toHaveBeenCalled();
    });

    it("returns connection_deleted when the connection lookup itself returns NotFound", async () => {
      const stubs = buildStubs({
        providerConnectionGet: async () => err(new ProviderConnectionRepoError.NotFound("gone")),
      });
      const useCase = await buildUseCase(stubs);

      const result = await useCase.replay({
        dlqEntryId: "dlq-id-1" as unknown as DlqEntryId,
      });

      expect(result.isErr()).toBe(true);
      const error = result._unsafeUnwrapErr();

      expect(error.code).toBe("connection_deleted");
      expect(stubs.dlqRepo.delete).not.toHaveBeenCalled();
    });
  });

  describe("fief_to_saleor direction", () => {
    it("dispatches via the receiver path on inbound DLQ entries", async () => {
      const stubs = buildStubs();
      const useCase = await buildUseCase(stubs);

      const result = await useCase.replay({
        dlqEntryId: "dlq-id-1" as unknown as DlqEntryId,
      });

      expect(result.isOk()).toBe(true);
      const value = result._unsafeUnwrap();

      expect(value.replayed).toBe(true);
      expect(value.direction).toBe("fief_to_saleor");
      expect(stubs.fiefReceiver.dispatch).toHaveBeenCalledTimes(1);

      /*
       * Receiver gets `{ type, data, eventId }` — taken from the DLQ row's
       * eventType + payloadRedacted + eventId.
       */
      const [payload] = stubs.fiefReceiver.dispatch.mock.calls[0] as [WebhookEventPayload];

      expect(payload.type).toBe("user.created");
      expect(payload.eventId).toBe("event-1");
      expect(payload.data).toMatchObject({ id: "fief-user-1", email: "u@example.com" });

      // Outbound queue NOT called for inbound entries.
      expect(stubs.outboundQueue.enqueue).not.toHaveBeenCalled();
    });
  });

  describe("saleor_to_fief direction", () => {
    it("re-enqueues via the outbound queue on outbound DLQ entries", async () => {
      const stubs = buildStubs({
        dlqGetById: async () =>
          ok(
            buildDlqEntry({
              direction: "saleor_to_fief",
              eventType: "customer.created",
              eventId: createWebhookEventId("saleor-event-1")._unsafeUnwrap(),
              payloadRedacted: { saleorApiUrl: SALEOR_API_URL_RAW, customer: { id: "c-1" } },
            }),
          ),
      });
      const useCase = await buildUseCase(stubs);

      const result = await useCase.replay({
        dlqEntryId: "dlq-id-1" as unknown as DlqEntryId,
      });

      expect(result.isOk()).toBe(true);
      const value = result._unsafeUnwrap();

      expect(value.replayed).toBe(true);
      expect(value.direction).toBe("saleor_to_fief");
      expect(stubs.outboundQueue.enqueue).toHaveBeenCalledTimes(1);

      const [enqueueInput] = stubs.outboundQueue.enqueue.mock.calls[0] as [EnqueueJobInput];

      expect(enqueueInput.eventType).toBe("customer.created");
      expect(enqueueInput.eventId as unknown as string).toBe("saleor-event-1");
      expect(enqueueInput.payload).toMatchObject({
        saleorApiUrl: SALEOR_API_URL_RAW,
        customer: { id: "c-1" },
      });

      // Receiver dispatch NOT called for outbound entries.
      expect(stubs.fiefReceiver.dispatch).not.toHaveBeenCalled();
    });
  });

  describe("post-replay bookkeeping", () => {
    it("removes the DLQ entry on successful inbound replay", async () => {
      const stubs = buildStubs();
      const useCase = await buildUseCase(stubs);

      const result = await useCase.replay({
        dlqEntryId: "dlq-id-1" as unknown as DlqEntryId,
      });

      expect(result.isOk()).toBe(true);
      expect(stubs.dlqRepo.delete).toHaveBeenCalledTimes(1);
      expect(stubs.dlqRepo.delete.mock.calls[0][0] as unknown as string).toBe("dlq-id-1");
    });

    it("removes the DLQ entry on successful outbound replay", async () => {
      const stubs = buildStubs({
        dlqGetById: async () =>
          ok(buildDlqEntry({ direction: "saleor_to_fief", eventType: "customer.created" })),
      });
      const useCase = await buildUseCase(stubs);

      const result = await useCase.replay({
        dlqEntryId: "dlq-id-1" as unknown as DlqEntryId,
      });

      expect(result.isOk()).toBe(true);
      expect(stubs.dlqRepo.delete).toHaveBeenCalledTimes(1);
    });

    it("records a replay attempt in webhook_log on success", async () => {
      const stubs = buildStubs();
      const useCase = await buildUseCase(stubs);

      const result = await useCase.replay({
        dlqEntryId: "dlq-id-1" as unknown as DlqEntryId,
      });

      expect(result.isOk()).toBe(true);
      expect(stubs.webhookLogRepo.record).toHaveBeenCalledTimes(1);

      const [recordInput] = stubs.webhookLogRepo.record.mock.calls[0] as [RecordWebhookLogInput];

      expect(recordInput.direction).toBe("fief_to_saleor");
      expect(recordInput.eventType).toBe("user.created");
      // The replay rebrands the original eventId.
      expect(recordInput.eventId as unknown as string).toContain("event-1");
      // Initial status reflects the immediate dispatch outcome.
      expect(recordInput.initialStatus).toBe("ok");
    });

    it("does NOT remove the DLQ entry when the replay step itself fails", async () => {
      const stubs = buildStubs({
        receiverDispatch: async () =>
          ok({
            kind: "failed" as const,
            eventType: "user.created",
            error: new Error("handler-boom"),
          }),
      });
      const useCase = await buildUseCase(stubs);

      const result = await useCase.replay({
        dlqEntryId: "dlq-id-1" as unknown as DlqEntryId,
      });

      expect(result.isErr()).toBe(true);
      expect(result._unsafeUnwrapErr().code).toBe("replay_failed");
      expect(stubs.dlqRepo.delete).not.toHaveBeenCalled();
    });

    it("does NOT remove the DLQ entry when outbound queue enqueue fails", async () => {
      const { QueueRepoError } = await import("@/modules/queue/queue-repo");
      const stubs = buildStubs({
        dlqGetById: async () =>
          ok(buildDlqEntry({ direction: "saleor_to_fief", eventType: "customer.created" })),
        queueEnqueue: async () => err(new QueueRepoError("boom")),
      });
      const useCase = await buildUseCase(stubs);

      const result = await useCase.replay({
        dlqEntryId: "dlq-id-1" as unknown as DlqEntryId,
      });

      expect(result.isErr()).toBe(true);
      expect(result._unsafeUnwrapErr().code).toBe("replay_failed");
      expect(stubs.dlqRepo.delete).not.toHaveBeenCalled();
    });
  });
});

describe("dlq tRPC sub-router (T51)", () => {
  const APP_ID = "app-id-test";
  const APP_TOKEN = "apl-app-token";

  const buildCtx = () => ({
    saleorApiUrl: SALEOR_API_URL_RAW,
    token: "frontend-jwt-mocked",
    appId: undefined as undefined | string,
    appUrl: null,
    logger: createLogger("test.dlq.router"),
  });

  const wireAuth = () => {
    aplGetMock.mockResolvedValue({
      saleorApiUrl: SALEOR_API_URL_RAW,
      appId: APP_ID,
      token: APP_TOKEN,
    });
    verifyJWTMock.mockResolvedValue(undefined);
  };

  beforeEach(() => {
    verifyJWTMock.mockReset();
    aplGetMock.mockReset();
  });

  it("rejects unauthenticated callers via protectedClientProcedure", async () => {
    aplGetMock.mockResolvedValueOnce(undefined);

    const { buildDlqRouter } = await import("./trpc-router");
    const stubs = buildStubs();
    const router = buildDlqRouter({
      useCase: {
        replay: vi.fn(async () =>
          ok({ replayed: true as const, direction: "fief_to_saleor" as const }),
        ),
      },
    });
    const caller = router.createCaller(buildCtx() as never);

    await expect(caller.replay({ dlqEntryId: "dlq-id-1" })).rejects.toMatchObject({
      code: "UNAUTHORIZED",
    });

    /*
     * Defensive: `stubs` is built so direct calls to repos throw — having
     * the caller fail at auth means we never reach the orchestrator and
     * never touch any repo.
     */
    void stubs;
  });

  it("invokes the use case and returns its successful payload", async () => {
    wireAuth();

    const replay = vi.fn(async () =>
      ok({ replayed: true as const, direction: "fief_to_saleor" as const }),
    );
    const { buildDlqRouter } = await import("./trpc-router");
    const router = buildDlqRouter({ useCase: { replay } });
    const caller = router.createCaller(buildCtx() as never);

    const result = await caller.replay({ dlqEntryId: "dlq-id-1" });

    expect(result).toStrictEqual({ replayed: true, direction: "fief_to_saleor" });
    expect(replay).toHaveBeenCalledWith({ dlqEntryId: "dlq-id-1" });
  });

  it("translates connection_deleted into PRECONDITION_FAILED with the explicit error code", async () => {
    wireAuth();

    const replay = vi.fn(async () =>
      err({ code: "connection_deleted" as const, message: "soft-deleted" }),
    );
    const { buildDlqRouter } = await import("./trpc-router");
    const router = buildDlqRouter({ useCase: { replay } });
    const caller = router.createCaller(buildCtx() as never);

    await expect(caller.replay({ dlqEntryId: "dlq-id-1" })).rejects.toMatchObject({
      code: "PRECONDITION_FAILED",
      message: expect.stringContaining("connection_deleted"),
    });
  });

  it("translates not_found into NOT_FOUND", async () => {
    wireAuth();

    const replay = vi.fn(async () => err({ code: "not_found" as const, message: "no such row" }));
    const { buildDlqRouter } = await import("./trpc-router");
    const router = buildDlqRouter({ useCase: { replay } });
    const caller = router.createCaller(buildCtx() as never);

    await expect(caller.replay({ dlqEntryId: "missing" })).rejects.toMatchObject({
      code: "NOT_FOUND",
    });
  });
});
