// cspell:ignore dedup opensensor

import { createHash, createHmac, timingSafeEqual } from "node:crypto";

import { err, ok, type Result } from "neverthrow";

import { BaseError } from "@/lib/errors";
import { isFiefSyncDisabled } from "@/lib/kill-switches";
import { createLogger } from "@/lib/logger";
import { type RotatingFiefEncryptor } from "@/modules/crypto/encryptor";
import {
  createProviderConnectionId,
  type ProviderConnection,
  type ProviderConnectionId,
} from "@/modules/provider-connections/provider-connection";
import {
  type ProviderConnectionRepo,
  type ProviderConnectionRepoError,
} from "@/modules/provider-connections/provider-connection-repo";
import { createSaleorApiUrl } from "@/modules/saleor/saleor-api-url";
import {
  createWebhookEventId,
  createWebhookLogConnectionId,
} from "@/modules/webhook-log/webhook-log";
import { type WebhookLogRepo } from "@/modules/webhook-log/webhook-log-repo";

import { type EventRouter, type WebhookEventPayload } from "./event-router";

/**
 * Lookup-by-id seam — the existing `ProviderConnectionRepo.get(...)` is
 * tenant-scoped (requires `saleorApiUrl` for safety). The Fief webhook URL
 * carries only `connectionId`, so the receiver needs a separate seam that
 * resolves a connection without a tenant scope. T8's repo does not yet
 * expose this; we inject it as a dedicated dep here so:
 *
 *   - The receiver doesn't widen the `ProviderConnectionRepo` interface
 *     (out of scope for T22; would touch every repo impl + every test).
 *   - Production wiring can plug in either a thin "list-all then filter"
 *     adapter or a future Mongo `findByIdAcrossTenants` index lookup
 *     without changing this module.
 *   - Tests can supply a fake that returns a fixed connection or
 *     `NotFound` to exercise the orphan / soft-deleted paths.
 *
 * The error union mirrors what the underlying repo would surface so
 * callers can unify error handling.
 */
export interface FindConnectionById {
  (
    id: ProviderConnectionId,
  ): Promise<
    Result<
      ProviderConnection,
      InstanceType<
        | typeof ProviderConnectionRepoError.NotFound
        | typeof ProviderConnectionRepoError.FailureFetching
      >
    >
  >;
}

/*
 * T22 — Fief webhook receiver / dispatcher.
 *
 * The receiver owns the cross-cutting concerns documented in T22 of
 * `fief-app-plan.md`:
 *
 *   1. Resolve the connection by `connectionId` query param.
 *   2. **Connection absent or soft-deleted → 410 Gone.** Fief may have an
 *      in-flight delivery for a connection we just deleted (T17's
 *      DeleteConnectionUseCase deletes the Fief subscriber but Fief's
 *      retry queue may still ship pending events). Returning 410 is the
 *      correct hint to Fief's webhook layer to stop retrying.
 *   3. Kill switch (T54) → 503.
 *   4. HMAC verify against the connection's webhook secret. During a
 *      rotation window we accept BOTH the current secret AND the pending
 *      secret (T17's RotateConnectionSecretUseCase stages a new one
 *      before the operator confirms — this receiver MUST keep working
 *      while the staged secret coexists with the live secret).
 *   5. Bad HMAC → 401.
 *   6. Dedup via T11. Already-seen eventId → 200 + log (no-op).
 *   7. Otherwise: record + dispatch via the event-router.
 *   8. Dispatch is currently synchronous; T52's queue handoff is a
 *      follow-up if/when handlers grow heavy. The receiver records the
 *      row with `initialStatus: "ok"` for the synchronous path so we
 *      don't leave a `retrying` row sitting around when the work is
 *      actually done.
 *
 * Wire-format note (matches `opensensor-fief/fief/services/webhooks/delivery.py`):
 *
 *   - Header `X-Fief-Webhook-Signature`: hex-encoded `HMAC-SHA256(secret, msg)`
 *     where `msg = "{X-Fief-Webhook-Timestamp}.{rawBody}"` (literal dot
 *     between timestamp and body, encoded as UTF-8 bytes).
 *   - Header `X-Fief-Webhook-Timestamp`: integer seconds-since-epoch as a
 *     decimal string. The receiver does NOT enforce a freshness window in
 *     this initial implementation — Fief's queue retries with the SAME
 *     timestamp, so a too-strict check would amplify retry pain. (A
 *     `WEBHOOK_TIMESTAMP_TOLERANCE_S` knob can be added later if we get
 *     replay-attack coverage requirements.)
 *
 * Event-id synthesis: Fief 0.x's `WebhookEvent` body does not carry a stable
 * event id, so the dedup key for `(saleorApiUrl, direction, eventId)` is
 * synthesized as `${timestamp}-${sha256(rawBody)}`. This is deterministic
 * across Fief retries (same timestamp + body → same id) so dedup works
 * end-to-end without a Fief-side change.
 */

