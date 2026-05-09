import { err, ok, type Result } from "neverthrow";
import type { z } from "zod";

import {
  type AnyFiefAdminApiError,
  FiefAdminApiClientError,
  FiefAdminApiError,
  FiefAdminApiNetworkError,
  FiefAdminApiNotFoundError,
  FiefAdminApiRateLimitError,
  FiefAdminApiSchemaError,
  FiefAdminApiServerError,
  FiefAdminApiTimeoutError,
  FiefAdminApiUnauthorizedError,
} from "./admin-api-errors";
import {
  type FiefAdminToken,
  type FiefBaseUrl,
  type FiefClient,
  type FiefClientCreateInput,
  FiefClientCreateInputSchema,
  type FiefClientId,
  FiefClientSchema,
  type FiefClientUpdateInput,
  FiefClientUpdateInputSchema,
  type FiefPaginationParams,
  FiefPaginationParamsSchema,
  type FiefUser,
  type FiefUserCreateInput,
  FiefUserCreateInputSchema,
  type FiefUserId,
  FiefUserSchema,
  type FiefUserUpdateInput,
  FiefUserUpdateInputSchema,
  type FiefWebhook,
  type FiefWebhookCreateInput,
  FiefWebhookCreateInputSchema,
  type FiefWebhookId,
  FiefWebhookSchema,
  type FiefWebhookUpdateInput,
  FiefWebhookUpdateInputSchema,
  type FiefWebhookWithSecret,
  FiefWebhookWithSecretSchema,
  PaginatedResultsSchema,
} from "./admin-api-types";

/*
 * T5 — typed wrapper over the Fief admin REST API.
 *
 * Endpoints covered (paths from `upstream Fief/fief/apps/api/routers/`):
 *
 *   clients.py
 *     POST   /admin/api/clients/             -> createClient
 *     GET    /admin/api/clients/{id}         -> getClient
 *     PATCH  /admin/api/clients/{id}         -> updateClient
 *     DELETE /admin/api/clients/{id}         -> deleteClient
 *
 *   webhooks.py
 *     POST   /admin/api/webhooks/            -> createWebhook   (returns secret)
 *     GET    /admin/api/webhooks/{id}        -> getWebhook
 *     PATCH  /admin/api/webhooks/{id}        -> updateWebhook
 *     POST   /admin/api/webhooks/{id}/secret -> rotateWebhookSecret
 *     DELETE /admin/api/webhooks/{id}        -> deleteWebhook
 *
 *   users.py
 *     GET    /admin/api/users/               -> listUsers / iterateUsers
 *     GET    /admin/api/users/{id}           -> getUser
 *     PATCH  /admin/api/users/{id}           -> updateUser
 *     POST   /admin/api/users/               -> createUser
 *
 * Design choices:
 *
 *   - `Result<T, FiefAdminApiError>` everywhere. We never throw across the
 *     module boundary except inside async iterators (where the only sensible
 *     way to surface a failed page is `throw`, since `for-await` consumers
 *     can't `Result`-handle).
 *
 *   - Token is injected per-call. The caller (T17 use cases) holds the
 *     decrypted admin token in memory and passes it in. This client never
 *     touches `env` for credentials, which keeps it composable with rotation.
 *
 *   - Bounded retry on 429 / 5xx. Default 3 attempts with jittered exponential
 *     backoff. `respectRetryAfter` honors a `Retry-After` header (seconds).
 *
 *   - Zod parsing happens after the network response — schema mismatches map
 *     to `FiefAdminApiSchemaError` so PRD R6 (schema drift) is observable.
 *
 *   - No new HTTP-client dep. We use Node 20+'s built-in `fetch`.
 */

// ---------- Config ----------

export interface FiefAdminApiRetryConfig {
  /** Total attempts including the first try. Default 3. */
  maxAttempts: number;
  /** Initial backoff in ms (before jitter). Default 250. */
  initialDelayMs: number;
  /** Max backoff in ms. Default 4000. */
  maxDelayMs: number;
}

