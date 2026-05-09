import { type APL } from "@saleor/app-sdk/APL";
import { FileAPL } from "@saleor/app-sdk/APL/file";
import { SaleorApp } from "@saleor/app-sdk/saleor-app";

import { env } from "./env";

/*
 * APL selection. The mongodb branch is wired in T3 (alongside the Mongo
 * client singleton). saleor-cloud and dynamodb branches are reserved for
 * future deployment targets; for now they fall through to FileAPL with a
 * warning written by the env layer.
 */
export let apl: APL;

switch (env.APL) {
  case "mongodb": {
    /*
     * T3 will replace this fallback with `new MongoAPL()`. Until then we
     * fall through to FileAPL so local boot still works without a Mongo
     * connection.
     */
    apl = new FileAPL();
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
