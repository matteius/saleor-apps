import { randomBytes } from "node:crypto";

import { err, ok, type Result } from "neverthrow";

import { BaseError } from "@/lib/errors";
import { createLogger } from "@/lib/logger";
import { type FiefAdminApiClient } from "@/modules/fief-client/admin-api-client";
import { FiefAdminTokenSchema } from "@/modules/fief-client/admin-api-types";
import { type SaleorApiUrl } from "@/modules/saleor/saleor-api-url";

import { type ProviderConnection, type ProviderConnectionId } from "../provider-connection";
import { type ProviderConnectionRepo } from "../provider-connection-repo";
import { type ProviderConnectionLifecycleError } from "./types";

/*
 * T17 — `RotateConnectionSecretUseCase`.
 *
 * Two-step rotation for BOTH the OIDC client secret AND the Fief webhook
 * signing secret. The two-step shape exists so the operator can verify the
 * new secret reaches Fief (or reaches the webhook subscriber) before the old
 * one is decommissioned. During the rotation window the auth plane (T6's
 * `FiefOidcClient`) accepts both `current` and `pending` client secrets in
 * a single call (`secrets: [current, pending]`); the inbound webhook receiver
 * (T22) verifies the HMAC against either the current or the pending webhook
 * secret. After `confirmRotation`, the pending slot is promoted to current
 * and the old secret is dropped.
 *
 * Key implementation notes
 * ------------------------
 *
 * **Webhook secret** — Fief 0.x exposes `POST /admin/api/webhooks/{id}/secret`
 * which generates a new secret on the Fief side AND switches Fief over to
 * signing with it immediately. We capture that returned secret as the new
 * `pending` slot. Fief's behavior makes the rollover effectively atomic on
 * Fief's side; the dual-secret window in our app exists to ride out events
 * minted just before the rollover (Fief signs with old, our store still has
 * old in `current`).
 *
 * **OIDC client secret** — Fief 0.x does NOT expose a secret-rotation
 * endpoint for OIDC clients (`apps/api/routers/clients.py` only has create /
 * get / patch / delete + the encryption-key sub-route). Two paths are
 * possible and this use case supports BOTH via the `clientSecretSource`
 * input:
 *
 *   - `"operator-supplied"` (default): the operator rotates the secret in
 *     Fief out-of-band (currently the only way; Fief admin UI / DB), then
 *     hands the new value to us via the input. We store it as `pending`.
 *     During the rotation window T6 sends `[current, pending]` so requests
 *     succeed regardless of which secret Fief currently accepts. Once the
 *     operator confirms, we drop `current`. THIS IS THE ONLY MODE THAT
 *     ACTUALLY ROLLS THE SECRET ON FIEF'S SIDE; the next mode is wiring-
 *     verification only.
 *
 *   - `"locally-generated"`: the use case mints a strong random secret and
 *     stores it as `pending` without touching Fief. Useful when the operator
 *     wants to test the rotation plumbing OR when paired with a future T5
 *     extension that adds a Fief-side rotation endpoint.
 *
 * Surface this distinction loudly to the caller: the input is required, no
 * sensible default exists.
 */

const PENDING_CLIENT_SECRET_BYTES = 32;
const PENDING_WEBHOOK_SECRET_BYTES = 32;

export const RotateConnectionSecretError = {
  NotFound: BaseError.subclass("RotateConnectionSecretNotFoundError", {
    props: { _brand: "FiefApp.RotateConnectionSecret.NotFound" as const },
  }),
  AlreadyRotating: BaseError.subclass("RotateConnectionSecretAlreadyRotatingError", {
    props: { _brand: "FiefApp.RotateConnectionSecret.AlreadyRotating" as const },
  }),
  NoPendingRotation: BaseError.subclass("RotateConnectionSecretNoPendingRotationError", {
    props: { _brand: "FiefApp.RotateConnectionSecret.NoPendingRotation" as const },
  }),
  FiefSyncFailed: BaseError.subclass("RotateConnectionSecretFiefSyncFailedError", {
    props: { _brand: "FiefApp.RotateConnectionSecret.FiefSyncFailed" as const },
  }),
  PersistFailed: BaseError.subclass("RotateConnectionSecretPersistFailedError", {
    props: { _brand: "FiefApp.RotateConnectionSecret.PersistFailed" as const },
  }),
  InvalidInput: BaseError.subclass("RotateConnectionSecretInvalidInputError", {
    props: { _brand: "FiefApp.RotateConnectionSecret.InvalidInput" as const },
  }),
};