export interface FiefAdminApiClientConfig {
  baseUrl: FiefBaseUrl;
  retry?: Partial<FiefAdminApiRetryConfig>;
  /** Per-request timeout in ms. Default 15_000. */
  timeoutMs?: number;
  /**
   * Injectable for tests / non-Node runtimes. Defaults to global `fetch`.
   */
  fetchImpl?: typeof fetch;
}

const DEFAULT_RETRY: FiefAdminApiRetryConfig = {
  maxAttempts: 3,
  initialDelayMs: 250,
  maxDelayMs: 4_000,
};

const DEFAULT_TIMEOUT_MS = 15_000;

// ---------- Internal helpers ----------

const sleep = (ms: number) => new Promise<void>((resolve) => setTimeout(resolve, ms));

/* Jittered exponential backoff, capped at `maxDelayMs`. */
const computeBackoff = (
  attempt: number,
  retry: FiefAdminApiRetryConfig,
  retryAfterSeconds: number | null,
): number => {
  if (retryAfterSeconds !== null && Number.isFinite(retryAfterSeconds) && retryAfterSeconds >= 0) {
    return Math.min(retryAfterSeconds * 1_000, retry.maxDelayMs);
  }
  const exp = Math.min(retry.initialDelayMs * 2 ** (attempt - 1), retry.maxDelayMs);

  /* Full jitter — keeps thundering herds from re-converging. */
  return Math.floor(Math.random() * exp);
};

const parseRetryAfter = (raw: string | null): number | null => {
  if (raw === null || raw.length === 0) return null;
  const asNumber = Number(raw);

  return Number.isFinite(asNumber) ? asNumber : null;
};

interface ParsedFiefError {
  detail: string | null;
}

const safeParseErrorBody = async (response: Response): Promise<ParsedFiefError> => {
  try {
    const text = await response.text();

    if (text.length === 0) return { detail: null };
    const parsed: unknown = JSON.parse(text);

    if (
      typeof parsed === "object" &&
      parsed !== null &&
      "detail" in parsed &&
      typeof (parsed as { detail: unknown }).detail === "string"
    ) {
      return { detail: (parsed as { detail: string }).detail };
    }

    return { detail: text };
  } catch {
    return { detail: null };
  }
};

const buildHttpError = (args: {
  response: Response;
  parsed: ParsedFiefError;
  url: string;
  method: string;
}): AnyFiefAdminApiError => {
  const { response, parsed, url, method } = args;
  const baseMessage = `Fief admin API ${method} ${url} failed with HTTP ${response.status}`;

  if (response.status === 401 || response.status === 403) {
    return new FiefAdminApiUnauthorizedError(baseMessage, {
      props: { statusCode: response.status, detail: parsed.detail },
    });
  }
  if (response.status === 404) {
    return new FiefAdminApiNotFoundError(baseMessage, {
      props: { statusCode: response.status, detail: parsed.detail },
    });
  }
  if (response.status === 429) {
    return new FiefAdminApiRateLimitError(baseMessage, {
      props: { statusCode: response.status, detail: parsed.detail },
    });
  }
  if (response.status >= 500 && response.status <= 599) {
    return new FiefAdminApiServerError(baseMessage, {
      props: { statusCode: response.status, detail: parsed.detail },
    });
  }

  return new FiefAdminApiClientError(baseMessage, {
    props: { statusCode: response.status, detail: parsed.detail },
  });
};

const isRetryableStatus = (status: number): boolean =>
  status === 429 || (status >= 500 && status <= 599);

// ---------- Client ----------

export class FiefAdminApiClient {
  private readonly baseUrl: string;

  private readonly retry: FiefAdminApiRetryConfig;

  private readonly timeoutMs: number;

  private readonly fetchImpl: typeof fetch;

