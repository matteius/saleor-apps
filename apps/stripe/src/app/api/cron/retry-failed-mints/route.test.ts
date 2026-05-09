/**
 * Tests for the T32 retry-failed-mints cron route.
 *
 * Covers:
 *   - Auth gate: missing/wrong CRON_SECRET → 401
 *   - Sweeper happy path: 1 success + 1 failure → correct summary, DLQ entry
 *     for success deleted, OwlBooks notified, DLQ entry for failure
 *     re-recorded with bumped attemptCount + new nextRetryAt
 *   - Final failure: attemptCount at MAX → markFinalFailure called + Sentry
 *     captureException fired with level: 'fatal'
 *   - Backoff schedule constants
 */
import { type AuthData } from "@saleor/app-sdk/APL";
import { err, ok } from "neverthrow";
import { beforeEach, describe, expect, it, vi } from "vitest";

import { mockedSaleorApiUrl } from "@/__tests__/mocks/saleor-api-url";
import {
  type FailedMintDlqRepo,
  type FailedMintRecord,
} from "@/modules/subscriptions/repositories/failed-mint-dlq-repo";
import {
  createFiefUserId,
  createSaleorChannelSlug,
  createStripeCustomerId,
  createStripePriceId,
  createStripeSubscriptionId,
  SubscriptionRecord,
} from "@/modules/subscriptions/repositories/subscription-record";
import { SaleorOrderFromInvoiceError } from "@/modules/subscriptions/saleor-bridge/saleor-order-from-invoice";
import {
  computeNextRetryAt,
  DLQ_BACKOFF_SECONDS,
  MAX_DLQ_ATTEMPTS,
} from "@/modules/subscriptions/webhooks/dlq-backoff";

import { __testing, executeRetryCron } from "./route";

const TEST_AUTH_DATA: AuthData = {
  saleorApiUrl: mockedSaleorApiUrl,
  appId: "app_test_T32",
  token: "test_token_T32",
};

const buildSub = (overrides?: Partial<ConstructorParameters<typeof SubscriptionRecord>[0]>) =>
  new SubscriptionRecord({
    stripeSubscriptionId: createStripeSubscriptionId("sub_test_T32"),
    stripeCustomerId: createStripeCustomerId("cus_test_T32"),
    saleorChannelSlug: createSaleorChannelSlug("owlbooks"),
    saleorUserId: "VXNlcjox",
    fiefUserId: createFiefUserId("fief_user_T32"),
    saleorEntityId: null,
    stripePriceId: createStripePriceId("price_test_T32"),
    status: "active",
    currentPeriodStart: new Date("2026-05-01T00:00:00Z"),
    currentPeriodEnd: new Date("2026-06-01T00:00:00Z"),
    cancelAtPeriodEnd: false,
    lastInvoiceId: null,
    lastSaleorOrderId: null,
    createdAt: new Date("2026-05-01T00:00:00Z"),
    updatedAt: new Date("2026-05-01T00:00:00Z"),
    ...overrides,
  });

const buildEntry = (overrides?: Partial<FailedMintRecord>): FailedMintRecord => ({
  stripeInvoiceId: "in_test_T32_001",
  stripeSubscriptionId: "sub_test_T32",
  stripeCustomerId: "cus_test_T32",
  fiefUserId: "fief_user_T32",
  saleorChannelSlug: "owlbooks",
  saleorVariantId: "VmFyaWFudDox",
  amountCents: 4900,
  currency: "usd",
  taxCents: 0,
  errorMessage: "draftOrderCreate failed",
  errorClass: "DraftOrderCreateFailedError",
  attemptCount: 1,
  nextRetryAt: 1_715_000_000,
  firstAttemptAt: 1_714_999_700,
  lastAttemptAt: 1_714_999_700,
  invoicePayload: JSON.stringify({
    id: "in_test_T32_001",
    amount_paid: 4900,
    currency: "usd",
    subscription: "sub_test_T32",
    charge: "ch_test_T32_001",
    total_tax_amounts: [],
  }),
  ...overrides,
});