export type RotateConnectionSecretError =
  | InstanceType<(typeof RotateConnectionSecretError)["NotFound"]>
  | InstanceType<(typeof RotateConnectionSecretError)["AlreadyRotating"]>
  | InstanceType<(typeof RotateConnectionSecretError)["NoPendingRotation"]>
  | InstanceType<(typeof RotateConnectionSecretError)["FiefSyncFailed"]>
  | InstanceType<(typeof RotateConnectionSecretError)["PersistFailed"]>
  | InstanceType<(typeof RotateConnectionSecretError)["InvalidInput"]>;

export type ClientSecretSource =
  | {
      mode: "operator-supplied";
      /** Plaintext new client secret already configured on the Fief side. */
      newClientSecret: string;
    }
  | {
      mode: "locally-generated";
    };

export interface InitiateRotationInput {
  saleorApiUrl: SaleorApiUrl;
  id: ProviderConnectionId;
  clientSecretSource: ClientSecretSource;
}

export interface ConfirmRotationInput {
  saleorApiUrl: SaleorApiUrl;
  id: ProviderConnectionId;
}

export interface CancelRotationInput {
  saleorApiUrl: SaleorApiUrl;
  id: ProviderConnectionId;
}

export interface RotateConnectionSecretUseCaseDeps {
  repo: ProviderConnectionRepo;
  fiefAdmin: FiefAdminApiClient;
  /** Test seam — defaults to `node:crypto.randomBytes`. */
  randomBytesImpl?: (n: number) => Buffer;
}

/**
 * Result returned from `initiateRotation` so callers can show the new
 * webhook secret in the operator UI (one-time display only — the same
 * secret is also persisted as `encryptedPendingWebhookSecret`).
 */
export interface InitiateRotationResult {
  connection: ProviderConnection;
  /**
   * Plaintext webhook secret newly issued by Fief. Operators see this once
   * in the UI so they can verify Fief delivered events still validate.
   */
  newWebhookSecretPlaintext: string;
}

export class RotateConnectionSecretUseCase {
  private readonly repo: ProviderConnectionRepo;
  private readonly fiefAdmin: FiefAdminApiClient;
  private readonly randomBytesImpl: (n: number) => Buffer;
  private readonly logger = createLogger("provider-connections.rotate-connection-secret");

  constructor(deps: RotateConnectionSecretUseCaseDeps) {
    this.repo = deps.repo;
    this.fiefAdmin = deps.fiefAdmin;
    this.randomBytesImpl = deps.randomBytesImpl ?? ((n) => randomBytes(n));
  }