  private constructor(config: FiefAdminApiClientConfig) {
    /*
     * Strip trailing slash so route concat is predictable. We always mount
     * paths that begin with `/admin/api/...`.
     */
    this.baseUrl = (config.baseUrl as string).replace(/\/+$/, "");
    this.retry = { ...DEFAULT_RETRY, ...config.retry };
    this.timeoutMs = config.timeoutMs ?? DEFAULT_TIMEOUT_MS;
    this.fetchImpl = config.fetchImpl ?? fetch;
  }

  static create(config: FiefAdminApiClientConfig): FiefAdminApiClient {
    return new FiefAdminApiClient(config);
  }

  // ---------- Generic request ----------

  private async request<TSchema extends z.ZodTypeAny>(args: {
    method: "GET" | "POST" | "PATCH" | "DELETE";
    path: string;
    token: FiefAdminToken;
    /* `null` means "expect 204 / empty body and return undefined". */
    schema: TSchema | null;
    body?: unknown;
    query?: Record<string, string>;
  }): Promise<Result<TSchema extends null ? undefined : z.infer<TSchema>, AnyFiefAdminApiError>> {
    const queryString = args.query ? `?${new URLSearchParams(args.query).toString()}` : "";
    const url = `${this.baseUrl}${args.path}${queryString}`;

    let lastErr: AnyFiefAdminApiError | null = null;

    for (let attempt = 1; attempt <= this.retry.maxAttempts; attempt += 1) {
      const ac = new AbortController();
      const timeoutHandle = setTimeout(() => ac.abort(), this.timeoutMs);
      let response: Response;

      try {
        response = await this.fetchImpl(url, {
          method: args.method,
          headers: {
            Authorization: `Bearer ${args.token as unknown as string}`,
            ...(args.body !== undefined ? { "Content-Type": "application/json" } : {}),
            Accept: "application/json",
          },
          body: args.body !== undefined ? JSON.stringify(args.body) : undefined,
          signal: ac.signal,
        });
      } catch (error) {
        clearTimeout(timeoutHandle);
        const isAbort =
          (typeof DOMException !== "undefined" &&
            error instanceof DOMException &&
            error.name === "AbortError") ||
          (error instanceof Error && error.name === "AbortError");
        const wrapped = isAbort
          ? new FiefAdminApiTimeoutError(
              `Fief admin API ${args.method} ${url} timed out after ${this.timeoutMs}ms`,
              { cause: error },
            )
          : new FiefAdminApiNetworkError(`Fief admin API ${args.method} ${url} network error`, {
              cause: error,
            });

        lastErr = wrapped;
        /* Network/timeout errors are retried like 5xx. */
        if (attempt < this.retry.maxAttempts) {
          await sleep(computeBackoff(attempt, this.retry, null));
          continue;
        }

        return err(wrapped);
      }
      clearTimeout(timeoutHandle);

      if (response.ok) {
        if (args.schema === null) {
          return ok(undefined as never);
        }
        let json: unknown;

        try {
          /*
           * 204s slip through `ok` checks if the caller asked for a body
           * (we treat that as a schema mismatch).
           */
          if (response.status === 204) {
            json = undefined;
          } else {
            const text = await response.text();

            json = text.length === 0 ? undefined : JSON.parse(text);
          }
        } catch (parseErr) {
          return err(
            new FiefAdminApiSchemaError(
              `Fief admin API ${args.method} ${url} returned non-JSON body`,
              { cause: parseErr },
            ),
          );
        }
        const result = args.schema.safeParse(json);

        if (!result.success) {
          return err(
            new FiefAdminApiSchemaError(
              `Fief admin API ${args.method} ${url} returned a body that did not match the expected schema`,
              { cause: result.error },
            ),
          );
        }

        return ok(result.data as never);
      }

      const parsed = await safeParseErrorBody(response);
      const httpErr = buildHttpError({ response, parsed, url, method: args.method });

      lastErr = httpErr;

      if (isRetryableStatus(response.status) && attempt < this.retry.maxAttempts) {
        const retryAfter = parseRetryAfter(response.headers.get("Retry-After"));

        await sleep(computeBackoff(attempt, this.retry, retryAfter));
        continue;
      }

      return err(httpErr);
    }

    /*
     * Unreachable in practice — the loop returns on every branch — but TS
     * needs a final return path. If we get here, surface the last seen error.
     */
    return err(
      lastErr ??
        new FiefAdminApiError(
          `Fief admin API ${args.method} ${url} exhausted retries with no recorded error`,
        ),
    );
  }