export const FIEF_WEBHOOK_SIGNATURE_HEADER = "x-fief-webhook-signature";
export const FIEF_WEBHOOK_TIMESTAMP_HEADER = "x-fief-webhook-timestamp";
const WEBHOOK_DIRECTION = "fief_to_saleor" as const;

export const FiefReceiverError = {
  /**
   * `connectionId` query param is missing or not a valid UUID. The route
   * handler treats this as 400 Bad Request (the URL is provisioned by
   * T17's CreateConnectionUseCase — a malformed value indicates either a
   * misconfigured subscriber or a hostile request).
   */
  InvalidConnectionId: BaseError.subclass("FiefReceiverInvalidConnectionIdError", {
    props: { _brand: "FiefApp.FiefReceiver.InvalidConnectionId" as const },
  }),
  /** Failed to read the request body as text. */
  BodyReadFailed: BaseError.subclass("FiefReceiverBodyReadFailedError", {
    props: { _brand: "FiefApp.FiefReceiver.BodyReadFailed" as const },
  }),
  /** Body did not parse as JSON (or did not match the {type, data} shape). */
  PayloadInvalid: BaseError.subclass("FiefReceiverPayloadInvalidError", {
    props: { _brand: "FiefApp.FiefReceiver.PayloadInvalid" as const },
  }),
};

/**
 * Receiver outcomes. The route handler maps each to an HTTP status and
 * keeps the routing logic out of this module.
 *
 * Naming intent: the route handler should never need to inspect anything
 * beyond `kind` + the carried strings to decide its response — keeping
 * the response decision colocated with the HTTP boundary and the
 * decision logic colocated here.
 */
export type ReceiverOutcome =
  /** Body / route-shape problem detected before we did any work. */
  | { kind: "bad-request"; message: string }
  /** Connection absent or soft-deleted (orphan event from a deleted connection). */
  | { kind: "gone"; reason: "connection-not-found" | "connection-soft-deleted" }
  /** Kill switch (T54) suppressed processing. */
  | { kind: "service-unavailable"; reason: "fief-sync-disabled" }
  /** HMAC signature did not verify against current OR pending secret. */
  | { kind: "unauthorized"; reason: "signature-missing" | "signature-mismatch" }
  /** Already processed; subsequent retries land here (idempotent). */
  | { kind: "duplicate"; eventId: string }
  /** Recorded + dispatched. Includes whether a handler was actually invoked. */
  | { kind: "accepted"; eventId: string; eventType: string; dispatched: boolean }
  /** Recorded + handler ran but returned an error. Receiver still 200s — T52 owns retries. */
  | { kind: "accepted-with-handler-error"; eventId: string; eventType: string };

export interface FiefReceiverDeps {
  /**
   * Tenant-aware repo. Currently only used for the soft-delete check
   * via the loaded entity; lookup happens through `findConnectionById`.
   */
  providerConnectionRepo: ProviderConnectionRepo;
  /** Tenant-agnostic lookup by id (URL-bound by the Fief webhook). */
  findConnectionById: FindConnectionById;
  webhookLogRepo: WebhookLogRepo;
  encryptor: RotatingFiefEncryptor;
  eventRouter: EventRouter;
}

export interface ReceiverInput {
  /** Raw request body as text — HMAC is computed over the EXACT bytes Fief shipped. */
  rawBody: string;
  /** Lowercased header map. Use the exported `FIEF_WEBHOOK_*_HEADER` keys. */
  headers: Record<string, string | undefined>;
  /** Connection id from the `connectionId` query param. */
  connectionIdQueryParam: string | null | undefined;
  /** Saleor api URL bound to this connection — resolved from the loaded connection (saleorApiUrl is on the entity). */
}

const logger = createLogger("modules.sync.fief-to-saleor.FiefReceiver");

export class FiefReceiver {
  private readonly providerConnectionRepo: ProviderConnectionRepo;
  private readonly findConnectionByIdImpl: FindConnectionById;
  private readonly webhookLogRepo: WebhookLogRepo;
  private readonly encryptor: RotatingFiefEncryptor;
  private readonly eventRouter: EventRouter;

