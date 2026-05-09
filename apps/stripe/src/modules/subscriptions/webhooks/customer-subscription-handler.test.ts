/**
 * RED-phase Vitest for T13 + T15 — `CustomerSubscriptionHandler`.
 *
 * Covers the three event handlers (`customer.subscription.{created,updated,
 * deleted}`) and the shared `mapStripeSubStatus` helper used by both
 * subtasks.
 *
 * The repo, notifier, and Stripe SDK types are mocked via `vi.fn()`. The
 * Stripe.Subscription literal payloads use the real type for compile-time
 * coverage of the field shape we depend on.
 */
import { err, ok } from "neverthrow";
import type Stripe from "stripe";
import { describe, expect, it, vi } from "vitest";

import { mockedStripeRestrictedKey } from "@/__tests__/mocks/mocked-stripe-restricted-key";
import { mockedSaleorApiUrl } from "@/__tests__/mocks/saleor-api-url";
import { BaseError } from "@/lib/errors";

import {
  NotifyError,
  type OwlBooksWebhookNotifier,
  type OwlBooksWebhookPayload,
} from "../notifiers/owlbooks-notifier";
import {
  createFiefUserId,
  createSaleorChannelSlug,
  createStripeCustomerId,
  createStripePriceId,
  createStripeSubscriptionId,
  SubscriptionRecord,
} from "../repositories/subscription-record";
import { type SubscriptionRepo } from "../repositories/subscription-repo";
import { CustomerSubscriptionHandler, mapStripeSubStatus } from "./customer-subscription-handler";
import { type SubscriptionWebhookContext } from "./subscription-webhook-use-case";

/*
 * ---------------------------------------------------------------------------
 * Helpers
 * ---------------------------------------------------------------------------
 */

const PERIOD_START = 1_700_000_000;
const PERIOD_END = 1_702_592_000;
const EVENT_CREATED = 1_700_010_000;

function buildContext(): SubscriptionWebhookContext {
  return {
    saleorApiUrl: mockedSaleorApiUrl,
    appId: "app_test_T13",
    stripeEnv: "TEST",
    restrictedKey: mockedStripeRestrictedKey,
  };
}

interface BuildSubArgs {
  id?: string;
  customer?: string;
  status?: Stripe.Subscription.Status;
  priceId?: string;
  cancelAtPeriodEnd?: boolean;
  fiefUserId?: string | null;
  saleorUserId?: string;
  saleorChannelSlug?: string;
  periodStart?: number;
  periodEnd?: number;
}

function buildSubscription(args: BuildSubArgs = {}): Stripe.Subscription {
  const metadata: Record<string, string> = {};

  if (args.fiefUserId !== null) {
    metadata.fiefUserId = args.fiefUserId ?? "fief_user_123";
  }
  if (args.saleorUserId !== undefined) {
    metadata.saleorUserId = args.saleorUserId;
  } else {
    metadata.saleorUserId = "saleor_user_abc";
  }
  if (args.saleorChannelSlug !== undefined) {
    metadata.saleorChannelSlug = args.saleorChannelSlug;
  } else {
    metadata.saleorChannelSlug = "default-channel";
  }

  return {
    id: args.id ?? "sub_T13_created",
    object: "subscription",
    customer: args.customer ?? "cus_T13_abc",
    status: args.status ?? "active",
    cancel_at_period_end: args.cancelAtPeriodEnd ?? false,
    metadata,
    items: {
      object: "list",
      data: [
        {
          id: "si_T13_item",
          object: "subscription_item",
          current_period_start: args.periodStart ?? PERIOD_START,
          current_period_end: args.periodEnd ?? PERIOD_END,
          price: {
            id: args.priceId ?? "price_T13_default",
            object: "price",
          },
        },
      ],
    },
  } as unknown as Stripe.Subscription;
}

function buildEvent<
  T extends
    | "customer.subscription.created"
    | "customer.subscription.updated"
    | "customer.subscription.deleted",