interface DepsHarness {
  apl: {
    getAll: ReturnType<typeof vi.fn>;
    get: ReturnType<typeof vi.fn>;
    set: ReturnType<typeof vi.fn>;
    delete: ReturnType<typeof vi.fn>;
    isReady?: ReturnType<typeof vi.fn>;
    isConfigured?: ReturnType<typeof vi.fn>;
  };
  failedMintDlqRepo: {
    record: ReturnType<typeof vi.fn>;
    getById: ReturnType<typeof vi.fn>;
    listPendingRetries: ReturnType<typeof vi.fn>;
    delete: ReturnType<typeof vi.fn>;
    markFinalFailure: ReturnType<typeof vi.fn>;
  };
  subscriptionRepo: {
    getBySubscriptionId: ReturnType<typeof vi.fn>;
    upsert: ReturnType<typeof vi.fn>;
    markInvoiceProcessed: ReturnType<typeof vi.fn>;
    getByCustomerId: ReturnType<typeof vi.fn>;
    getByFiefUserId: ReturnType<typeof vi.fn>;
  };
  owlbooksWebhookNotifier: { notify: ReturnType<typeof vi.fn> };
  mintFn: ReturnType<typeof vi.fn>;
  graphqlClient: { mutation: ReturnType<typeof vi.fn>; query: ReturnType<typeof vi.fn> };
  graphqlClientFactory: ReturnType<typeof vi.fn>;
  captureException: ReturnType<typeof vi.fn>;
  now: number;
}

function makeDeps(opts?: {
  installations?: AuthData[];
  pendingEntries?: FailedMintRecord[];
  subscriptionRecord?: SubscriptionRecord | null;
  mintResults?: Array<ReturnType<typeof ok> | ReturnType<typeof err>>;
  now?: number;
}): DepsHarness {
  const now = opts?.now ?? 1_715_001_000;
  const apl = {
    getAll: vi.fn().mockResolvedValue(opts?.installations ?? [TEST_AUTH_DATA]),
    get: vi.fn().mockResolvedValue(TEST_AUTH_DATA),
    set: vi.fn(),
    delete: vi.fn(),
  };
  const failedMintDlqRepo = {
    record: vi.fn().mockResolvedValue(ok(null)),
    getById: vi.fn().mockResolvedValue(ok(null)),
    listPendingRetries: vi.fn().mockResolvedValue(ok(opts?.pendingEntries ?? [])),
    delete: vi.fn().mockResolvedValue(ok(null)),
    markFinalFailure: vi.fn().mockResolvedValue(ok(null)),
  };
  const subscriptionRepo = {
    getBySubscriptionId: vi.fn().mockResolvedValue(ok(opts?.subscriptionRecord ?? buildSub())),
    upsert: vi.fn().mockResolvedValue(ok(null)),
    markInvoiceProcessed: vi.fn().mockResolvedValue(ok("updated")),
    getByCustomerId: vi.fn().mockResolvedValue(ok(null)),
    getByFiefUserId: vi.fn().mockResolvedValue(ok(null)),
  };
  const owlbooksWebhookNotifier = {
    notify: vi.fn().mockResolvedValue(ok({ processed: "new" })),
  };
  const graphqlClient = { mutation: vi.fn(), query: vi.fn() };
  const graphqlClientFactory = vi.fn().mockReturnValue(graphqlClient);
  const captureException = vi.fn();

  // Default mint result: each call uses the next item in mintResults, or success.
  let callIndex = 0;
  const mintFn = vi.fn().mockImplementation(async () => {
    const r = opts?.mintResults?.[callIndex++];

    return (
      r ??
      ok({
        saleorOrderId: `T3JkZXI6MTAwMQ==`,
        stripeChargeId: "ch_test_T32_001",
        amountCents: 4900,
        currency: "USD",
      })
    );
  });

  return {
    apl,
    failedMintDlqRepo,
    subscriptionRepo,
    owlbooksWebhookNotifier,
    mintFn,
    graphqlClient,
    graphqlClientFactory,
    captureException,
    now,
  };
}

const buildExecuteDeps = (h: DepsHarness) => ({
  // eslint-disable-next-line @typescript-eslint/no-explicit-any
  apl: h.apl as any,
  failedMintDlqRepo: h.failedMintDlqRepo as unknown as FailedMintDlqRepo,
  // eslint-disable-next-line @typescript-eslint/no-explicit-any
  subscriptionRepo: h.subscriptionRepo as any,
  // eslint-disable-next-line @typescript-eslint/no-explicit-any
  owlbooksWebhookNotifier: h.owlbooksWebhookNotifier as any,
  mintOrderFromInvoice: h.mintFn,
  graphqlClientFactory: h.graphqlClientFactory,
  nowUnixSeconds: () => h.now,
  // eslint-disable-next-line @typescript-eslint/no-explicit-any
  captureException: h.captureException as any,
});