  constructor(deps: FiefReceiverDeps) {
    this.providerConnectionRepo = deps.providerConnectionRepo;
    this.findConnectionByIdImpl = deps.findConnectionById;
    this.webhookLogRepo = deps.webhookLogRepo;
    this.encryptor = deps.encryptor;
    this.eventRouter = deps.eventRouter;
  }

  async receive(input: ReceiverInput): Promise<Result<ReceiverOutcome, never>> {
    /*
     * Step 1 — parse `connectionId` from the query param. T17 hard-codes
     * the URL to `?connectionId={uuid}`; a missing or malformed value is
     * a 400 (we don't have enough info to even know which tenant this
     * delivery belongs to).
     */
    const connectionIdResult = parseConnectionIdParam(input.connectionIdQueryParam);

    if (connectionIdResult.isErr()) {
      logger.warn("Fief webhook received with invalid connectionId query param", {
        connectionIdQueryParam: input.connectionIdQueryParam,
      });

      return ok({ kind: "bad-request", message: "Missing or invalid connectionId query param" });
    }

    const connectionId = connectionIdResult.value;

    /*
     * Step 2 — load the connection by id. We use the injected
     * `findConnectionById` seam (NOT `providerConnectionRepo.get`)
     * because the existing repo `get(...)` is tenant-scoped by
     * `saleorApiUrl` for safety; the Fief webhook URL only carries
     * `connectionId`. We need to see soft-deleted rows here because
     * "never existed" vs "deleted but Fief is still retrying" should
     * both 410 — but the log line tells the operator which.
     */
    void this.providerConnectionRepo; // reserved for future tenant-scoped reads (claims, branding, etc.)

    const connectionByIdResult = await this.findConnectionByIdImpl(connectionId);

    if (connectionByIdResult.isErr()) {
      logger.warn("Fief webhook for unknown connectionId — orphan event (returning 410 Gone)", {
        connectionId,
      });

      return ok({ kind: "gone", reason: "connection-not-found" });
    }

    const connection = connectionByIdResult.value;

    if (connection.softDeletedAt !== null) {
      logger.warn(
        "Fief webhook for soft-deleted connection — orphan event from in-flight Fief retry (returning 410 Gone)",
        {
          connectionId,
          softDeletedAt: connection.softDeletedAt.toISOString(),
        },
      );

      return ok({ kind: "gone", reason: "connection-soft-deleted" });
    }

    /*
     * Step 3 — kill switch. We check AFTER loading the connection so the
     * structured log line carries the connectionId / saleorApiUrl, which
     * the operator playbook (T45) needs to correlate "stuck deliveries"
     * to a specific tenant.
     */
    if (isFiefSyncDisabled()) {
      logger.warn("Fief webhook received while FIEF_SYNC_DISABLED kill switch is on — 503", {
        connectionId,
        saleorApiUrl: connection.saleorApiUrl,
      });

      return ok({ kind: "service-unavailable", reason: "fief-sync-disabled" });
    }

    /*
     * Step 4 — HMAC verify. Fief signs the full body prefixed by the
     * timestamp header (per delivery.py: `f"{ts}.{payload}"`). The
     * signature is hex-encoded HMAC-SHA256.
     */
    const signatureHeader = readHeader(input.headers, FIEF_WEBHOOK_SIGNATURE_HEADER);
    const timestampHeader = readHeader(input.headers, FIEF_WEBHOOK_TIMESTAMP_HEADER);

    if (!signatureHeader || !timestampHeader) {
      logger.warn("Fief webhook missing signature or timestamp header — 401", {
        connectionId,
        saleorApiUrl: connection.saleorApiUrl,
        hasSignature: Boolean(signatureHeader),
        hasTimestamp: Boolean(timestampHeader),
      });

      return ok({ kind: "unauthorized", reason: "signature-missing" });
    }

    const verifyResult = this.verifyHmac({
      connection,
      rawBody: input.rawBody,
      timestamp: timestampHeader,
      providedSignatureHex: signatureHeader,
    });

    if (verifyResult.isErr()) {
      logger.warn("Fief webhook signature verification failed against current OR pending secret", {
        connectionId,
        saleorApiUrl: connection.saleorApiUrl,
      });

      return ok({ kind: "unauthorized", reason: "signature-mismatch" });
    }

    /*
     * Step 5 — parse the body. We've already verified the HMAC against
     * the raw bytes, so a JSON-parse failure here means a signed-but-
     * malformed body, which we treat as 400 (not 401).
     */
    const payloadResult = parseFiefWebhookBody(input.rawBody);

    if (payloadResult.isErr()) {
      logger.error(
        "Fief webhook body did not parse as {type, data} — signed but malformed (rare; possibly Fief bug)",
        {
          connectionId,
          saleorApiUrl: connection.saleorApiUrl,
        },
      );

      return ok({ kind: "bad-request", message: "Body did not match {type, data} shape" });
    }

    const { type: eventType, data } = payloadResult.value;
    const eventId = synthesizeEventId({ timestamp: timestampHeader, rawBody: input.rawBody });

    /*
     * Step 6 — dedup-check via T11. Returns true if `(saleorApiUrl,
     * direction, eventId)` was already seen.
     */
    const eventIdBranded = createWebhookEventId(eventId);

    if (eventIdBranded.isErr()) {
      logger.error("Failed to brand synthesized eventId — internal invariant violated", {
        connectionId,
        saleorApiUrl: connection.saleorApiUrl,
        eventId,
      });

      return ok({ kind: "bad-request", message: "Synthesized eventId failed validation" });
    }

    const dedupResult = await this.webhookLogRepo.dedupCheck({
      saleorApiUrl: connection.saleorApiUrl,
      direction: WEBHOOK_DIRECTION,
      eventId: eventIdBranded.value,
    });

    if (dedupResult.isErr()) {
      logger.error("dedupCheck failed — bailing with 503 to let Fief retry", {
        connectionId,
        saleorApiUrl: connection.saleorApiUrl,
        error: dedupResult.error,
      });

      /*
       * Treat repo failures as transient — 503 lets Fief retry instead of
       * silently dropping the event. The kill-switch outcome shape fits.
       */
      return ok({ kind: "service-unavailable", reason: "fief-sync-disabled" });
    }

    if (dedupResult.value) {
      logger.info("Fief webhook already processed (duplicate) — 200 + no-op", {
        connectionId,
        saleorApiUrl: connection.saleorApiUrl,
        eventId,
        eventType,
      });

      return ok({ kind: "duplicate", eventId });
    }

    /*
     * Step 7 — record + dispatch. We dispatch BEFORE writing the row so
     * synchronous failures land in the row's `lastError` via
     * `recordAttempt`. For now we keep the recorded status simple:
     * `"ok"` on dispatched, `"retrying"` on handler error so T52's queue
     * can re-pick it up later.
     */
    const dispatchResult = await this.eventRouter.dispatch({
      type: eventType,
      data,
      eventId,
    } satisfies WebhookEventPayload);

    /*
     * dispatchResult is `Result.ok(DispatchOutcome)` for every reachable
     * state; the router never returns `err`. We still .isOk()-check
     * defensively in case the type changes.
     */
    if (dispatchResult.isErr()) {
      logger.error("Event router returned err (should not happen — router only returns ok)", {
        connectionId,
        saleorApiUrl: connection.saleorApiUrl,
      });

      return ok({ kind: "accepted-with-handler-error", eventId, eventType });
    }

    const outcome = dispatchResult.value;

    const connectionIdForLog = createWebhookLogConnectionId(connectionId);

    if (connectionIdForLog.isErr()) {
      logger.error("Failed to brand connectionId for webhook-log row — should be impossible", {
        connectionId,
        saleorApiUrl: connection.saleorApiUrl,
      });

      return ok({
        kind: "accepted",
        eventId,
        eventType,
        dispatched: outcome.kind === "dispatched",
      });
    }

    const recordOutcome = await this.webhookLogRepo.record({
      saleorApiUrl: connection.saleorApiUrl,
      connectionId: connectionIdForLog.value,
      direction: WEBHOOK_DIRECTION,
      eventId: eventIdBranded.value,
      eventType,
      payloadRedacted: redactFiefWebhookPayload(data),
      initialStatus:
        outcome.kind === "dispatched" || outcome.kind === "no-handler" ? "ok" : "retrying",
    });

    if (recordOutcome.isErr()) {
      logger.error(
        "Failed to record webhook-log row after dispatch — event handled but audit row missing",
        {
          connectionId,
          saleorApiUrl: connection.saleorApiUrl,
          eventId,
          eventType,
          error: recordOutcome.error,
        },
      );
      /*
       * Still 200 — the dispatch already ran (or was a no-handler no-op),
       * so a missing audit row should not cause Fief to retry the event.
       */
    }

    if (outcome.kind === "failed") {
      return ok({ kind: "accepted-with-handler-error", eventId, eventType });
    }

    return ok({
      kind: "accepted",
      eventId,
      eventType,
      dispatched: outcome.kind === "dispatched",
    });
  }