>(type: T, subscription: Stripe.Subscription): Stripe.Event {
  return {
    id: `evt_${type}`,
    object: "event",
    api_version: "2024-06-20",
    created: EVENT_CREATED,
    livemode: false,
    pending_webhooks: 0,
    request: { id: null, idempotency_key: null },
    type,
    data: { object: subscription },
  } as unknown as Stripe.Event;
}

interface Harness {
  handler: CustomerSubscriptionHandler;
  subscriptionRepo: {
    upsert: ReturnType<typeof vi.fn>;
    getBySubscriptionId: ReturnType<typeof vi.fn>;
    getByCustomerId: ReturnType<typeof vi.fn>;
    getByFiefUserId: ReturnType<typeof vi.fn>;
  };
  notifier: { notify: ReturnType<typeof vi.fn> };
}

function buildHarness(opts: { existingRecord?: SubscriptionRecord | null } = {}): Harness {
  const subscriptionRepo = {
    upsert: vi.fn().mockResolvedValue(ok(null)),
    getBySubscriptionId: vi.fn().mockResolvedValue(ok(null)),
    getByCustomerId: vi.fn().mockResolvedValue(ok(opts.existingRecord ?? null)),
    getByFiefUserId: vi.fn().mockResolvedValue(ok(null)),
  };

  const notifier: OwlBooksWebhookNotifier = {
    notify: vi.fn().mockResolvedValue(ok(undefined)),
  };

  const handler = new CustomerSubscriptionHandler({
    subscriptionRepo: subscriptionRepo as unknown as SubscriptionRepo,
    notifier,
  });

  return {
    handler,
    subscriptionRepo,
    notifier: notifier as unknown as Harness["notifier"],
  };
}

/*
 * ---------------------------------------------------------------------------
 * mapStripeSubStatus — table-driven
 * ---------------------------------------------------------------------------
 */

describe("mapStripeSubStatus", () => {
  it.each([
    ["incomplete", "INCOMPLETE"],
    ["incomplete_expired", "INCOMPLETE_EXPIRED"],
    ["trialing", "PENDING"],
    ["active", "ACTIVE"],
    ["past_due", "PAST_DUE"],
    ["canceled", "CANCELLED"],
    ["unpaid", "UNPAID"],
  ] as const)("maps Stripe status %s to local enum %s", (stripeStatus, expected) => {
    expect(mapStripeSubStatus(stripeStatus as Stripe.Subscription.Status)).toBe(expected);
  });
});

/*
 * ---------------------------------------------------------------------------
 * handleCreated — T13
 * ---------------------------------------------------------------------------
 */

