import { MongoClient, type MongoClientOptions } from "mongodb";

import { env } from "@/lib/env";
import { BaseError } from "@/lib/errors";

/*
 * T3 — Process-wide MongoClient singleton.
 *
 * Why a singleton:
 *   - The Node MongoDB driver maintains its own connection pool. Creating a
 *     new `MongoClient` per handler invocation in a long-running process
 *     leaks sockets; in a serverless environment it spawns a fresh pool per
 *     cold container, which is fine, but multiple modules within the same
 *     container (APL, repos, reconciliation runner — T8/T11/T32) must share
 *     one pool.
 *
 * Concurrency contract:
 *   - `getMongoClient()` MUST be safe under concurrent callers; the very
 *     first call creates the client and `.connect()`s it, every subsequent
 *     concurrent call awaits the same in-flight promise. We memoize the
 *     *promise*, not the resolved value, so racing callers don't double-
 *     connect (the bug pattern that "if (!client) connect()" gives you).
 *
 *   - After a successful close (e.g. via `closeMongoClient()` from a
 *     graceful-shutdown handler in T45), the singleton is cleared and the
 *     next caller transparently re-builds it. This makes the module both
 *     test-friendly (tests can `closeMongoClient()` between cases) and
 *     resilient to in-flight server restarts during long-lived processes.
 *
 * Errors are typed via `BaseError.subclass` so call sites can `match()`
 * without leaking driver-specific shapes.
 */

export const MongoClientError = BaseError.subclass("MongoClientError", {
  props: {
    _brand: "FiefApp.MongoClientError" as const,
  },
});

export const MongoClientConfigError = BaseError.subclass("MongoClientConfigError", {
  props: {
    _brand: "FiefApp.MongoClientConfigError" as const,
  },
});

let cachedClient: MongoClient | null = null;
let connectPromise: Promise<MongoClient> | null = null;

/*
 * Default driver options — tuned for serverless + long-lived process mix.
 *
 *   - `maxPoolSize: 10` — cap concurrent sockets per container. Aligns with
 *     the Stripe app default; for higher-throughput workloads (T32 scheduled
 *     reconciliation), this can be raised via env without touching the
 *     module.
 *
 *   - `serverSelectionTimeoutMS: 10_000` — fail fast on cold-start when the
 *     server is unreachable, instead of hanging the request for the driver's
 *     30-s default.
 *
 *   - `retryWrites: true` (driver default in v6) and `retryReads: true` are
 *     left as defaults to keep the surface minimal.
 */
const DEFAULT_OPTIONS: MongoClientOptions = {
  maxPoolSize: 10,
  serverSelectionTimeoutMS: 10_000,
};

const buildClient = async (): Promise<MongoClient> => {
  if (!env.MONGODB_URL) {
    throw new MongoClientConfigError(
      "MONGODB_URL is required when using the MongoDB-backed APL or repositories",
    );
  }

  try {
    const client = new MongoClient(env.MONGODB_URL, DEFAULT_OPTIONS);

    await client.connect();

    return client;
  } catch (cause) {
    throw new MongoClientError("Failed to connect to MongoDB", { cause });
  }
};

/**
 * Resolve the shared `MongoClient`. Lazily connects on first call; subsequent
 * concurrent or sequential callers within the same process share the pool.
 *
 * Idempotent — safe to invoke from any module that needs Mongo access.
 */
export const getMongoClient = async (): Promise<MongoClient> => {
  if (cachedClient) {
    return cachedClient;
  }

  /*
   * Memoize the *promise* (not just the resolved client). If two callers
   * race, the second sees `connectPromise` already set and awaits the same
   * in-flight `client.connect()` rather than triggering a second one.
   */
  if (!connectPromise) {
    connectPromise = buildClient()
      .then((client) => {
        cachedClient = client;

        return client;
      })
      .catch((error) => {
        /*
         * Clear so the *next* caller can retry from scratch instead of
         * permanently re-rejecting on the cached promise.
         */
        connectPromise = null;
        throw error;
      });
  }

  return connectPromise;
};

/**
 * Close the shared client and clear the singleton. Intended for:
 *
 *   - Test teardown (so each test boots its own pool against a fresh
 *     `mongodb-memory-server` URI).
 *   - Graceful shutdown wired up in T45 (SIGTERM handler).
 *
 * Safe to call when no client has been created — it's a no-op in that case.
 */
export const closeMongoClient = async (): Promise<void> => {
  const client = cachedClient;

  cachedClient = null;
  connectPromise = null;

  if (client) {
    try {
      await client.close();
    } catch (cause) {
      throw new MongoClientError("Failed to close MongoDB client", { cause });
    }
  }
};

/**
 * Return the resolved-database name. Defaults to `saleor_app_fief` when
 * `MONGODB_DATABASE` is unset — operators in production are expected to set
 * the env var explicitly per environment (dev / staging / prod isolation).
 */
export const getMongoDatabaseName = (): string => env.MONGODB_DATABASE ?? "saleor_app_fief";