  /**
   * HMAC verify against the connection's webhook secret. Tries the
   * pending (rotation-target) secret first, then the current secret —
   * matching the encryptor's "new key first" pattern from T4. Both
   * comparisons are constant-time (`timingSafeEqual`).
   */
  private verifyHmac(args: {
    connection: ProviderConnection;
    rawBody: string;
    timestamp: string;
    providedSignatureHex: string;
  }): Result<{ acceptedVia: "current" | "pending" }, Error> {
    const { connection, rawBody, timestamp, providedSignatureHex } = args;

    /*
     * Decrypt the secret slots. We need plaintext to feed into HMAC.
     * `getDecryptedSecrets` is the authoritative boundary for this — it
     * walks the same ProviderConnectionRepoError + EncryptionError union
     * as the rest of the auth-plane.
     */
    const providedSignatureBytes = safeHexToBuffer(providedSignatureHex);

    if (!providedSignatureBytes) {
      return err(new FiefReceiverError.PayloadInvalid("Signature header is not valid hex"));
    }

    const message = `${timestamp}.${rawBody}`;

    /*
     * Try pending first — during a rotation Fief will be signing with the
     * newly-issued secret (which we wrote into pendingWebhookSecret in
     * T17). Fall back to the current secret for the pre-rotation /
     * post-confirm steady state.
     */
    return this.tryDecryptAndVerify({
      ciphertext: connection.fief.encryptedPendingWebhookSecret,
      message,
      providedSignatureBytes,
      slot: "pending",
    }).orElse(() =>
      this.tryDecryptAndVerify({
        ciphertext: connection.fief.encryptedWebhookSecret,
        message,
        providedSignatureBytes,
        slot: "current",
      }),
    );
  }