describe("CustomerSubscriptionHandler.handleCreated (T13)", () => {
  it("happy path: parses, upserts via repo, notifies OwlBooks with subscription.created payload", async () => {
    const h = buildHarness();
    const ctx = buildContext();
    const sub = buildSubscription({
      id: "sub_HAPPY",
      customer: "cus_HAPPY",
      status: "incomplete",
      priceId: "price_growth_monthly",
    });
    const event = buildEvent("customer.subscription.created", sub);

    const result = await h.handler.handleCreated(
      event as Stripe.CustomerSubscriptionCreatedEvent,
      ctx,
    );

    expect(result.isOk()).toBe(true);

    expect(h.subscriptionRepo.getByCustomerId).toHaveBeenCalledTimes(1);
    expect(h.subscriptionRepo.upsert).toHaveBeenCalledTimes(1);

    const upsertCall = h.subscriptionRepo.upsert.mock.calls[0];
    const access = upsertCall[0];
    const record = upsertCall[1] as SubscriptionRecord;

    expect(access).toStrictEqual({ saleorApiUrl: ctx.saleorApiUrl, appId: ctx.appId });
    expect(record.stripeSubscriptionId).toBe("sub_HAPPY");
    expect(record.stripeCustomerId).toBe("cus_HAPPY");
    expect(record.stripePriceId).toBe("price_growth_monthly");
    expect(record.fiefUserId).toBe("fief_user_123");
    expect(record.saleorUserId).toBe("saleor_user_abc");
    expect(record.saleorChannelSlug).toBe("default-channel");
    expect(record.status).toBe("incomplete");
    expect(record.currentPeriodStart.toISOString()).toBe(
      new Date(PERIOD_START * 1000).toISOString(),
    );
    expect(record.currentPeriodEnd.toISOString()).toBe(new Date(PERIOD_END * 1000).toISOString());
    expect(record.cancelAtPeriodEnd).toBe(false);

    expect(h.notifier.notify).toHaveBeenCalledTimes(1);
    const payload = h.notifier.notify.mock.calls[0][0] as OwlBooksWebhookPayload;

    expect(payload.type).toBe("subscription.created");
    expect(payload.stripeSubscriptionId).toBe("sub_HAPPY");
    expect(payload.stripeCustomerId).toBe("cus_HAPPY");
    expect(payload.fiefUserId).toBe("fief_user_123");
    expect(payload.saleorUserId).toBe("saleor_user_abc");
    expect(payload.status).toBe("INCOMPLETE");
    expect(payload.stripePriceId).toBe("price_growth_monthly");
    expect(payload.currentPeriodStart).toBe(new Date(PERIOD_START * 1000).toISOString());
    expect(payload.currentPeriodEnd).toBe(new Date(PERIOD_END * 1000).toISOString());
    expect(payload.cancelAtPeriodEnd).toBe(false);
    expect(payload.stripeEventCreatedAt).toBe(EVENT_CREATED);
    expect(payload.saleorChannelSlug).toBe("default-channel");
  });

  it("idempotent on existing cache record: still upserts with the new period (overwrite semantics)", async () => {
    const existing = new SubscriptionRecord({
      stripeSubscriptionId: createStripeSubscriptionId("sub_HAPPY"),
      stripeCustomerId: createStripeCustomerId("cus_HAPPY"),
      saleorChannelSlug: createSaleorChannelSlug("default-channel"),
      saleorUserId: "saleor_user_abc",
      fiefUserId: createFiefUserId("fief_user_123"),
      stripePriceId: createStripePriceId("price_old"),
      status: "active",
      currentPeriodStart: new Date(0),
      currentPeriodEnd: new Date(0),
      cancelAtPeriodEnd: false,
      createdAt: new Date(0),
      updatedAt: new Date(0),
    });

    const h = buildHarness({ existingRecord: existing });
    const sub = buildSubscription({
      id: "sub_HAPPY",
      customer: "cus_HAPPY",
      status: "active",
      priceId: "price_growth_monthly",
    });
    const event = buildEvent("customer.subscription.created", sub);

    const result = await h.handler.handleCreated(
      event as Stripe.CustomerSubscriptionCreatedEvent,
      buildContext(),
    );

    expect(result.isOk()).toBe(true);
    expect(h.subscriptionRepo.upsert).toHaveBeenCalledTimes(1);

    const record = h.subscriptionRepo.upsert.mock.calls[0][1] as SubscriptionRecord;

    /* New period overwrites old. */
    expect(record.currentPeriodStart.getTime()).toBe(PERIOD_START * 1000);
    expect(record.stripePriceId).toBe("price_growth_monthly");
  });

  it("returns Ok(NoOp) and does NOT upsert when fiefUserId metadata is missing", async () => {
    const h = buildHarness();
    const sub = buildSubscription({ fiefUserId: null });
    const event = buildEvent("customer.subscription.created", sub);

    const result = await h.handler.handleCreated(
      event as Stripe.CustomerSubscriptionCreatedEvent,
      buildContext(),
    );

    expect(result.isOk()).toBe(true);
    expect(h.subscriptionRepo.upsert).not.toHaveBeenCalled();
    expect(h.notifier.notify).not.toHaveBeenCalled();
  });

  it("returns Err when notifier fails (so Stripe will retry)", async () => {
    const h = buildHarness();

    h.notifier.notify.mockResolvedValue(err(new NotifyError.TransportError("simulated failure")));

    const sub = buildSubscription();
    const event = buildEvent("customer.subscription.created", sub);

    const result = await h.handler.handleCreated(
      event as Stripe.CustomerSubscriptionCreatedEvent,
      buildContext(),
    );

    expect(result.isErr()).toBe(true);
    expect(result._unsafeUnwrapErr()).toBeInstanceOf(BaseError);
  });

  it("returns Err when subscription repo upsert fails", async () => {
    const h = buildHarness();

    h.subscriptionRepo.upsert.mockResolvedValue(err(new BaseError("DDB blew up")));

    const sub = buildSubscription();
    const event = buildEvent("customer.subscription.created", sub);

    const result = await h.handler.handleCreated(
      event as Stripe.CustomerSubscriptionCreatedEvent,
      buildContext(),
    );

    expect(result.isErr()).toBe(true);
  });
});

