import { type CreateConnectionError } from "./create-connection.use-case";
import { type DeleteConnectionError } from "./delete-connection.use-case";
import { type RotateConnectionSecretError } from "./rotate-connection-secret.use-case";
import { type UpdateConnectionError } from "./update-connection.use-case";

/*
 * T17 — shared types for the connection-lifecycle use cases.
 *
 * Kept in a leaf module so the use cases can import each other's error types
 * without an import cycle.
 */

/**
 * Bootstrap fields each lifecycle use case needs to talk to Fief.
 *
 * Modeled as plaintext — every persisted variant is encrypted at the repo
 * boundary (T8 + T4); this type is the input contract.
 */
export interface FiefAdminBootstrapInput {
  baseUrl: string;
  tenantId: string;
  /** Plaintext admin bearer used for `FiefAdminApiClient` calls. */
  adminToken: string;
}

/**
 * Subset of Fief webhook events the app subscribes to by default. We accept
 * a broader `string[]` at the input boundary so operators can opt into
 * additional event types via T36 without a code change.
 */
export type FiefWebhookEventList = string[];

/**
 * Union of every typed error any of the four lifecycle use cases can return.
 * Surfaced from the tRPC router (T34) without further narrowing.
 */
export type ProviderConnectionLifecycleError =
  | CreateConnectionError
  | UpdateConnectionError
  | RotateConnectionSecretError
  | DeleteConnectionError;