  // ---------- Clients ----------

  async createClient(
    token: FiefAdminToken,
    input: FiefClientCreateInput,
  ): Promise<Result<FiefClient, AnyFiefAdminApiError>> {
    const body = FiefClientCreateInputSchema.parse(input);

    return this.request({
      method: "POST",
      path: "/admin/api/clients/",
      token,
      schema: FiefClientSchema,
      body,
    });
  }

  async getClient(
    token: FiefAdminToken,
    id: FiefClientId,
  ): Promise<Result<FiefClient, AnyFiefAdminApiError>> {
    return this.request({
      method: "GET",
      path: `/admin/api/clients/${id as unknown as string}`,
      token,
      schema: FiefClientSchema,
    });
  }

  async updateClient(
    token: FiefAdminToken,
    id: FiefClientId,
    input: FiefClientUpdateInput,
  ): Promise<Result<FiefClient, AnyFiefAdminApiError>> {
    const body = FiefClientUpdateInputSchema.parse(input);

    return this.request({
      method: "PATCH",
      path: `/admin/api/clients/${id as unknown as string}`,
      token,
      schema: FiefClientSchema,
      body,
    });
  }

  async deleteClient(
    token: FiefAdminToken,
    id: FiefClientId,
  ): Promise<Result<undefined, AnyFiefAdminApiError>> {
    return this.request({
      method: "DELETE",
      path: `/admin/api/clients/${id as unknown as string}`,
      token,
      schema: null,
    });
  }

  // ---------- Webhooks ----------

  async createWebhook(
    token: FiefAdminToken,
    input: FiefWebhookCreateInput,
  ): Promise<Result<FiefWebhookWithSecret, AnyFiefAdminApiError>> {
    const body = FiefWebhookCreateInputSchema.parse(input);

    return this.request({
      method: "POST",
      path: "/admin/api/webhooks/",
      token,
      schema: FiefWebhookWithSecretSchema,
      body,
    });
  }

  async getWebhook(
    token: FiefAdminToken,
    id: FiefWebhookId,
  ): Promise<Result<FiefWebhook, AnyFiefAdminApiError>> {
    return this.request({
      method: "GET",
      path: `/admin/api/webhooks/${id as unknown as string}`,
      token,
      schema: FiefWebhookSchema,
    });
  }

  async updateWebhook(
    token: FiefAdminToken,
    id: FiefWebhookId,
    input: FiefWebhookUpdateInput,
  ): Promise<Result<FiefWebhook, AnyFiefAdminApiError>> {
    const body = FiefWebhookUpdateInputSchema.parse(input);

    return this.request({
      method: "PATCH",
      path: `/admin/api/webhooks/${id as unknown as string}`,
      token,
      schema: FiefWebhookSchema,
      body,
    });
  }

  async rotateWebhookSecret(
    token: FiefAdminToken,
    id: FiefWebhookId,
  ): Promise<Result<FiefWebhookWithSecret, AnyFiefAdminApiError>> {
    return this.request({
      method: "POST",
      path: `/admin/api/webhooks/${id as unknown as string}/secret`,
      token,
      schema: FiefWebhookWithSecretSchema,
    });
  }

  async deleteWebhook(
    token: FiefAdminToken,
    id: FiefWebhookId,
  ): Promise<Result<undefined, AnyFiefAdminApiError>> {
    return this.request({
      method: "DELETE",
      path: `/admin/api/webhooks/${id as unknown as string}`,
      token,
      schema: null,
    });
  }