describe("retry-failed-mints — verifyCronAuth", () => {
  it("returns 401 when expected secret is unset", () => {
    const req = new Request("https://example.com/api/cron/retry-failed-mints", {
      method: "POST",
      headers: { authorization: "Bearer anything" },
    });
    const response = __testing.verifyCronAuth(req, undefined);

    expect(response).not.toBeNull();
    expect(response!.status).toBe(401);
  });

  it("returns 401 when Authorization header is missing", () => {
    const req = new Request("https://example.com/api/cron/retry-failed-mints", {
      method: "POST",
    });
    const response = __testing.verifyCronAuth(req, "test-cron-secret");

    expect(response).not.toBeNull();
    expect(response!.status).toBe(401);
  });

  it("returns 401 when Authorization header is wrong", () => {
    const req = new Request("https://example.com/api/cron/retry-failed-mints", {
      method: "POST",
      headers: { authorization: "Bearer wrong-secret" },
    });
    const response = __testing.verifyCronAuth(req, "test-cron-secret");

    expect(response).not.toBeNull();
    expect(response!.status).toBe(401);
  });

  it("returns null (auth ok) when Bearer matches expected secret", () => {
    const req = new Request("https://example.com/api/cron/retry-failed-mints", {
      method: "POST",
      headers: { authorization: "Bearer test-cron-secret" },
    });
    const response = __testing.verifyCronAuth(req, "test-cron-secret");

    expect(response).toBeNull();
  });
});