/*
 * ---------------------------------------------------------------------------
 * handleUpdated — T15 (part 1)
 * ---------------------------------------------------------------------------
 */

describe("CustomerSubscriptionHandler.handleUpdated (T15)", () => {
  it("plan change: detects new price id and writes it to cache + payload", async () => {
    const existing = new SubscriptionRecord({
      stripeSubscriptionId: createStripeSubscriptionId("sub_PLAN"),
      stripeCustomerId: createStripeCustomerId("cus_PLAN"),
      saleorChannelSlug: createSaleorChannelSlug("default-channel"),
      saleorUserId: "saleor_user_abc",
      fiefUserId: createFiefUserId("fief_user_123"),
      stripePriceId: createStripePriceId("price_starter_monthly"),
      status: "active",
      currentPeriodStart: new Date(0),
      currentPeriodEnd: new Date(0),
      cancelAtPeriodEnd: false,
      createdAt: new Date(0),
      updatedAt: new Date(0),
    });

    const h = buildHarness({ existingRecord: existing });
    const sub = buildSubscription({
      id: "sub_PLAN",
      customer: "cus_PLAN",
      status: "active",
      priceId: "price_growth_monthly",
      periodStart: PERIOD_START + 100,
      periodEnd: PERIOD_END + 100,
    });
    const event = buildEvent("customer.subscription.updated", sub);

    const result = await h.handler.handleUpdated(
      event as Stripe.CustomerSubscriptionUpdatedEvent,
      buildContext(),
    );

    expect(result.isOk()).toBe(true);
    expect(h.subscriptionRepo.upsert).toHaveBeenCalledTimes(1);

    const record = h.subscriptionRepo.upsert.mock.calls[0][1] as SubscriptionRecord;

    expect(record.stripePriceId).toBe("price_growth_monthly");
    expect(record.currentPeriodStart.getTime()).toBe((PERIOD_START + 100) * 1000);
    expect(record.currentPeriodEnd.getTime()).toBe((PERIOD_END + 100) * 1000);

    const payload = h.notifier.notify.mock.calls[0][0] as OwlBooksWebhookPayload;

    expect(payload.type).toBe("subscription.updated");
    expect(payload.stripePriceId).toBe("price_growth_monthly");
    expect(payload.status).toBe("ACTIVE");
  });

  it("propagates cancel_at_period_end flag", async () => {
    const h = buildHarness();
    const sub = buildSubscription({ cancelAtPeriodEnd: true });
    const event = buildEvent("customer.subscription.updated", sub);

    const result = await h.handler.handleUpdated(
      event as Stripe.CustomerSubscriptionUpdatedEvent,
      buildContext(),
    );

    expect(result.isOk()).toBe(true);

    const record = h.subscriptionRepo.upsert.mock.calls[0][1] as SubscriptionRecord;
    const payload = h.notifier.notify.mock.calls[0][0] as OwlBooksWebhookPayload;

    expect(record.cancelAtPeriodEnd).toBe(true);
    expect(payload.cancelAtPeriodEnd).toBe(true);
  });

  it("returns Ok(NoOp) and does NOT upsert when fiefUserId metadata is missing", async () => {
    const h = buildHarness();
    const sub = buildSubscription({ fiefUserId: null });
    const event = buildEvent("customer.subscription.updated", sub);

    const result = await h.handler.handleUpdated(
      event as Stripe.CustomerSubscriptionUpdatedEvent,
      buildContext(),
    );

    expect(result.isOk()).toBe(true);
    expect(h.subscriptionRepo.upsert).not.toHaveBeenCalled();
    expect(h.notifier.notify).not.toHaveBeenCalled();
  });

  it("returns Err when notifier fails", async () => {
    const h = buildHarness();

    h.notifier.notify.mockResolvedValue(err(new NotifyError.TransportError("network down")));

    const sub = buildSubscription();
    const event = buildEvent("customer.subscription.updated", sub);

    const result = await h.handler.handleUpdated(
      event as Stripe.CustomerSubscriptionUpdatedEvent,
      buildContext(),
    );

    expect(result.isErr()).toBe(true);
  });
});