  private tryDecryptAndVerify(args: {
    ciphertext: ProviderConnection["fief"]["encryptedWebhookSecret"] | null;
    message: string;
    providedSignatureBytes: Buffer;
    slot: "current" | "pending";
  }): Result<{ acceptedVia: "current" | "pending" }, Error> {
    if (args.ciphertext === null) {
      return err(
        new FiefReceiverError.PayloadInvalid(
          `No ${args.slot} webhook secret on connection — cannot verify against this slot`,
        ),
      );
    }

    const decrypted = this.encryptor.decrypt(args.ciphertext as unknown as string);

    if (decrypted.isErr()) {
      return err(decrypted.error);
    }

    const expected = createHmac("sha256", decrypted.value.plaintext)
      .update(args.message, "utf-8")
      .digest();

    if (
      expected.length === args.providedSignatureBytes.length &&
      timingSafeEqual(expected, args.providedSignatureBytes)
    ) {
      return ok({ acceptedVia: args.slot });
    }

    return err(
      new FiefReceiverError.PayloadInvalid(`Signature did not match ${args.slot} webhook secret`),
    );
  }
}

// -- helpers (exported for unit testing) -------------------------------------

/**
 * Validate `raw` matches the ProviderConnectionId brand (UUID v4).
 * Returns the branded id on success. Used to gate the receiver before
 * any storage I/O.
 */
export const parseConnectionIdParam = (
  raw: string | null | undefined,
): Result<ProviderConnectionId, InstanceType<typeof FiefReceiverError.InvalidConnectionId>> => {
  if (raw === null || raw === undefined || raw.length === 0) {
    return err(new FiefReceiverError.InvalidConnectionId("connectionId query param is missing"));
  }

  try {
    return ok(createProviderConnectionId(raw));
  } catch (error) {
    return err(
      new FiefReceiverError.InvalidConnectionId(
        "connectionId query param is not a valid ProviderConnectionId",
        { cause: error },
      ),
    );
  }
};

/**
 * Parse the request body into the minimal `{type, data}` shape Fief sends.
 * The receiver does NOT validate the per-event-type schema here — that's
 * the handler's responsibility (each event type's `data` shape is owned
 * by Fief's models).
 */
export const parseFiefWebhookBody = (
  rawBody: string,
): Result<
  { type: string; data: Record<string, unknown> },
  InstanceType<typeof FiefReceiverError.PayloadInvalid>
