/**
 * Server-side tRPC factory for `saleor-app-fief` (T33).
 *
 * Mirrors `apps/stripe/src/modules/trpc/trpc-server.ts`. The single Fief
 * deviation is the `requiredClientPermissions` default — Stripe needs
 * `HANDLE_PAYMENTS` plus the shared baseline; the Fief app only needs the
 * baseline `MANAGE_APPS` because configuration changes are app-level (the
 * higher-privilege `MANAGE_USERS` is a *server-to-server* permission used
 * by the app's own GraphQL calls, not by dashboard users browsing the
 * config UI).
 */
import { type Permission } from "@saleor/app-sdk/types";
import { REQUIRED_SALEOR_PERMISSIONS } from "@saleor/apps-shared/permissions";
import { initTRPC } from "@trpc/server";

import { type TrpcContextAppRouter } from "@/modules/trpc/context-app-router";

interface Meta {
  requiredClientPermissions: Permission[];
}

const t = initTRPC
  .context<TrpcContextAppRouter>()
  .meta<Meta>()
  .create({
    defaultMeta: {
      requiredClientPermissions: REQUIRED_SALEOR_PERMISSIONS,
    },
  });

export const router = t.router;
export const procedure = t.procedure;
export const middleware = t.middleware;
