import { type APL } from "@saleor/app-sdk/APL";
import { FileAPL } from "@saleor/app-sdk/APL/file";
import { SaleorApp } from "@saleor/app-sdk/saleor-app";

import { MongoAPL } from "@/modules/apl/mongodb-apl";

import { env } from "./env";

/*
 * APL selection.
 *
 *   - `mongodb` (T3): production target. Uses the shared `MongoClient`
 *     singleton from `@/modules/db/mongo-client` so all Mongo-backed modules
 *     (T8 connection repo, T11 webhook log, T32 reconciliation runner)
 *     share one connection pool with the APL.
 *   - default / `file`: local dev — `FileAPL` writes a JSON file to the cwd.
 *   - `saleor-cloud` and `dynamodb` are reserved for other Saleor-platform
 *     deployments; they fall through to `FileAPL` for now since the canonical
 *     Fief-app deployment uses MongoDB.
 */
export let apl: APL;

switch (env.APL) {
  case "mongodb": {
    apl = new MongoAPL();
    break;
  }
  default: {
    apl = new FileAPL();
    break;
  }
}

export const saleorApp = new SaleorApp({
  apl,
});