  async initiateRotation(
    input: InitiateRotationInput,
  ): Promise<Result<InitiateRotationResult, ProviderConnectionLifecycleError>> {
    const existing = await this.loadConnection(input.saleorApiUrl, input.id);

    if (existing.isErr()) return err(existing.error);
    const connection = existing.value;

    /*
     * Disallow stacking two rotations — operators must `confirmRotation`
     * (or explicitly cancel; not modeled yet) before kicking off a new one.
     * Without this guard the dual-secret window can encompass three secrets
     * which T6 / T22 are not built to handle.
     */
    if (
      connection.fief.encryptedPendingClientSecret !== null ||
      connection.fief.encryptedPendingWebhookSecret !== null
    ) {
      return err(
        new RotateConnectionSecretError.AlreadyRotating(
          "A rotation is already in progress; confirm it before starting another",
        ),
      );
    }

    const decryptedSecrets = await this.repo.getDecryptedSecrets({
      saleorApiUrl: input.saleorApiUrl,
      id: input.id,
    });

    if (decryptedSecrets.isErr()) {
      return err(
        new RotateConnectionSecretError.PersistFailed(
          "Failed to decrypt admin token while initiating rotation",
          { cause: decryptedSecrets.error },
        ),
      );
    }

    const adminToken = FiefAdminTokenSchema.parse(decryptedSecrets.value.fief.adminToken);

    /*
     * Step A — rotate the webhook signing secret on Fief. Fief generates +
     * persists the new secret atomically; we capture and stash as `pending`.
     *
     * `webhookId` is nullable on the connection schema for back-compat with
     * legacy connections that pre-date T17. If absent we fall back to a
     * locally-generated webhook secret so the rotation plumbing exercises
     * end-to-end without forcing a data backfill — the operator can supply
     * the matching value to Fief's webhook subscriber separately.
     */
    let newWebhookSecretPlaintext: string;
    let newPendingWebhookSecretToStore: string;

    if (connection.fief.webhookId !== null) {
      const rotateResult = await this.fiefAdmin.rotateWebhookSecret(
        adminToken,
        connection.fief.webhookId,
      );

      if (rotateResult.isErr()) {
        this.logger.error("Failed to rotate Fief webhook secret", {
          connectionId: input.id,
          error: rotateResult.error,
        });

        return err(
          new RotateConnectionSecretError.FiefSyncFailed(
            "Failed to rotate Fief webhook signing secret",
            { cause: rotateResult.error },
          ),
        );
      }

      newWebhookSecretPlaintext = rotateResult.value.secret;
      newPendingWebhookSecretToStore = rotateResult.value.secret;
    } else {
      this.logger.warn(
        "Connection has no Fief webhookId; rotating webhook secret locally only — operator must reconcile Fief side",
        { connectionId: input.id },
      );
      newWebhookSecretPlaintext = this.randomBytesImpl(PENDING_WEBHOOK_SECRET_BYTES).toString(
        "hex",
      );
      newPendingWebhookSecretToStore = newWebhookSecretPlaintext;
    }

    /*
     * Step B — derive the new pending OIDC client secret per the requested
     * source mode.
     */
    let newPendingClientSecretToStore: string;

    if (input.clientSecretSource.mode === "operator-supplied") {
      if (input.clientSecretSource.newClientSecret.length === 0) {
        return err(
          new RotateConnectionSecretError.InvalidInput(
            "operator-supplied client secret rotation requires a non-empty newClientSecret",
          ),
        );
      }
      newPendingClientSecretToStore = input.clientSecretSource.newClientSecret;
    } else {
      newPendingClientSecretToStore = this.randomBytesImpl(PENDING_CLIENT_SECRET_BYTES).toString(
        "hex",
      );
    }

    /*
     * Step C — persist the pending slots. The repo encrypts before write.
     */
    const persisted = await this.repo.update(
      { saleorApiUrl: input.saleorApiUrl, id: input.id },
      {
        fief: {
          pendingClientSecret: newPendingClientSecretToStore,
          pendingWebhookSecret: newPendingWebhookSecretToStore,
        },
      },
    );

    if (persisted.isErr()) {
      this.logger.error(
        "Failed to persist pending rotation secrets — Fief may have already rolled the webhook secret; consider re-rotating",
        { connectionId: input.id, error: persisted.error },
      );

      return err(
        new RotateConnectionSecretError.PersistFailed(
          "Failed to persist pending rotation secrets",
          { cause: persisted.error },
        ),
      );
    }

    return ok({
      connection: persisted.value,
      newWebhookSecretPlaintext,
    });
  }

  async confirmRotation(
    input: ConfirmRotationInput,
  ): Promise<Result<ProviderConnection, ProviderConnectionLifecycleError>> {
    const existing = await this.loadConnection(input.saleorApiUrl, input.id);

    if (existing.isErr()) return err(existing.error);
    const connection = existing.value;

    if (
      connection.fief.encryptedPendingClientSecret === null &&
      connection.fief.encryptedPendingWebhookSecret === null
    ) {
      return err(
        new RotateConnectionSecretError.NoPendingRotation(
          "No pending rotation to confirm; call initiateRotation first",
        ),
      );
    }

    const decryptedSecrets = await this.repo.getDecryptedSecrets({
      saleorApiUrl: input.saleorApiUrl,
      id: input.id,
    });

    if (decryptedSecrets.isErr()) {
      return err(
        new RotateConnectionSecretError.PersistFailed(
          "Failed to decrypt secrets while confirming rotation",
          { cause: decryptedSecrets.error },
        ),
      );
    }

    const { fief } = decryptedSecrets.value;

    /*
     * Promote pending → current. We pass plaintext values; the repo
     * re-encrypts. Pending slots are explicitly cleared with `null`.
     */
    const promoted = await this.repo.update(
      { saleorApiUrl: input.saleorApiUrl, id: input.id },
      {
        fief: {
          ...(fief.pendingClientSecret !== null
            ? {
                clientSecret: fief.pendingClientSecret,
                pendingClientSecret: null,
              }
            : {}),
          ...(fief.pendingWebhookSecret !== null
            ? {
                webhookSecret: fief.pendingWebhookSecret,
                pendingWebhookSecret: null,
              }
            : {}),
        },
      },
    );

    if (promoted.isErr()) {
      return err(
        new RotateConnectionSecretError.PersistFailed(
          "Failed to promote pending secrets to current",
          { cause: promoted.error },
        ),
      );
    }

    /*
     * Fief side: there's no "delete old client_secret" operation in Fief
     * 0.x — once Fief switches to the new secret (operator-side update for
     * the OIDC client) the old one is automatically invalidated. The
     * webhook secret was rolled atomically by Fief during initiateRotation.
     * We log the promotion for audit + return.
     */
    this.logger.info("Confirmed connection secret rotation", {
      connectionId: input.id,
      saleorApiUrl: input.saleorApiUrl,
    });

    return ok(promoted.value);
  }