/*
 * ---------------------------------------------------------------------------
 * handleDeleted — T15 (part 2)
 * ---------------------------------------------------------------------------
 */

describe("CustomerSubscriptionHandler.handleDeleted (T15)", () => {
  it("sets local status to CANCELLED and preserves currentPeriodEnd", async () => {
    const h = buildHarness();
    const sub = buildSubscription({
      id: "sub_DEL",
      customer: "cus_DEL",
      status: "canceled",
      periodEnd: PERIOD_END,
    });
    const event = buildEvent("customer.subscription.deleted", sub);

    const result = await h.handler.handleDeleted(
      event as Stripe.CustomerSubscriptionDeletedEvent,
      buildContext(),
    );

    expect(result.isOk()).toBe(true);
    expect(h.subscriptionRepo.upsert).toHaveBeenCalledTimes(1);

    const record = h.subscriptionRepo.upsert.mock.calls[0][1] as SubscriptionRecord;

    /* Period end MUST be preserved so paidThrough stays in the future. */
    expect(record.currentPeriodEnd.getTime()).toBe(PERIOD_END * 1000);

    const payload = h.notifier.notify.mock.calls[0][0] as OwlBooksWebhookPayload;

    expect(payload.type).toBe("subscription.deleted");
    expect(payload.status).toBe("CANCELLED");
    expect(payload.currentPeriodEnd).toBe(new Date(PERIOD_END * 1000).toISOString());
  });

  it("returns Ok(NoOp) and does NOT upsert when fiefUserId metadata is missing", async () => {
    const h = buildHarness();
    const sub = buildSubscription({ fiefUserId: null });
    const event = buildEvent("customer.subscription.deleted", sub);

    const result = await h.handler.handleDeleted(
      event as Stripe.CustomerSubscriptionDeletedEvent,
      buildContext(),
    );

    expect(result.isOk()).toBe(true);
    expect(h.subscriptionRepo.upsert).not.toHaveBeenCalled();
    expect(h.notifier.notify).not.toHaveBeenCalled();
  });

  it("returns Err when notifier fails", async () => {
    const h = buildHarness();

    h.notifier.notify.mockResolvedValue(
      err(new NotifyError.NonSuccessResponseError("422 from OwlBooks")),
    );

    const sub = buildSubscription({ status: "canceled" });
    const event = buildEvent("customer.subscription.deleted", sub);

    const result = await h.handler.handleDeleted(
      event as Stripe.CustomerSubscriptionDeletedEvent,
      buildContext(),
    );

    expect(result.isErr()).toBe(true);
  });
});