  // ---------- Users ----------

  async getUser(
    token: FiefAdminToken,
    id: FiefUserId,
  ): Promise<Result<FiefUser, AnyFiefAdminApiError>> {
    return this.request({
      method: "GET",
      path: `/admin/api/users/${id as unknown as string}`,
      token,
      schema: FiefUserSchema,
    });
  }

  async updateUser(
    token: FiefAdminToken,
    id: FiefUserId,
    input: FiefUserUpdateInput,
  ): Promise<Result<FiefUser, AnyFiefAdminApiError>> {
    const body = FiefUserUpdateInputSchema.parse(input);

    return this.request({
      method: "PATCH",
      path: `/admin/api/users/${id as unknown as string}`,
      token,
      schema: FiefUserSchema,
      body,
    });
  }

  /*
   * Admin-side create. Required by T26 (saleor-customer-created -> create
   * Fief user with email + claim-derived fields). FIXME: verify the create
   * endpoint accepts a `password` field for "password-less" Fief tenants —
   * we may need to send a strong random placeholder per the Fief docs.
   */
  async createUser(
    token: FiefAdminToken,
    input: FiefUserCreateInput,
  ): Promise<Result<FiefUser, AnyFiefAdminApiError>> {
    const body = FiefUserCreateInputSchema.parse(input);

    return this.request({
      method: "POST",
      path: "/admin/api/users/",
      token,
      schema: FiefUserSchema,
      body,
    });
  }

  /* Single page list — primarily a building block for `iterateUsers`. */
  async listUsers(
    token: FiefAdminToken,
    params: FiefPaginationParams = {},
  ): Promise<Result<{ count: number; results: FiefUser[] }, AnyFiefAdminApiError>> {
    const validated = FiefPaginationParamsSchema.parse(params);
    const query = paginationToQuery(validated);

    return this.request({
      method: "GET",
      path: "/admin/api/users/",
      token,
      schema: PaginatedResultsSchema(FiefUserSchema),
      query,
    });
  }

  /*
   * Async-iterator that walks every page until the upstream is exhausted.
   *
   * Termination conditions (either suffices):
   *   1. server returns fewer rows than `limit` (last page, possibly empty).
   *   2. cumulative `seen` >= server-reported `count`.
   *
   * On an error page, the iterator throws — `for-await` consumers should
   * wrap the loop in try/catch (T30 reconciliation does this).
   */
  async *iterateUsers(
    token: FiefAdminToken,
    params: Omit<FiefPaginationParams, "skip"> = {},
  ): AsyncIterable<FiefUser> {
    const limit = params.limit ?? 50;
    let skip = 0;
    let total: number | null = null;
    let seen = 0;

    /* Bound the walk; protects against a buggy upstream returning forever. */
    const HARD_PAGE_CAP = 10_000;
    let safety = 0;

    while (true) {
      safety += 1;
      if (safety > HARD_PAGE_CAP) {
        throw new FiefAdminApiError(
          `iterateUsers exceeded ${HARD_PAGE_CAP} pages — refusing to walk further`,
        );
      }

      const result = await this.listUsers(token, { ...params, limit, skip });

      if (result.isErr()) {
        throw result.error;
      }

      const { count, results } = result.value;

      if (total === null) total = count;

      for (const user of results) {
        yield user;
        seen += 1;
      }

      if (results.length < limit) return;
      if (seen >= total) return;
      skip += limit;
    }
  }
}

// ---------- Helpers ----------

const paginationToQuery = (params: FiefPaginationParams): Record<string, string> => {
  const query: Record<string, string> = {};

  if (params.limit !== undefined) query.limit = String(params.limit);
  if (params.skip !== undefined) query.skip = String(params.skip);
  if (params.ordering !== undefined) query.ordering = params.ordering;
  if (params.extra !== undefined) {
    for (const [k, v] of Object.entries(params.extra)) {
      query[k] = String(v);
    }
  }

  return query;
};