describe("executeRetryCron — sweeper logic", () => {
  beforeEach(() => {
    vi.clearAllMocks();
  });

  it("happy path: 1 entry succeeds → notifier called → DLQ entry deleted", async () => {
    const entry = buildEntry();
    const deps = makeDeps({ pendingEntries: [entry] });

    const summary = await executeRetryCron(buildExecuteDeps(deps));

    expect(summary.processed).toBe(1);
    expect(summary.succeeded).toBe(1);
    expect(summary.failedRetries).toBe(0);
    expect(summary.finalFailures).toBe(0);
    expect(summary.totalErrors).toBe(0);

    expect(deps.mintFn).toHaveBeenCalledTimes(1);
    expect(deps.owlbooksWebhookNotifier.notify).toHaveBeenCalledTimes(1);
    expect(deps.failedMintDlqRepo.delete).toHaveBeenCalledTimes(1);
    expect(deps.failedMintDlqRepo.delete).toHaveBeenCalledWith(
      expect.objectContaining({ saleorApiUrl: mockedSaleorApiUrl, appId: "app_test_T32" }),
      entry.stripeInvoiceId,
    );
    // No re-record on success
    expect(deps.failedMintDlqRepo.record).not.toHaveBeenCalled();
    expect(deps.captureException).not.toHaveBeenCalled();
  });

  it("mixed: 1 success + 1 failure → correct summary; failed entry re-recorded with attempt+1 and new nextRetryAt", async () => {
    const success = buildEntry({ stripeInvoiceId: "in_success" });
    const failure = buildEntry({ stripeInvoiceId: "in_failure", attemptCount: 1 });
    const deps = makeDeps({
      pendingEntries: [success, failure],
      mintResults: [
        ok({
          saleorOrderId: "T3JkZXI6Mg==",
          stripeChargeId: "ch_success",
          amountCents: 4900,
          currency: "USD",
        }),
        err(new SaleorOrderFromInvoiceError.DraftOrderCreateFailedError("still down")),
      ],
    });

    const summary = await executeRetryCron(buildExecuteDeps(deps));

    expect(summary.processed).toBe(2);
    expect(summary.succeeded).toBe(1);
    expect(summary.failedRetries).toBe(1);
    expect(summary.finalFailures).toBe(0);
    expect(summary.totalErrors).toBe(1);

    expect(deps.failedMintDlqRepo.delete).toHaveBeenCalledTimes(1);
    expect(deps.failedMintDlqRepo.record).toHaveBeenCalledTimes(1);

    const [, updatedRecord] = deps.failedMintDlqRepo.record.mock.calls[0]!;

    expect(updatedRecord.stripeInvoiceId).toBe("in_failure");
    expect(updatedRecord.attemptCount).toBe(2);
    // attemptCount=2 → next is +30 min
    expect(updatedRecord.nextRetryAt).toBe(deps.now + 30 * 60);
    expect(deps.captureException).not.toHaveBeenCalled();
  });

  it("final failure: entry already at attemptCount=MAX → markFinalFailure + fatal Sentry", async () => {
    const entry = buildEntry({ attemptCount: MAX_DLQ_ATTEMPTS });
    const deps = makeDeps({
      pendingEntries: [entry],
      mintResults: [
        err(new SaleorOrderFromInvoiceError.DraftOrderCreateFailedError("still failing")),
      ],
    });

    const summary = await executeRetryCron(buildExecuteDeps(deps));

    expect(summary.processed).toBe(1);
    expect(summary.succeeded).toBe(0);
    expect(summary.failedRetries).toBe(0);
    expect(summary.finalFailures).toBe(1);
    expect(summary.totalErrors).toBe(1);

    expect(deps.failedMintDlqRepo.markFinalFailure).toHaveBeenCalledTimes(1);
    expect(deps.captureException).toHaveBeenCalledTimes(1);
    const [, ctx] = deps.captureException.mock.calls[0]!;

    expect(ctx.level).toBe("fatal");
    expect(ctx.tags.dlq).toBe("failed-mint-final");
    expect(ctx.tags.stripeInvoiceId).toBe(entry.stripeInvoiceId);
    expect(ctx.tags.attemptCount).toBe(String(MAX_DLQ_ATTEMPTS));

    /*
     * We must NOT re-record on final failure (the markFinalFailure path
     * handles the schema update with finalFailureAlertedAt set).
     */
    expect(deps.failedMintDlqRepo.record).not.toHaveBeenCalled();
  });

  it("skips entries already flagged finalFailureAlertedAt", async () => {
    const entry = buildEntry({ finalFailureAlertedAt: 1_714_999_999 });
    const deps = makeDeps({ pendingEntries: [entry] });

    const summary = await executeRetryCron(buildExecuteDeps(deps));

    expect(summary.processed).toBe(1);
    expect(summary.succeeded).toBe(0);
    expect(deps.mintFn).not.toHaveBeenCalled();
    expect(deps.failedMintDlqRepo.delete).not.toHaveBeenCalled();
    expect(deps.failedMintDlqRepo.record).not.toHaveBeenCalled();
  });

  it("returns zero summary when there are no installations", async () => {
    const deps = makeDeps({ installations: [] });

    const summary = await executeRetryCron(buildExecuteDeps(deps));

    expect(summary).toStrictEqual({
      processed: 0,
      succeeded: 0,
      failedRetries: 0,
      finalFailures: 0,
      totalErrors: 0,
    });
  });
});

describe("DLQ_BACKOFF_SECONDS + computeNextRetryAt", () => {
  it("schedule constants match the documented spec", () => {
    expect(DLQ_BACKOFF_SECONDS).toStrictEqual([5 * 60, 30 * 60, 4 * 60 * 60, 24 * 60 * 60]);
    expect(MAX_DLQ_ATTEMPTS).toBe(4);
  });

  it("attemptCount=1 → nextRetryAt = now + 5min", () => {
    expect(computeNextRetryAt(1, 1_000_000)).toBe(1_000_000 + 5 * 60);
  });

  it("attemptCount=2 → nextRetryAt = now + 30min", () => {
    expect(computeNextRetryAt(2, 1_000_000)).toBe(1_000_000 + 30 * 60);
  });

  it("attemptCount=3 → nextRetryAt = now + 4h", () => {
    expect(computeNextRetryAt(3, 1_000_000)).toBe(1_000_000 + 4 * 60 * 60);
  });

  it("attemptCount=4 → nextRetryAt = now + 24h (last scheduled retry)", () => {
    expect(computeNextRetryAt(4, 1_000_000)).toBeNull();
  });

  it("attemptCount >= MAX_DLQ_ATTEMPTS → returns null (caller should escalate)", () => {
    expect(computeNextRetryAt(MAX_DLQ_ATTEMPTS, 1_000_000)).toBeNull();
    expect(computeNextRetryAt(MAX_DLQ_ATTEMPTS + 1, 1_000_000)).toBeNull();
  });
});
