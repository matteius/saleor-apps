import { APL } from "@saleor/app-sdk/APL";
import { FileAPL } from "@saleor/app-sdk/APL/file";
import { SaleorCloudAPL } from "@saleor/app-sdk/APL/saleor-cloud";
import { SaleorApp } from "@saleor/app-sdk/saleor-app";

import { env } from "./env";
import { BaseError } from "./errors";
import { MongoAPL } from "./mongodb-apl";

export let apl: APL;

const MisconfiguredAPLError = BaseError.subclass("MisconfiguredAPLError");

switch (env.APL) {
  case "mongodb": {
    if (!env.MONGODB_URL) {
      throw new MisconfiguredAPLError("MongoDB APL is not configured - missing MONGODB_URL env variable");
    }

    apl = new MongoAPL();
    break;
  }

  case "saleor-cloud": {
    if (!env.REST_APL_ENDPOINT || !env.REST_APL_TOKEN) {
      throw new MisconfiguredAPLError(
        "Saleor Cloud APL is not configured - missing REST_APL_ENDPOINT or REST_APL_TOKEN",
      );
    }

    apl = new SaleorCloudAPL({
      resourceUrl: env.REST_APL_ENDPOINT,
      token: env.REST_APL_TOKEN,
    });

    break;
  }

  case "file":
  default:
    apl = new FileAPL({
      fileName: env.FILE_APL_PATH,
    });

    break;
}

export const saleorApp = new SaleorApp({
  apl,
});