  /**
   * Abort an in-flight rotation: drop both pending slots so the connection
   * is back at its pre-`initiateRotation` shape (only `current` secrets
   * present). Use this when the operator decides the rotation was a mistake
   * — e.g. they pasted the wrong `newClientSecret` or Fief never delivered
   * a webhook signed with the new secret so they want to back out before
   * confirming.
   *
   * Best-effort revoke caveat: Fief 0.x exposes no client-secret
   * "un-rotate" operation, and `initiateRotation` for `clientSecretSource`
   * never actually wrote anything to Fief in the first place
   * (operator-supplied means the operator did the Fief-side roll out-of-band;
   * locally-generated stays purely local). For the webhook secret, Fief
   * atomically rolled it during `initiateRotation` — we cannot un-roll it.
   * We therefore just drop the pending slots; if a follow-up T5 endpoint
   * lands a "revert webhook secret" route we can wire it here, and any
   * error path stays log-only so a partial-revoke never blocks the local
   * state cleanup.
   *
   * Returns `NoPendingRotation` when called outside an open rotation — the
   * tRPC layer maps this to `CONFLICT` so the UI can render an honest
   * message instead of showing a "cancelled" toast over no-op state.
   */
  async cancelRotation(
    input: CancelRotationInput,
  ): Promise<Result<ProviderConnection, ProviderConnectionLifecycleError>> {
    const existing = await this.loadConnection(input.saleorApiUrl, input.id);

    if (existing.isErr()) return err(existing.error);
    const connection = existing.value;

    if (
      connection.fief.encryptedPendingClientSecret === null &&
      connection.fief.encryptedPendingWebhookSecret === null
    ) {
      return err(
        new RotateConnectionSecretError.NoPendingRotation(
          "No pending rotation to cancel; call initiateRotation first",
        ),
      );
    }

    /*
     * Best-effort Fief-side cleanup. Wrapped in try/catch so any upstream
     * error gets logged but never propagates — the local state cleanup
     * MUST run even if Fief is unreachable, otherwise the operator gets
     * stuck unable to either confirm or cancel.
     *
     * Today this is a no-op (see method docstring) but the seam exists so
     * a future T5 extension can plug in without re-shaping callers.
     */
    try {
      this.logger.info("Cancelling rotation; dropping pending slots", {
        connectionId: input.id,
        hadPendingClientSecret: connection.fief.encryptedPendingClientSecret !== null,
        hadPendingWebhookSecret: connection.fief.encryptedPendingWebhookSecret !== null,
      });
    } catch (cause) {
      this.logger.warn("Best-effort Fief revoke during cancelRotation failed; continuing", {
        connectionId: input.id,
        error: cause,
      });
    }

    /*
     * Drop the pending slots. We pass `null` per `ProviderConnectionUpdateInput`'s
     * convention for explicit clear. Repo re-encrypts nothing here because
     * neither slot is being assigned a new plaintext.
     */
    const reverted = await this.repo.update(
      { saleorApiUrl: input.saleorApiUrl, id: input.id },
      {
        fief: {
          pendingClientSecret: null,
          pendingWebhookSecret: null,
        },
      },
    );

    if (reverted.isErr()) {
      return err(
        new RotateConnectionSecretError.PersistFailed(
          "Failed to clear pending rotation slots while cancelling",
          { cause: reverted.error },
        ),
      );
    }

    this.logger.info("Cancelled connection secret rotation", {
      connectionId: input.id,
      saleorApiUrl: input.saleorApiUrl,
    });

    return ok(reverted.value);
  }

  private async loadConnection(
    saleorApiUrl: SaleorApiUrl,
    id: ProviderConnectionId,
  ): Promise<Result<ProviderConnection, ProviderConnectionLifecycleError>> {
    const result = await this.repo.get({ saleorApiUrl, id });

    if (result.isOk()) return ok(result.value);
    const cause = result.error;

    if (cause.constructor.name === "ProviderConnectionNotFoundError") {
      return err(
        new RotateConnectionSecretError.NotFound(
          `provider_connection ${id} not found for ${saleorApiUrl}`,
          { cause },
        ),
      );
    }

    return err(
      new RotateConnectionSecretError.PersistFailed(
        "Failed to load provider_connection during rotation",
        { cause },
      ),
    );
  }
}