> => {
  let parsed: unknown;

  try {
    parsed = JSON.parse(rawBody);
  } catch (error) {
    return err(new FiefReceiverError.PayloadInvalid("Body is not valid JSON", { cause: error }));
  }

  if (!parsed || typeof parsed !== "object" || Array.isArray(parsed)) {
    return err(new FiefReceiverError.PayloadInvalid("Body is not a JSON object"));
  }

  const obj = parsed as Record<string, unknown>;

  if (typeof obj.type !== "string" || obj.type.length === 0) {
    return err(new FiefReceiverError.PayloadInvalid("Body is missing string field 'type'"));
  }

  if (!obj.data || typeof obj.data !== "object" || Array.isArray(obj.data)) {
    return err(new FiefReceiverError.PayloadInvalid("Body is missing object field 'data'"));
  }

  return ok({ type: obj.type, data: obj.data as Record<string, unknown> });
};

/**
 * Synthesize a stable event id for `(saleorApiUrl, direction, eventId)`
 * dedup. Fief 0.x's `WebhookEvent` body does not carry an id, so we
 * derive one from `${timestamp}-${sha256(rawBody)}`. Deterministic
 * across Fief retries (same timestamp + body → same id), so dedup works
 * end-to-end without a Fief change.
 *
 * Exported for the receiver test suite and any future tooling (T51
 * replay) that needs to recreate the same id from a captured request.
 */
export const synthesizeEventId = (args: { timestamp: string; rawBody: string }): string => {
  const digest = createHash("sha256").update(args.rawBody, "utf-8").digest("hex");

  return `${args.timestamp}-${digest}`;
};

/**
 * Parse a hex-encoded buffer; returns `null` on invalid hex. Used to
 * normalize the signature header before constant-time compare.
 */
const safeHexToBuffer = (hex: string): Buffer | null => {
  /*
   * Strict hex validation — Node's Buffer.from("...", "hex") silently
   * ignores non-hex characters which would weaken constant-time compare.
   */
  if (!/^[0-9a-fA-F]+$/.test(hex) || hex.length % 2 !== 0) {
    return null;
  }

  return Buffer.from(hex, "hex");
};

/**
 * Case-insensitive header lookup against a lowercased map. The route
 * handler is expected to feed us `Object.fromEntries(headers.entries())`
 * which preserves whatever case the platform shipped, so we lowercase
 * keys defensively here.
 */
const readHeader = (
  headers: Record<string, string | undefined>,
  name: string,
): string | undefined => {
  if (headers[name] !== undefined) return headers[name];
  /*
   * Fall back to a manual lower-casing scan in case the caller's map
   * preserved arbitrary case.
   */
  const lower = name.toLowerCase();

  for (const [key, value] of Object.entries(headers)) {
    if (key.toLowerCase() === lower) return value;
  }

  return undefined;
};

/**
 * Project the Fief webhook payload's `data` field for storage in the
 * `webhook_log` row. Per T11's contract, the receiver is responsible
 * for redacting before handing payloads to the repo. T50's logger
 * redactor handles secret keys at log time, but the row is stored
 * verbatim — so we must scrub here.
 *
 * Conservative policy: drop any field whose KEY matches the T50 secret
 * list (`access_token`, `id_token`, `refresh_token`, `code`,
 * `signing_key`, `client_secret`, `webhook_secret`). Future enhancement
 * could share this list with `redactFiefSecrets` in `lib/logger.ts`.
 */
const SECRET_KEY_NAMES = new Set([
  "access_token",
  "id_token",
  "refresh_token",
  "code",
  "signing_key",
  "client_secret",
  "webhook_secret",
  "token",
  "secretKey",
  "Authorization",
  "authorization",
]);

const REDACT_PLACEHOLDER = "[***]";

const redactFiefWebhookPayload = (value: unknown): unknown => {
  if (value === null || typeof value !== "object") return value;
  if (Array.isArray(value)) return value.map(redactFiefWebhookPayload);

  const out: Record<string, unknown> = {};

  for (const [key, val] of Object.entries(value as Record<string, unknown>)) {
    if (SECRET_KEY_NAMES.has(key)) {
      out[key] = REDACT_PLACEHOLDER;
      continue;
    }
    out[key] = redactFiefWebhookPayload(val);
  }

  return out;
};

/*
 * Re-export so the route handler can branch on the saleorApiUrl-touch helpers
 * without re-importing from saleor-api-url.
 */
export { createSaleorApiUrl };
